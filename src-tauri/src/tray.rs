use crate::{model::Settings, quota::UsageSnapshot, Runtime};
use chrono::{DateTime, Utc};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

const TRAY_ERROR: &str = "无法更新系统托盘 / Could not update the system tray";

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = app
        .state::<Runtime>()
        .data
        .lock()
        .unwrap()
        .persisted
        .settings
        .clone();
    let zh = settings.locale == "zh-CN";
    let details = MenuItem::with_id(
        app,
        "details",
        if zh { "额度详情" } else { "Usage details" },
        true,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(
        app,
        "settings",
        if zh { "设置" } else { "Settings" },
        true,
        None::<&str>,
    )?;
    let tasks = MenuItem::with_id(
        app,
        "tasks",
        if zh { "任务监视" } else { "Task monitor" },
        true,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(
        app,
        "refresh",
        if zh { "立即刷新" } else { "Refresh now" },
        true,
        None::<&str>,
    )?;
    let floating = settings.display_mode == "floating";
    let display = MenuItem::with_id(
        app,
        "display",
        match (zh, floating) {
            (true, true) => "隐藏悬浮条",
            (true, false) => "显示悬浮条",
            (false, true) => "Hide floating bar",
            (false, false) => "Show floating bar",
        },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        if zh {
            "退出 Tauri 预览"
        } else {
            "Quit Tauri preview"
        },
        true,
        None::<&str>,
    )?;
    Menu::with_items(
        app,
        &[&details, &tasks, &settings_item, &refresh, &display, &quit],
    )
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("status")
        .icon(bitmap("--", [71, 85, 105]))
        .tooltip("Codex Status Tauri")
        .menu(&menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let app = app.clone();
            match event.id.as_ref() {
                "details" | "settings" | "tasks" => {
                    let view = event.id.as_ref().to_owned();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = crate::open_view(&app, &view).await { crate::report_issue(&app, error); }
                    });
                }
                "refresh" => { tauri::async_runtime::spawn(async move { crate::refresh(&app).await; }); }
                "display" => {
                    tauri::async_runtime::spawn(async move {
                        let floating = app.state::<Runtime>().data.lock().unwrap().persisted.settings.display_mode == "floating";
                        if let Err(error) = crate::update_settings(&app, serde_json::json!({ "displayMode": if floating { "tray" } else { "floating" } })).await {
                            crate::report_issue(&app, error);
                        }
                    });
                }
                "quit" => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = app.state::<Runtime>().tasks.stop().await { crate::report_issue(&app, error); }
                        app.exit(0);
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::activate_from_tray(&app).await { crate::report_issue(&app, error); }
                });
            }
        })
        .build(app)?;
    Ok(())
}

pub fn rebuild_menu(app: &AppHandle) -> Result<(), String> {
    let tray = app.tray_by_id("status").ok_or(TRAY_ERROR)?;
    tray.set_menu(Some(menu(app).map_err(|_| TRAY_ERROR)?))
        .map_err(|_| TRAY_ERROR.into())
}

pub fn update(app: &AppHandle) -> Result<(), String> {
    let (snapshot, settings) = {
        let runtime = app.state::<Runtime>();
        let data = runtime.data.lock().unwrap();
        (data.snapshot.clone(), data.persisted.settings.clone())
    };
    let Some(tray) = app.tray_by_id("status") else {
        return Ok(());
    };
    let (text, color) = icon_state(&snapshot, &settings);
    tray.set_icon(Some(bitmap(&text, color)))
        .map_err(|_| TRAY_ERROR)?;
    let source = match snapshot.rate_limit_source.as_str() {
        "official" => {
            if settings.locale == "zh-CN" {
                "官方"
            } else {
                "Official"
            }
        }
        "cache" => {
            if settings.locale == "zh-CN" {
                "缓存"
            } else {
                "Cached"
            }
        }
        _ => {
            if settings.locale == "zh-CN" {
                "暂无额度"
            } else {
                "Unavailable"
            }
        }
    };
    let mode = match settings.percentage_mode.as_str() {
        "used" => {
            if settings.locale == "zh-CN" {
                "已用"
            } else {
                "Used"
            }
        }
        _ => {
            if settings.locale == "zh-CN" {
                "剩余"
            } else {
                "Remaining"
            }
        }
    };
    let percent = if text == "--" {
        text
    } else {
        format!("{text}%")
    };
    tray.set_tooltip(Some(format!(
        "Codex Status Tauri · {mode} {percent} · {source}"
    )))
    .map_err(|_| TRAY_ERROR.into())
}

fn timestamp(value: &Option<String>) -> Option<i64> {
    value
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|date| date.timestamp_millis())
}

fn icon_state(snapshot: &UsageSnapshot, settings: &Settings) -> (String, [u8; 3]) {
    let unknown = ("--".into(), [71, 85, 105]);
    let Some(primary) = snapshot.primary() else {
        return unknown;
    };
    let now = Utc::now().timestamp_millis();
    if snapshot.rate_limit_source == "none"
        || timestamp(&primary.resets_at).is_some_and(|reset| reset <= now)
    {
        return unknown;
    }
    let percent = if settings.percentage_mode == "used" {
        primary.used_percent
    } else {
        primary.remaining_percent
    };
    let stale = snapshot.rate_limit_source == "cache"
        || timestamp(&snapshot.last_success_at).is_some_and(|last| {
            now - last > 90_000.max(settings.refresh_interval_seconds as i64 * 2000)
        });
    let remaining = primary.remaining_percent;
    let color = if stale {
        [71, 85, 105]
    } else if remaining > 30.0 {
        [22, 101, 52]
    } else if remaining > 10.0 {
        [146, 64, 14]
    } else {
        [185, 28, 28]
    };
    (format!("{:.0}", percent.clamp(0.0, 100.0).round()), color)
}

fn bitmap(text: &str, color: [u8; 3]) -> Image<'static> {
    let glyphs = [
        ["111", "101", "101", "101", "111"],
        ["010", "110", "010", "010", "111"],
        ["111", "001", "111", "100", "111"],
        ["111", "001", "111", "001", "111"],
        ["101", "101", "111", "001", "001"],
        ["111", "100", "111", "001", "111"],
        ["111", "100", "111", "101", "111"],
        ["111", "001", "010", "010", "010"],
        ["111", "101", "111", "101", "111"],
        ["111", "101", "111", "001", "111"],
        ["000", "000", "111", "000", "000"],
    ];
    let mut pixels = vec![0; 32 * 32 * 4];
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[color[0], color[1], color[2], 255]);
    }
    let scale = if text.len() > 2 { 2 } else { 4 };
    let left = (32 - (text.len() * 4 - 1) * scale) / 2;
    for (digit, character) in text.chars().enumerate() {
        let rows = glyphs[character
            .to_digit(10)
            .map(|value| value as usize)
            .unwrap_or(10)];
        for y in 0..20 {
            for x in 0..3 * scale {
                if rows[y / 4].as_bytes()[x / scale] != b'1' {
                    continue;
                }
                let offset = ((y + 6) * 32 + left + digit * 4 * scale + x) * 4;
                pixels[offset..offset + 4].fill(255);
            }
        }
    }
    Image::new_owned(pixels, 32, 32)
}
