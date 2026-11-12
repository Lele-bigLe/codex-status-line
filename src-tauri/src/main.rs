#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod http;
mod model;
mod native_effects;
mod quota;
mod task_events;
mod task_window;
mod tasks;
mod tray;
mod windows;

use model::PersistedState;
use quota::{QuotaService, UsageSnapshot};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

struct RuntimeData {
    persisted: PersistedState,
    snapshot: UsageSnapshot,
    account_key: Option<String>,
    panel_view: String,
    last_attempt: Option<Instant>,
}

struct Runtime {
    data: Mutex<RuntimeData>,
    file: PathBuf,
    quota: QuotaService,
    tasks: tasks::Service,
    task_window: task_window::Controller,
    operations: tokio::sync::Mutex<()>,
    refresh_gate: tokio::sync::Mutex<()>,
    credentials_revision: AtomicU64,
    position_revision: AtomicU64,
    dirty: AtomicBool,
}

fn preferences(data: &RuntimeData) -> Value {
    json!({ "settings": data.persisted.settings, "window": data.persisted.window, "panel": data.persisted.panel })
}

fn publish_preferences(app: &AppHandle) {
    let payload = preferences(&app.state::<Runtime>().data.lock().unwrap());
    let _ = app.emit("codex-status:preferences-updated", payload);
}

fn publish_snapshot(app: &AppHandle) {
    let snapshot = app.state::<Runtime>().data.lock().unwrap().snapshot.clone();
    let _ = app.emit("codex-status:snapshot-updated", snapshot);
    if let Err(error) = tray::update(app) {
        eprintln!("{error}");
    }
}

fn report_issue(app: &AppHandle, issue: String) {
    {
        let runtime = app.state::<Runtime>();
        let mut data = runtime.data.lock().unwrap();
        data.snapshot.issues.retain(|value| value != &issue);
        data.snapshot.issues.insert(0, issue);
        data.snapshot.issues.truncate(6);
    }
    publish_snapshot(app);
}

fn update_tasks(app: &AppHandle, snapshot: tasks::Snapshot, notifications: Vec<task_events::Task>) {
    let _ = app.emit("codex-status:tasks-updated", &snapshot);
    let resize_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let runtime = resize_app.state::<Runtime>();
        if let Err(error) = runtime.task_window.tasks_changed(&resize_app).await {
            report_issue(&resize_app, error);
        }
    });
    if !snapshot.monitoring || notifications.is_empty() {
        return;
    }
    let runtime = app.state::<Runtime>();
    let settings = runtime.data.lock().unwrap().persisted.settings.clone();
    let outcome = native_effects::notify(app, &notifications, &settings);
    runtime.tasks.notification_result(outcome.err());
}

async fn refresh(app: &AppHandle) -> UsageSnapshot {
    let runtime = app.state::<Runtime>();
    let Ok(_guard) = runtime.refresh_gate.try_lock() else {
        return runtime.data.lock().unwrap().snapshot.clone();
    };
    runtime.dirty.store(false, Ordering::Release);
    let revision = runtime.credentials_revision.load(Ordering::Acquire);
    let fingerprint = runtime.quota.fingerprint();
    let lookup = runtime.quota.credentials();
    let key = lookup.as_ref().ok().map(|value| value.key.clone());
    {
        let mut data = runtime.data.lock().unwrap();
        if data.account_key != key {
            data.snapshot = UsageSnapshot::empty(&runtime.quota.auth_path);
            data.snapshot.account = lookup.as_ref().ok().map(|value| value.account.clone());
            data.account_key = key;
        }
        data.snapshot.is_refreshing = true;
    }
    publish_snapshot(app);
    let snapshot = runtime.quota.collect(lookup).await;
    let unchanged = runtime.credentials_revision.load(Ordering::Acquire) == revision
        && runtime.quota.fingerprint() == fingerprint;
    let latest = if unchanged {
        None
    } else {
        Some(runtime.quota.credentials())
    };
    {
        let mut data = runtime.data.lock().unwrap();
        if unchanged && runtime.credentials_revision.load(Ordering::Acquire) == revision {
            data.snapshot = snapshot;
        } else {
            runtime.dirty.store(true, Ordering::Release);
            if let Some(credentials) = latest {
                let key = credentials.as_ref().ok().map(|value| value.key.clone());
                if data.account_key != key {
                    data.account_key = key;
                    data.snapshot = UsageSnapshot::empty(&runtime.quota.auth_path);
                    data.snapshot.account = credentials.ok().map(|value| value.account);
                }
            }
        }
        data.snapshot.is_refreshing = false;
        data.last_attempt = Some(Instant::now());
    }
    publish_snapshot(app);
    let snapshot = runtime.data.lock().unwrap().snapshot.clone();
    snapshot
}

