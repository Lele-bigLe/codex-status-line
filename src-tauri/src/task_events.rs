use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub call_id: String,
    pub text: String,
    pub asynchronous: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub cwd: String,
    pub client: String,
    pub status: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_questions: Vec<Question>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub muted: bool,
}

#[derive(Clone)]
pub struct Session {
    pub thread_id: String,
    pub cwd: String,
    pub client: String,
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn timestamp(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| crate::quota::iso(time.timestamp_millis()))
}

pub fn brief(value: &str, limit: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

pub fn session(value: &Value) -> Option<Session> {
    let payload = &value["payload"];
    let thread = payload["id"].as_str()?;
    let cwd = payload["cwd"].as_str()?;
    if value["type"] != "session_meta"
        || !valid_id(thread)
        || cwd.len() > 4096
        || payload
            .get("source")
            .is_some_and(|v| !v.is_string() && !v.is_number() && !v.is_boolean())
        || payload["service_name"] == "codex-status-cycle-trigger"
        || payload["serviceName"] == "codex-status-cycle-trigger"
    {
        return None;
    }
    let client = if payload["source"] == "vscode" || payload["originator"] == "codex_vscode" {
        "vscode"
    } else if payload["source"] == "cli" {
        "cli"
    } else {
        "unknown"
    };
    Some(Session {
        thread_id: thread.into(),
        cwd: cwd.into(),
        client: client.into(),
    })
}

fn summary(value: &Value) -> Option<String> {
    let payload = &value["payload"];
    let text = if value["type"] == "event_msg" && payload["type"] == "user_message" {
        payload["message"].as_str()?.to_owned()
    } else if value["type"] == "response_item"
        && payload["type"] == "message"
        && payload["role"] == "user"
    {
        payload["content"]
            .as_array()?
            .iter()
            .filter(|part| part["type"] == "input_text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        return None;
    };
    let text = if let Some((_, request)) = text.split_once("## My request:") {
        request
    } else {
        let text = text.trim_start();
        if text.starts_with('<')
            || text.starts_with("# AGENTS.md")
            || text.starts_with("# Context from my IDE")
        {
            return None;
        }
        text
    };
    let summary = brief(text, 220);
    (!summary.is_empty()).then_some(summary)
}

fn lifecycle(value: &Value, session: &Session, updated_at: &str) -> Option<Task> {
    let payload = &value["payload"];
    let turn_id = payload["turn_id"].as_str()?;
    if value["type"] != "event_msg" || !valid_id(turn_id) {
        return None;
    }
    let status = match payload["type"].as_str()? {
        "task_started" => "running",
        "task_complete" => "completed",
        "turn_aborted" => "interrupted",
        _ => return None,
    };
    let started_at = payload["started_at"]
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0)
        .and_then(|v| DateTime::from_timestamp_millis((v * 1000.0) as i64))
        .map(|v| crate::quota::iso(v.timestamp_millis()))
        .or_else(|| payload["started_at"].as_str().and_then(timestamp))
        .or_else(|| (status == "running").then(|| updated_at.into()));
    Some(Task {
        id: format!("{}:{turn_id}", session.thread_id),
        thread_id: session.thread_id.clone(),
        turn_id: turn_id.into(),
        cwd: session.cwd.clone(),
        client: session.client.clone(),
        status: status.into(),
        updated_at: updated_at.into(),
        title: None,
        started_at,
        duration_ms: payload["duration_ms"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0),
        request_summary: None,
        pending_questions: Vec::new(),
        ended_at: None,
        muted: false,
    })
}

pub struct TaskStore {
    pub tasks: HashMap<String, Task>,
    pub active: HashMap<String, String>,
    pub muted: HashSet<String>,
    pub removed: HashMap<String, String>,
    calls: HashSet<String>,
    pub changed: bool,
    pub notifications: Vec<Task>,
}

impl TaskStore {
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            active: HashMap::new(),
            muted: HashSet::new(),
            removed: HashMap::new(),
            calls: HashSet::new(),
            changed: false,
            notifications: Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        self.active.clear();
        self.calls.clear();
        self.notifications.clear();
        for task in self.tasks.values_mut() {
            if matches!(task.status.as_str(), "running" | "waiting_input") {
                task.status = "unknown".into();
            }
        }
        self.changed = true;
    }

    pub fn restore_active(&mut self, thread: &str) {
        if self.active.contains_key(thread) {
            return;
        }
        if let Some(task) = self
            .tasks
            .values()
            .filter(|task| task.thread_id == thread)
            .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
        {
            if matches!(task.status.as_str(), "unknown" | "waiting_input") {
                self.active.insert(thread.into(), task.id.clone());
            }
        }
    }

    pub fn consume(
        &mut self,
        value: &Value,
        session: &Session,
        notify: bool,
        recovered: &mut HashSet<String>,
    ) {
        if self.removed.contains_key(&session.thread_id) {
            return;
        }
        let Some(updated_at) = value["timestamp"].as_str().and_then(timestamp) else {
            return;
        };
        let payload = &value["payload"];
        if !payload.is_object() {
            return;
        }
        let Some(mut task) = lifecycle(value, session, &updated_at) else {
            self.activity(value, session, &updated_at, notify);
            return;
        };
        let previous = self.tasks.get(&task.id);
        let replay = !notify && task.status == "running" && recovered.insert(task.id.clone());
        if let Some(previous) = previous {
            if !replay
                && (matches!(previous.status.as_str(), "completed" | "interrupted")
                    || previous.updated_at > task.updated_at
                    || (previous.status == task.status && task.status != "running")
                    || (task.status == "running" && previous.status != "unknown")
                    || (previous.ended_at.is_some() && task.status == "running"))
            {
                return;
            }
            task.started_at = task.started_at.or_else(|| previous.started_at.clone());
            task.title = previous.title.clone();
            task.request_summary = previous.request_summary.clone();
            if task.status == "running" && notify && !previous.pending_questions.is_empty() {
                task.pending_questions = previous.pending_questions.clone();
                task.status = "waiting_input".into();
            }
            if task.status == "completed" {
                task.pending_questions = previous
                    .pending_questions
                    .iter()
                    .filter(|q| q.asynchronous)
                    .cloned()
                    .collect();
            }
        }
        if task.status == "completed" {
            task.ended_at = Some(task.updated_at.clone());
            if !task.pending_questions.is_empty() {
                task.status = "waiting_input".into();
            }
        }
        if task.status == "running" && !notify {
            task.status = "unknown".into();
        }
        if matches!(
            task.status.as_str(),
            "running" | "waiting_input" | "unknown"
        ) {
            let active = self
                .active
                .get(&task.thread_id)
                .and_then(|id| self.tasks.get(id));
            if active
                .is_none_or(|active| active.id == task.id || active.updated_at <= task.updated_at)
            {
                self.active.insert(task.thread_id.clone(), task.id.clone());
            }
        } else if self.active.get(&task.thread_id) == Some(&task.id) {
            self.active.remove(&task.thread_id);
        }
        if notify
            && matches!(task.status.as_str(), "completed" | "interrupted")
            && !self.muted.contains(&task.thread_id)
        {
            self.notifications.push(task.clone());
        }
        self.tasks.insert(task.id.clone(), task);
        self.changed = true;
    }

    fn activity(&mut self, value: &Value, session: &Session, updated_at: &str, notify: bool) {
        let Some(mut task) = self
            .active
            .get(&session.thread_id)
            .and_then(|id| self.tasks.get(id))
            .cloned()
        else {
            return;
        };
        let payload = &value["payload"];
        let turn = payload
            .get("turn_id")
            .filter(|v| !v.is_null())
            .or_else(|| value.pointer("/metadata/retained_source/id/turn_id"));
        if updated_at < task.updated_at.as_str()
            || turn
                .and_then(Value::as_str)
                .is_some_and(|turn| turn != task.turn_id)
            || !matches!(value["type"].as_str(), Some("response_item" | "event_msg"))
        {
            return;
        }
        let summary = summary(value);
        if summary.is_some() && summary != task.request_summary {
            task.request_summary = summary.clone();
            self.changed = true;
        }
        let kind = payload["type"].as_str().unwrap_or("");
        let activity = if value["type"] == "response_item" {
            [
                "function_call",
                "custom_tool_call",
                "function_call_output",
                "custom_tool_call_output",
                "reasoning",
            ]
            .contains(&kind)
                || (kind == "message" && (payload["role"] == "assistant" || summary.is_some()))
        } else {
            [
                "agent_message",
                "agent_reasoning",
                "token_count",
                "item_started",
                "item_completed",
                "exec_command_begin",
                "exec_command_end",
                "mcp_tool_call_begin",
                "mcp_tool_call_end",
            ]
            .contains(&kind)
        };
        let name = payload["name"]
            .as_str()
            .and_then(|name| name.rsplit('.').next())
            .unwrap_or("");
        let call = payload["call_id"].as_str();
        let key = format!("{}:{}", task.id, call.unwrap_or(""));
        let mut questions = task.pending_questions.clone();
        let mut new_question = false;
        let mut answered_question = false;
        if matches!(kind, "function_call" | "custom_tool_call")
            && matches!(name, "request_user_input" | "request_user_input_async")
            && call.is_some_and(|id| id.len() <= 200)
            && !self.calls.contains(&key)
            && !questions.iter().any(|q| Some(q.call_id.as_str()) == call)
        {
            let arguments = payload
                .get("arguments")
                .filter(|v| !v.is_null())
                .unwrap_or(&payload["input"]);
            if let Some(arguments) = arguments
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
            {
                if let Some(rows) = arguments["questions"].as_array() {
                    for row in rows {
                        let text = row["question"].as_str().or_else(|| row["title"].as_str());
                        if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
                            questions.push(Question {
                                call_id: call.unwrap_or("").into(),
                                text: brief(text, 220),
                                asynchronous: name == "request_user_input_async",
                            });
                            new_question = true;
                        }
                    }
                    if new_question {
                        self.calls.insert(key);
                    }
                    if questions.len() > 20 {
                        questions.drain(..questions.len() - 20);
                    }
                }
            }
        }
        if matches!(kind, "function_call_output" | "custom_tool_call_output") {
            let accepted = payload["output"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .is_some_and(|output| output["accepted"] == true);
            questions.retain(|q| Some(q.call_id.as_str()) != call || (q.asynchronous && accepted));
        }
        if kind == "message" && payload["role"] == "user" {
            if let Some(content) = payload["content"].as_array() {
                for part in content {
                    let reply = part["text"]
                        .as_str()
                        .map(str::trim)
                        .and_then(|text| text.strip_prefix("<send_user_message_question_reply>"))
                        .and_then(|text| text.strip_suffix("</send_user_message_question_reply>"));
                    let answers = reply.and_then(|text| serde_json::from_str::<Value>(text).ok());
                    if let Some(answers) = answers.as_ref().and_then(Value::as_array) {
                        let answered: HashSet<_> = answers
                            .iter()
                            .filter(|a| a["answer"].is_string())
                            .filter_map(|a| a["question"].as_str())
                            .map(|text| brief(text, 220))
                            .collect();
                        answered_question |= !answered.is_empty();
                        questions.retain(|q| !answered.contains(&q.text));
                    }
                }
            }
        }
        let status = if !questions.is_empty() {
            "waiting_input"
        } else if task.ended_at.is_some() {
            "completed"
        } else if !notify {
            "unknown"
        } else if activity || answered_question {
            "running"
        } else {
            &task.status
        };
        if task.status != status || task.pending_questions.len() != questions.len() || new_question
        {
            task.status = status.to_owned();
            task.pending_questions = questions;
            task.updated_at = updated_at.into();
            self.changed = true;
        }
        if new_question && notify && !self.muted.contains(&task.thread_id) {
            self.notifications.push(task.clone());
        }
        if task.status == "completed" {
            self.active.remove(&task.thread_id);
        }
        self.tasks.insert(task.id.clone(), task);
    }
}
