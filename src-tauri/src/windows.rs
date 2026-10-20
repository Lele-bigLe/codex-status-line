use crate::model::{PanelPreferences, Settings, WindowPreferences};
use serde::Deserialize;
use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const WINDOW_ERROR: &str = "无法更新桌面窗口 / Could not update the desktop window";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragMove {
    offset_x: f64,
    offset_y: f64,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    for (label, width, height) in [("panel", 480.0, 600.0), ("capsule", 200.0, 28.0)] {
        create_window(app, label, width, height)?;
    }
    Ok(())
}

pub fn create_tasks(app: &AppHandle) -> tauri::Result<()> {
    create_window(app, "tasks", 280.0, 32.0)
}

fn create_window(app: &AppHandle, label: &str, width: f64, height: f64) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Codex Status Tauri")
        .inner_size(width, height)
        .visible(false)
        .focused(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(label != "panel")
        .build()?;
    Ok(())
}

pub(crate) fn monitor(app: &AppHandle, x: Option<f64>, y: Option<f64>) -> Result<Monitor, String> {
    let at_point = match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
            app.monitor_from_point(x, y).map_err(|_| WINDOW_ERROR)?
        }
        _ => None,
    };
    at_point
        .or(app.primary_monitor().map_err(|_| WINDOW_ERROR)?)
        .ok_or_else(|| WINDOW_ERROR.into())
}

fn window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    app.get_webview_window(label)
        .ok_or_else(|| WINDOW_ERROR.into())
}

fn dimensions(
    preferences: &WindowPreferences,
    settings: &Settings,
    monitor: &Monitor,
) -> PhysicalSize<u32> {
    let factor = settings.capsule_scale as f64 / 100.0 * monitor.scale_factor();
    let (width, height) = if preferences.view_mode == "orb" {
        (28.0, 200.0)
    } else {
        (200.0, 28.0)
    };
    PhysicalSize::new(
        (width * factor).ceil() as u32,
        (height * factor).ceil() as u32,
    )
}

pub(crate) fn clamped(value: f64, start: i32, extent: u32, size: u32) -> i32 {
    value.round().clamp(
        start as f64,
        (start as f64 + extent as f64 - size as f64).max(start as f64),
    ) as i32
}

// 后台刷新和缩放均不激活窗口；只有用户打开面板时显式获取焦点。
fn without_focus(
    window: &WebviewWindow,
    action: impl FnOnce() -> tauri::Result<()>,
) -> Result<(), String> {
    let focused = window.is_focused().map_err(|_| WINDOW_ERROR)?;
    if !focused {
        window.set_focusable(false).map_err(|_| WINDOW_ERROR)?;
    }
    let result = action();
    let restore = if !focused {
        window.set_focusable(true)
    } else {
        Ok(())
    };
    result.and(restore).map_err(|_| WINDOW_ERROR.into())
}

pub(crate) fn bounds(
    window: &WebviewWindow,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    show: bool,
) -> Result<(), String> {
    let current_position = window.outer_position().map_err(|_| WINDOW_ERROR)?;
    let current_size = window.inner_size().map_err(|_| WINDOW_ERROR)?;
    if current_position == position
        && current_size == size
        && (!show || window.is_visible().map_err(|_| WINDOW_ERROR)?)
    {
        return Ok(());
    }
    without_focus(window, || {
        if current_position != position {
            window.set_position(position)?;
        }
        if current_size != size {
            window.set_size(size)?;
        }
        if show && !window.is_visible()? {
            window.show()?;
        }
        Ok(())
    })
}

pub fn apply_capsule(
    app: &AppHandle,
    preferences: &WindowPreferences,
    settings: &Settings,
    show: bool,
) -> Result<WindowPreferences, String> {
    let monitor = monitor(app, preferences.x, preferences.y)?;
    let area = monitor.work_area();
    let size = dimensions(preferences, settings, &monitor);
    let mut result = preferences.clone();
    let fallback_x = area.position.x as f64 + area.size.width as f64 - size.width as f64;
    let fallback_y = area.position.y as f64 + 24.0 * monitor.scale_factor();
    let x = clamped(
        preferences
            .x
            .filter(|value| value.is_finite())
            .unwrap_or(fallback_x),
        area.position.x,
        area.size.width,
        size.width,
    );
    let y = clamped(
        preferences
            .y
            .filter(|value| value.is_finite())
            .unwrap_or(fallback_y),
        area.position.y,
        area.size.height,
        size.height,
    );
    result.x = Some(x as f64);
    result.y = Some(y as f64);
    let window = window(app, "capsule")?;
    bounds(
        &window,
        PhysicalPosition::new(x, y),
        size,
        show && settings.display_mode == "floating",
    )?;
    if settings.display_mode != "floating" {
        window.hide().map_err(|_| WINDOW_ERROR)?;
    }
    Ok(result)
}