async fn update_settings(app: &AppHandle, patch: Value) -> Result<Value, String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime.operations.lock().await;
    let previous = runtime.data.lock().unwrap().persisted.clone();
    let settings = previous.settings.patched(patch)?;
    let monitoring = settings.task_monitoring;
    let window = match windows::apply_capsule(app, &previous.window, &settings, true) {
        Ok(window) => window,
        Err(error) => {
            if let Err(restore_error) =
                windows::apply_capsule(app, &previous.window, &previous.settings, true)
            {
                report_issue(app, restore_error);
            }
            return Err(error);
        }
    };
    let mut result = {
        let mut data = runtime.data.lock().unwrap();
        data.persisted.settings = settings;
        data.persisted.window = window;
        match data.persisted.save(&runtime.file) {
            Ok(()) => Ok(preferences(&data)),
            Err(error) => {
                data.persisted.settings = previous.settings.clone();
                data.persisted.window = previous.window.clone();
                Err(error)
            }
        }
    };
    if result.is_ok() && monitoring != previous.settings.task_monitoring {
        if let Err(error) = runtime.tasks.set_enabled(monitoring).await {
            let restored = {
                let mut data = runtime.data.lock().unwrap();
                data.persisted.settings = previous.settings.clone();
                data.persisted.window = previous.window.clone();
                data.persisted.save(&runtime.file)
            };
            if let Err(error) = restored {
                report_issue(app, error);
            }
            result = Err(error);
        }
    }
    if result.is_err() {
        if let Err(error) = windows::apply_capsule(app, &previous.window, &previous.settings, true)
        {
            report_issue(app, error);
        }
    }
    publish_preferences(app);
    if let Err(error) = tray::rebuild_menu(app).and_then(|_| tray::update(app)) {
        report_issue(app, error);
    }
    result
}

fn open_panel(app: &AppHandle, view: &str) -> Result<(), String> {
    if !matches!(view, "details" | "settings") {
        return Err("当前运行环境尚不支持此页面 / This page is unavailable".into());
    }
    let panel = {
        let runtime = app.state::<Runtime>();
        let mut data = runtime.data.lock().unwrap();
        data.panel_view = view.into();
        data.persisted.panel.clone()
    };
    windows::position_panel(app, &panel)?;
    app.emit_to(
        "panel",
        "codex-status:command",
        json!({ "type": "show-panel-view", "panelView": view }),
    )
    .map_err(|_| "无法切换页面 / Could not change panel view")?;
    windows::show_panel(app)
}

async fn open_view(app: &AppHandle, view: &str) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    if view == "tasks" {
        return runtime.task_window.open(app).await;
    }
    if view == "settings" {
        runtime.task_window.close(app).await?;
    }
    open_panel(app, view)
}

