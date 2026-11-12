use crate::http::{self, HttpError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tokio::sync::Mutex;

#[derive(Clone, Serialize)]
pub struct Account {
    pub label: String,
    pub workspace: String,
}

#[derive(Clone)]
pub struct Credentials {
    pub access_token: String,
    pub account_id: String,
    pub key: String,
    pub account: Account,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<f64>,
    pub used_percent: f64,
    pub remaining_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_in_seconds: Option<i64>,
    pub observed_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub available: bool,
    pub is_refreshing: bool,
    pub can_refresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    pub auth_path: String,
    pub rate_limits: Vec<RateLimitWindow>,
    pub rate_limit_source: String,
    pub source_host: String,
    pub issues: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub official_issue: Option<String>,
}

impl UsageSnapshot {
    pub fn empty(path: &std::path::Path) -> Self {
        Self {
            available: false,
            is_refreshing: false,
            can_refresh: true,
            generated_at: None,
            last_success_at: None,
            account: None,
            auth_path: path.to_string_lossy().into_owned(),
            rate_limits: Vec::new(),
            rate_limit_source: "none".into(),
            source_host: "chatgpt.com".into(),
            issues: Vec::new(),
            official_issue: None,
        }
    }

    pub fn primary(&self) -> Option<&RateLimitWindow> {
        self.rate_limits
            .iter()
            .find(|window| window.window_minutes == Some(300.0) || window.label == "5h")
            .or_else(|| {
                self.rate_limits
                    .iter()
                    .find(|window| window.window_minutes == Some(10080.0) || window.label == "7d")
            })
            .or_else(|| self.rate_limits.first())
    }
}

struct Cached {
    key: String,
    snapshot: UsageSnapshot,
    saved_at: i64,
}

pub struct QuotaService {
    pub auth_path: PathBuf,
    cached: Mutex<Option<Cached>>,
}

impl QuotaService {
    pub fn new(home: PathBuf) -> Result<Self, String> {
        let directory = if let Some(value) =
            std::env::var_os("CODEX_HOME").filter(|v| !v.to_string_lossy().trim().is_empty())
        {
            let value = value.to_string_lossy().trim().to_owned();
            if value == "~" {
                home
            } else if value.starts_with("~/") || value.starts_with("~\\") {
                home.join(&value[2..])
            } else {
                let directory = PathBuf::from(value);
                if directory.is_absolute() {
                    directory
                } else {
                    std::env::current_dir()
                        .map_err(|_| "无法解析 CODEX_HOME / Could not resolve CODEX_HOME")?
                        .join(directory)
                }
            }
        } else {
            home.join(".codex")
        };
        Ok(Self {
            auth_path: directory.join("auth.json"),
            cached: Mutex::new(None),
        })
    }

    pub fn fingerprint(&self) -> Option<String> {
        fs::read(&self.auth_path)
            .ok()
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
    }

    pub fn credentials(&self) -> Result<Credentials, String> {
        let bytes = fs::read(&self.auth_path)
            .map_err(|_| "无法读取 Codex auth.json，请检查登录状态和凭据路径")?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Codex auth.json 格式无效，请检查登录状态")?;
        credentials(&value)
    }

    pub async fn clear(&self) {
        *self.cached.lock().await = None;
    }

    pub async fn collect(&self, lookup: Result<Credentials, String>) -> UsageSnapshot {
        let mut base = UsageSnapshot::empty(&self.auth_path);
        base.generated_at = Some(iso(Utc::now().timestamp_millis()));
        let credentials = match lookup {
            Ok(value) => value,
            Err(issue) => {
                self.clear().await;
                base.official_issue = Some(issue.clone());
                base.issues.push(issue);
                return base;
            }
        };
        base.account = Some(credentials.account.clone());
        {
            let mut cache = self.cached.lock().await;
            if cache
                .as_ref()
                .is_some_and(|entry| entry.key != credentials.key)
            {
                *cache = None;
            }
        }
        let mut windows = None;
        let mut issue = None;
        for attempt in 0..2 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if !self.credentials().is_ok_and(|latest| {
                    latest.key == credentials.key && latest.access_token == credentials.access_token
                }) {
                    issue = Some("登录信息已变化，已取消重试，等待重新同步".to_owned());
                    break;
                }
            }
            match request(&credentials).await {
                Ok(body) => {
                    if text(alias(&body, &["account_id", "accountId"]))
                        .is_some_and(|id| id != credentials.account_id)
                    {
                        self.clear().await;
                        issue = Some("额度响应账号不一致，请重新登录 Codex".to_owned());
                    } else {
                        windows = parse_windows(&body, Utc::now().timestamp_millis());
                        if windows.is_none() {
                            issue = Some("官方接口未返回有效额度窗口".to_owned());
                        }
                    }
                    break;
                }
                Err(error) => {
                    issue = Some(if attempt > 0 {
                        format!("{}（已重试1次）", error.message)
                    } else {
                        error.message
                    });
                    if !error.retryable {
                        break;
                    }
                }
            }
        }
        let latest = self.credentials();
        if latest.as_ref().ok().map(|value| &value.key) != Some(&credentials.key) {
            self.clear().await;
            base.account = latest.ok().map(|value| value.account);
            base.official_issue = Some("登录信息已变化，等待重新同步".into());
            base.issues = vec!["登录信息已变化，等待重新同步".into()];
            return base;
        }
        if latest.as_ref().ok().map(|value| &value.access_token) != Some(&credentials.access_token)
        {
            windows = None;
            issue = Some("登录凭据已更新，等待重新同步".into());
        }
        let now = Utc::now().timestamp_millis();
        base.generated_at = Some(iso(now));
        if let Some(windows) = windows {
            base.available = !windows.is_empty();
            base.rate_limits = windows;
            base.rate_limit_source = "official".into();
            base.last_success_at = Some(iso(now));
            *self.cached.lock().await = Some(Cached {
                key: credentials.key,
                snapshot: base.clone(),
                saved_at: now,
            });
            return base;
        }
        if let Some(cache) = self.cached.lock().await.as_ref().filter(|entry| {
            entry.key == credentials.key && (0..=15 * 60 * 1000).contains(&(now - entry.saved_at))
        }) {
            base.available = cache.snapshot.available;
            base.rate_limits = cache.snapshot.rate_limits.clone();
            base.rate_limit_source = "cache".into();
            base.last_success_at = cache.snapshot.last_success_at.clone();
        }
        let issue = issue.unwrap_or_else(|| "官方额度暂不可用".into());
        base.official_issue = Some(issue.clone());
        base.issues = vec![issue];
        base
    }
}

