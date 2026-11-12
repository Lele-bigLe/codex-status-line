use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub task_monitoring: bool,
    pub task_notifications: bool,
    pub task_notification_sound: bool,
    pub theme: String,
    pub capsule_scale: u32,
    pub display_mode: String,
    pub refresh_mode: String,
    pub refresh_interval_seconds: u64,
    pub percentage_mode: String,
    pub locale: String,
    pub launch_at_login: bool,
}

impl Settings {
    pub fn from_value(value: &Value) -> Self {
        let pick = |key: &str, allowed: &[&str], fallback: &str| {
            value[key]
                .as_str()
                .filter(|s| allowed.contains(s))
                .unwrap_or(fallback)
                .to_owned()
        };
        Self {
            task_monitoring: value["taskMonitoring"].as_bool().unwrap_or(true),
            task_notifications: value["taskNotifications"].as_bool().unwrap_or(true),
            task_notification_sound: value["taskNotificationSound"].as_bool().unwrap_or(false),
            theme: pick("theme", &["light", "dark"], "light"),
            capsule_scale: value["capsuleScale"]
                .as_f64()
                .unwrap_or(100.0)
                .round()
                .clamp(100.0, 300.0) as u32,
            display_mode: pick("displayMode", &["tray", "floating"], "tray"),
            refresh_mode: pick("refreshMode", &["auto", "manual"], "auto"),
            refresh_interval_seconds: value["refreshIntervalSeconds"]
                .as_f64()
                .unwrap_or(30.0)
                .round()
                .clamp(5.0, 600.0) as u64,
            percentage_mode: pick("percentageMode", &["remaining", "used"], "remaining"),
            locale: pick("locale", &["zh-CN", "en-US"], "zh-CN"),
            launch_at_login: value["launchAtLogin"].as_bool().unwrap_or(false),
        }
    }

    pub fn patched(&self, patch: Value) -> Result<Self, String> {
        let patch = patch.as_object().ok_or("设置格式无效 / Invalid settings")?;
        let mut value =
            serde_json::to_value(self).map_err(|_| "无法读取设置 / Could not read settings")?;
        for (key, item) in patch {
            if ![
                "taskMonitoring",
                "taskNotifications",
                "taskNotificationSound",
                "theme",
                "capsuleScale",
                "displayMode",
                "refreshMode",
                "refreshIntervalSeconds",
                "percentageMode",
                "locale",
            ]
            .contains(&key.as_str())
            {
                return Err("当前运行环境不支持此设置 / This setting is unavailable".into());
            }
            value[key] = item.clone();
        }
        Ok(Self::from_value(&value))
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowPreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub view_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dock_edge: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct PanelPreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

#[derive(Clone, Serialize)]
pub struct PersistedState {
    pub settings: Settings,
    pub window: WindowPreferences,
    pub panel: PanelPreferences,
}

impl PersistedState {
    pub fn load(file: &Path, legacy: Option<PathBuf>) -> Result<Self, String> {
        let read = |path: &Path| -> Result<Value, String> {
            let text =
                fs::read(path).map_err(|_| "无法读取设置文件 / Could not read settings file")?;
            serde_json::from_slice(&text).map_err(|_| "设置文件格式无效，请保留原文件后修复 / Invalid settings file; keep it before repairing")
        };
        let native = file.exists();
        let value = if native {
            read(file)?
        } else if let Some(legacy) = legacy.filter(|path| path.exists()) {
            read(&legacy)?
        } else {
            Value::Null
        };
        let mut window = if native {
            serde_json::from_value(value["window"].clone()).unwrap_or_default()
        } else {
            WindowPreferences::default()
        };
        if window.view_mode != "orb"
            || !matches!(window.dock_edge.as_deref(), Some("left" | "right"))
        {
            window.view_mode = "capsule".into();
            window.dock_edge = None;
        }
        Ok(Self {
            settings: Settings::from_value(&value["settings"]),
            window,
            panel: if native {
                serde_json::from_value(value["panel"].clone()).unwrap_or_default()
            } else {
                PanelPreferences::default()
            },
        })
    }

    pub fn save(&self, file: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|_| "无法序列化设置 / Could not serialize settings")?;
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "无法创建设置目录 / Could not create settings directory")?;
        }
        let temporary = file.with_extension("json.tmp");
        fs::write(&temporary, bytes).and_then(|_| fs::rename(&temporary, file))
            .map_err(|_| "设置保存失败，请检查目录权限 / Could not save settings; check directory permissions")
    }
}