async fn activate_from_tray(app: &AppHandle) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let _guard = runtime.operations.lock().await;
    let persisted = runtime.data.lock().unwrap().persisted.clone();
    if persisted.settings.display_mode != "floating" {
        return open_panel(app, "details");
    }
    let window = app
        .get_webview_window("capsule")
        .ok_or("悬浮条不可用 / Floating bar unavailable")?;
    if window
        .is_visible()
        .map_err(|_| "无法读取窗口状态 / Could not read window state")?
    {
        window
            .hide()
            .map_err(|_| "无法隐藏悬浮条 / Could not hide floating bar")?;
    } else {
        let position = windows::apply_capsule(app, &persisted.window, &persisted.settings, true)?;
        runtime.data.lock().unwrap().persisted.window = position;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopRequest {
    command: String,
    args: Vec<Value>,
}

#[tauri::command]
async fn desktop_request(
    app: AppHandle,
    window: WebviewWindow,
    request: DesktopRequest,
) -> Result<Value, String> {
    let role = window.label();
    if !matches!(role, "panel" | "capsule" | "tasks") {
        return Err("未知窗口 / Unknown desktop window".into());
    }
    let runtime = app.state::<Runtime>();
    match request.command.as_str() {
        "bootstrap" => {
            if role == "capsule" {
                let _guard = runtime.operations.lock().await;
                let persisted = runtime.data.lock().unwrap().persisted.clone();
                let positioned =
                    windows::apply_capsule(&app, &persisted.window, &persisted.settings, true)?;
                runtime.data.lock().unwrap().persisted.window = positioned;
            }
            let data = runtime.data.lock().unwrap();
            Ok(json!({
                "capabilities": { "tasks": true, "automation": false, "feishu": false, "launchAtLogin": false },
                "settings": data.persisted.settings, "window": data.persisted.window, "panel": data.persisted.panel,
                "snapshot": data.snapshot, "role": role, "panelView": data.panel_view, "taskWindow": runtime.task_window.snapshot()
            }))
        }
        "refreshStatus" => Ok(json!(refresh(&app).await)),
        "getTasks" => Ok(json!(runtime.tasks.snapshot())),
        "setTaskMuted" | "removeTask" | "restoreTask" if role == "tasks" => {
            let id = request
                .args
                .first()
                .and_then(Value::as_str)
                .ok_or("会话参数无效 / Invalid session")?
                .to_owned();
            match request.command.as_str() {
                "setTaskMuted" => {
                    runtime
                        .tasks
                        .set_muted(
                            id,
                            request
                                .args
                                .get(1)
                                .and_then(Value::as_bool)
                                .ok_or("静音参数无效 / Invalid mute setting")?,
                        )
                        .await?
                }
                "removeTask" => runtime.tasks.remove(id).await?,
                _ => runtime.tasks.restore(id).await?,
            }
            Ok(Value::Null)
        }
        "copyTaskSession" if role == "tasks" => {
            let id = request
                .args
                .first()
                .and_then(Value::as_str)
                .ok_or("会话参数无效 / Invalid session")?;
            let task = runtime
                .tasks
                .snapshot()
                .tasks
                .into_iter()
                .find(|task| task.id == id)
                .ok_or("会话已不可用 / Session unavailable")?;
            native_effects::copy_session(&window, &task.thread_id)?;
            Ok(Value::Null)
        }
        "setTaskWindowPinned" if role == "tasks" => {
            let pinned = request
                .args
                .first()
                .and_then(Value::as_bool)
                .ok_or("窗口参数无效 / Invalid window setting")?;
            runtime.task_window.pin(&app, pinned).await?;
            Ok(Value::Null)
        }
        "updateSettings" if role == "panel" => {
            update_settings(
                &app,
                request
                    .args
                    .first()
                    .cloned()
                    .ok_or("缺少设置 / Missing settings")?,
            )
            .await
        }
        "closePanel" if matches!(role, "panel" | "tasks") => {
            if role == "tasks" {
                runtime.task_window.close(&app).await?;
            } else {
                windows::close_panel(&app)?;
            }
            Ok(Value::Null)
        }
        "openPanel" => {
            let view = match request.args.first() {
                None | Some(Value::Null) => "details",
                Some(value) => value.as_str().ok_or("页面参数无效 / Invalid view")?,
            };
            open_view(&app, view).await?;
            Ok(Value::Null)
        }
        "moveCapsuleWindow" | "finishCapsuleWindowDrag" if role == "capsule" => {
            let _guard = runtime.operations.lock().await;
            let previous = runtime.data.lock().unwrap().persisted.clone();
            let finishing = request.command == "finishCapsuleWindowDrag";
            let next = if finishing {
                windows::finish_drag(&app, &previous.window, &previous.settings)?
            } else {
                let payload = serde_json::from_value(
                    request
                        .args
                        .first()
                        .cloned()
                        .ok_or("缺少拖动坐标 / Missing drag position")?,
                )
                .map_err(|_| "拖动坐标无效 / Invalid drag position")?;
                windows::move_capsule(&app, &previous.window, &previous.settings, payload)?
            };
            let save_result = {
                let mut data = runtime.data.lock().unwrap();
                data.persisted.window = next.clone();
                if finishing {
                    data.persisted.save(&runtime.file)
                } else {
                    Ok(())
                }
            };
            if finishing {
                publish_preferences(&app);
            }
            save_result?;
            Ok(json!(next))
        }
        _ => Err("当前运行环境尚未迁移此能力 / This desktop feature has not been migrated".into()),
    }
}

fn start_background(app: &AppHandle) {
    let watch_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let runtime = watch_app.state::<Runtime>();
        let mut fingerprint = runtime.quota.fingerprint();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let next = runtime.quota.fingerprint();
            if next == fingerprint {
                continue;
            }
            fingerprint = next;
            runtime.credentials_revision.fetch_add(1, Ordering::AcqRel);
            runtime.dirty.store(true, Ordering::Release);
            let credentials = runtime.quota.credentials();
            let key = credentials.as_ref().ok().map(|value| value.key.clone());
            let changed = {
                let mut data = runtime.data.lock().unwrap();
                if data.account_key == key {
                    false
                } else {
                    data.account_key = key;
                    let refreshing = data.snapshot.is_refreshing;
                    data.snapshot = UsageSnapshot::empty(&runtime.quota.auth_path);
                    data.snapshot.account = credentials.ok().map(|value| value.account);
                    data.snapshot.is_refreshing = refreshing;
                    true
                }
            };
            if changed {
                runtime.quota.clear().await;
                publish_snapshot(&watch_app);
            }
        }
    });
    let refresh_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_tray_update = Instant::now();
        loop {
            let due = {
                let runtime = refresh_app.state::<Runtime>();
                let data = runtime.data.lock().unwrap();
                runtime.dirty.load(Ordering::Acquire)
                    || (data.persisted.settings.refresh_mode == "auto"
                        && data.last_attempt.is_none_or(|last| {
                            last.elapsed().as_secs()
                                >= data.persisted.settings.refresh_interval_seconds
                        }))
            };
            if due {
                refresh(&refresh_app).await;
            }
            if last_tray_update.elapsed().as_secs() >= 15 {
                if let Err(error) = tray::update(&refresh_app) {
                    eprintln!("{error}");
                }
                last_tray_update = Instant::now();
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

fn register_window_events(app: &AppHandle) {
    for label in ["panel", "capsule"] {
        register_window_events_for(app, label);
    }
}

fn register_window_events_for(app: &AppHandle, label: &'static str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let app = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if label == "tasks" {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = app.state::<Runtime>().task_window.close(&app).await {
                        report_issue(&app, error);
                    }
                });
                return;
            }
            if let Some(window) = app.get_webview_window(label) {
                if window.hide().is_err() {
                    report_issue(&app, "无法隐藏桌面窗口 / Could not hide window".into());
                }
            }
        }
        WindowEvent::Moved(position) if label == "tasks" => {
            app.state::<Runtime>().task_window.moved(*position);
        }
        WindowEvent::Moved(position) if label == "panel" => {
            let runtime = app.state::<Runtime>();
            {
                let mut data = runtime.data.lock().unwrap();
                data.persisted.panel.x = Some(position.x as f64);
                data.persisted.panel.y = Some(position.y as f64);
            }
            let revision = runtime.position_revision.fetch_add(1, Ordering::AcqRel) + 1;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let runtime = app.state::<Runtime>();
                let result = {
                    let data = runtime.data.lock().unwrap();
                    if runtime.position_revision.load(Ordering::Acquire) != revision {
                        return;
                    }
                    data.persisted.save(&runtime.file)
                };
                if let Err(error) = result {
                    report_issue(&app, error);
                }
            });
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let runtime = app.state::<Runtime>();
                if label == "tasks" {
                    if let Some(window) = app.get_webview_window("tasks") {
                        if let Ok(position) = window.outer_position() {
                            runtime.task_window.moved(position);
                        }
                    }
                    if let Err(error) = runtime.task_window.resize(&app).await {
                        report_issue(&app, error);
                    }
                    return;
                }
                let _guard = runtime.operations.lock().await;
                let mut persisted = runtime.data.lock().unwrap().persisted.clone();
                if let Some(window) = app.get_webview_window(label) {
                    if let Ok(position) = window.outer_position() {
                        if label == "capsule" {
                            persisted.window.x = Some(position.x as f64);
                            persisted.window.y = Some(position.y as f64);
                        } else {
                            persisted.panel.x = Some(position.x as f64);
                            persisted.panel.y = Some(position.y as f64);
                        }
                    }
                }
                let result = if label == "capsule" {
                    windows::apply_capsule(&app, &persisted.window, &persisted.settings, false).map(
                        |window| {
                            runtime.data.lock().unwrap().persisted.window = window;
                            publish_preferences(&app);
                        },
                    )
                } else {
                    windows::position_panel(&app, &persisted.panel)
                };
                if let Err(error) = result {
                    report_issue(&app, error);
                }
            });
        }
        _ => {}
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if app.try_state::<Runtime>().is_none() {
                return;
            }
            if let Err(error) = open_panel(app, "details") {
                report_issue(app, error);
            }
        }))
        .invoke_handler(tauri::generate_handler![desktop_request])
        .setup(|app| {
            let directory = app.path().app_config_dir()?;
            let file = directory.join("codex-status-state.json");
            let legacy = std::env::var_os("APPDATA")
                .map(|directory| PathBuf::from(directory).join("codex-status"));
            let persisted = PersistedState::load(
                &file,
                legacy
                    .as_ref()
                    .map(|directory| directory.join("codex-status-state.json")),
            )?;
            let quota = QuotaService::new(app.path().home_dir()?)?;
            let sessions = quota
                .auth_path
                .parent()
                .ok_or("无法解析会话目录 / Could not resolve session directory")?
                .join("sessions");
            let (tasks, worker) = tasks::Service::new();
            let monitoring = persisted.settings.task_monitoring;
            let snapshot = UsageSnapshot::empty(&quota.auth_path);
            app.manage(Runtime {
                data: Mutex::new(RuntimeData {
                    persisted,
                    snapshot,
                    account_key: None,
                    panel_view: "details".into(),
                    last_attempt: None,
                }),
                file,
                quota,
                tasks,
                task_window: task_window::Controller::new(),
                operations: tokio::sync::Mutex::new(()),
                refresh_gate: tokio::sync::Mutex::new(()),
                credentials_revision: AtomicU64::new(0),
                position_revision: AtomicU64::new(0),
                dirty: AtomicBool::new(true),
            });
            windows::create(app.handle())?;
            register_window_events(app.handle());
            tray::create(app.handle())?;
            worker.start(
                app.handle().clone(),
                sessions,
                directory.join("codex-status-tasks.json"),
                legacy.map(|directory| directory.join("codex-status-tasks.json")),
                monitoring,
            )?;
            start_background(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("无法启动 Codex Status Tauri / Could not start Codex Status Tauri");
}