async fn request(credentials: &Credentials) -> Result<Value, HttpError> {
    let response = http::usage(
        credentials.access_token.clone(),
        credentials.account_id.clone(),
    )
    .await?;
    if !(200..300).contains(&response.status) {
        let issue = match response.status {
            401 => "登录已失效 HTTP 401，请在 Codex 中重新登录".into(),
            403 => "访问被拒绝 HTTP 403，请检查账号权限或网络访问限制".into(),
            407 => "代理需要认证 HTTP 407，请检查系统代理设置".into(),
            429 => "官方接口请求过于频繁 HTTP 429，请稍后刷新或增加刷新间隔".into(),
            status => format!("官方额度接口返回 HTTP {status}"),
        };
        return Err(HttpError::new(
            issue,
            [500, 502, 503, 504].contains(&response.status) && !response.retry_after,
        ));
    }
    serde_json::from_slice(&response.body).map_err(|_| {
        HttpError::new(
            "官方额度接口返回内容不是有效 JSON，请检查网络登录页或代理拦截",
            false,
        )
    })
}

fn credentials(auth: &Value) -> Result<Credentials, String> {
    let mode = text(alias(auth, &["auth_mode", "authMode"]));
    let tokens = &auth["tokens"];
    if mode.is_some_and(|value| value != "chatgpt")
        || (mode.is_none() && text(&auth["OPENAI_API_KEY"]).is_some())
    {
        return Err("当前不是 ChatGPT 登录，无法监测订阅额度".into());
    }
    let token = text(alias(tokens, &["access_token", "accessToken"]))
        .ok_or("缺少 ChatGPT 凭据，请在 Codex 中登录")?;
    let claims = decode_claims(token);
    let id_claims = text(alias(tokens, &["id_token", "idToken"]))
        .map(decode_claims)
        .unwrap_or(Value::Null);
    let access_auth = &claims["https://api.openai.com/auth"];
    let id_auth = &id_claims["https://api.openai.com/auth"];
    let account = text(alias(tokens, &["account_id", "accountId"]))
        .or_else(|| text(&access_auth["chatgpt_account_id"]))
        .or_else(|| text(&id_auth["chatgpt_account_id"]))
        .ok_or("缺少账号标识，请重新登录 Codex 后刷新")?;
    if text(&access_auth["chatgpt_account_id"]).is_some_and(|value| value != account) {
        return Err("账号标识与登录令牌不一致，请重新登录 Codex".into());
    }
    // JWT 仅用于标注及缓存隔离，实际凭据有效性由官方接口确认。
    let subject = text(&access_auth["chatgpt_user_id"])
        .or_else(|| text(&claims["sub"]))
        .or_else(|| text(&id_auth["chatgpt_user_id"]))
        .or_else(|| text(&id_claims["sub"]))
        .unwrap_or(token);
    let email = text(&claims["https://api.openai.com/profile"]["email"])
        .or_else(|| text(&id_claims["email"]));
    let suffix: String = account
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let label = email
        .and_then(|email| email.split_once('@'))
        .map(|(name, domain)| format!("{}***@{domain}", name.chars().take(2).collect::<String>()))
        .unwrap_or_else(|| format!("ChatGPT · …{suffix}"));
    let key = serde_json::to_vec(&[account, subject])
        .map_err(|_| "无法识别账号 / Could not identify account")?;
    Ok(Credentials {
        access_token: token.into(),
        account_id: account.into(),
        key: format!("{:x}", Sha256::digest(key)),
        account: Account {
            label,
            workspace: format!("…{suffix}"),
        },
    })
}