pub fn move_capsule(
    app: &AppHandle,
    preferences: &WindowPreferences,
    settings: &Settings,
    payload: DragMove,
) -> Result<WindowPreferences, String> {
    if !payload.offset_x.is_finite()
        || !payload.offset_y.is_finite()
        || !(0.0..=600.0).contains(&payload.offset_x)
        || !(0.0..=600.0).contains(&payload.offset_y)
    {
        return Err("拖动坐标无效 / Invalid drag position".into());
    }
    // WebView 的 screenX/Y 在混合 DPI 屏幕上口径不同，使用宿主的物理指针坐标。
    let pointer = app.cursor_position().map_err(|_| WINDOW_ERROR)?;
    let monitor = monitor(app, Some(pointer.x), Some(pointer.y))?;
    let mut next = preferences.clone();
    next.x = Some(pointer.x - payload.offset_x * monitor.scale_factor());
    next.y = Some(pointer.y - payload.offset_y * monitor.scale_factor());
    apply_capsule(app, &next, settings, false)
}

pub fn finish_drag(
    app: &AppHandle,
    preferences: &WindowPreferences,
    settings: &Settings,
) -> Result<WindowPreferences, String> {
    let mut next = apply_capsule(app, preferences, settings, false)?;
    let monitor = monitor(app, next.x, next.y)?;
    let area = monitor.work_area();
    let size = dimensions(&next, settings, &monitor);
    let x = next.x.unwrap_or(area.position.x as f64);
    let y = next.y.unwrap_or(area.position.y as f64);
    let left = area.position.x as f64;
    let right = left + area.size.width as f64;
    let threshold = if next.view_mode == "orb" { 42.0 } else { 18.0 } * monitor.scale_factor();
    let edge = if next.view_mode != "orb" || next.dock_edge.as_deref() == Some("left") {
        (x <= left + threshold).then_some("left")
    } else {
        None
    }
    .or_else(|| {
        if next.view_mode != "orb" || next.dock_edge.as_deref() == Some("right") {
            (x + size.width as f64 >= right - threshold).then_some("right")
        } else {
            None
        }
    });
    let mode = if edge.is_some() { "orb" } else { "capsule" };
    next.view_mode = mode.into();
    next.dock_edge = edge.map(str::to_owned);
    let settled_size = dimensions(&next, settings, &monitor);
    next.x = Some(match edge {
        Some("left") => left,
        Some("right") => right - settled_size.width as f64,
        _ => x + (size.width as f64 - settled_size.width as f64) / 2.0,
    });
    next.y = Some(y + (size.height as f64 - settled_size.height as f64) / 2.0);
    apply_capsule(app, &next, settings, false)
}

pub fn position_panel(app: &AppHandle, preferences: &PanelPreferences) -> Result<(), String> {
    let monitor = monitor(app, preferences.x, preferences.y)?;
    let area = monitor.work_area();
    let size = PhysicalSize::new(
        (480.0 * monitor.scale_factor()).round() as u32,
        (600.0 * monitor.scale_factor()).round() as u32,
    );
    let x = clamped(
        preferences
            .x
            .unwrap_or(area.position.x as f64 + (area.size.width as f64 - size.width as f64) / 2.0),
        area.position.x,
        area.size.width,
        size.width,
    );
    let y = clamped(
        preferences.y.unwrap_or(
            area.position.y as f64 + (area.size.height as f64 - size.height as f64) / 2.0,
        ),
        area.position.y,
        area.size.height,
        size.height,
    );
    bounds(
        &window(app, "panel")?,
        PhysicalPosition::new(x, y),
        size,
        false,
    )
}

pub fn show_panel(app: &AppHandle) -> Result<(), String> {
    let panel = window(app, "panel")?;
    panel
        .show()
        .and_then(|_| panel.set_focus())
        .map_err(|_| WINDOW_ERROR.into())
}

pub fn close_panel(app: &AppHandle) -> Result<(), String> {
    window(app, "panel")?
        .hide()
        .map_err(|_| WINDOW_ERROR.into())
}