fn decode_claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|value| URL_SAFE_NO_PAD.decode(value.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

fn parse_windows(response: &Value, observed_at: i64) -> Option<Vec<RateLimitWindow>> {
    let rate_limit = alias(response, &["rate_limit", "rateLimit"]).as_object()?;
    let mut windows = Vec::new();
    for (key, value) in rate_limit {
        let Some(id) = key
            .strip_suffix("_window")
            .or_else(|| key.strip_suffix("Window"))
        else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        value.as_object()?;
        let used = number(alias(value, &["used_percent", "usedPercent"]))?;
        if used > 100.0 {
            return None;
        }
        let minutes = number(alias(
            value,
            &["limit_window_seconds", "limitWindowSeconds"],
        ))
        .map(|value| value / 60.0);
        let absolute = number(alias(
            value,
            &["reset_at", "resetAt", "resets_at", "resetsAt"],
        ))
        .map(|value| {
            if value >= 1_000_000_000_000.0 {
                value
            } else {
                value * 1000.0
            }
        })
        .and_then(epoch);
        let reset = absolute.or_else(|| {
            number(alias(value, &["reset_after_seconds", "resetAfterSeconds"]))
                .and_then(|seconds| epoch(observed_at as f64 + seconds * 1000.0))
        });
        let label = match minutes {
            Some(value) if value >= 1440.0 => format!("{}d", value / 1440.0),
            Some(value) if value >= 60.0 => format!("{}h", value / 60.0),
            Some(value) => format!("{value}m"),
            None => id.to_owned(),
        };
        windows.push(RateLimitWindow {
            id: id.into(),
            label,
            window_minutes: minutes,
            used_percent: used,
            remaining_percent: 100.0 - used,
            resets_at: reset.map(iso),
            resets_in_seconds: reset.map(|value| ((value - observed_at).max(0)) / 1000),
            observed_at: iso(observed_at),
        });
    }
    windows.sort_by(|left, right| {
        left.window_minutes
            .unwrap_or(f64::INFINITY)
            .total_cmp(&right.window_minutes.unwrap_or(f64::INFINITY))
            .then_with(|| left.id.cmp(&right.id))
    });
    Some(windows)
}

fn epoch(value: f64) -> Option<i64> {
    if !value.is_finite() || !(0.0..=8_640_000_000_000_000.0).contains(&value) {
        return None;
    }
    DateTime::from_timestamp_millis(value as i64).map(|date| date.timestamp_millis())
}

pub fn iso(milliseconds: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(milliseconds)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn alias<'a>(value: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .find_map(|key| value.get(*key).filter(|value| !value.is_null()))
        .unwrap_or(&Value::Null)
}
fn text(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .filter(|value| value.is_finite() && *value >= 0.0)
}
