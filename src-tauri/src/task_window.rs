use crate::{windows, Runtime};
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

const ERROR: &str = "无法更新任务窗口 / Could not update the task window";

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub expanded: bool,
    pub pinned: bool,
    pub native_glass: bool,
}

struct Data {
    state: State,
    anchor: Option<PhysicalPosition<i32>>,
    expected_position: Option<PhysicalPosition<i32>>,
    last_inside: Option<bool>,
    hover_since: Instant,
    moving_until: Instant,
    rendered_count: usize,
}

pub struct Controller {
    data: Mutex<Data>,
    gate: tokio::sync::Mutex<()>,
}

impl Controller {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(Data {
                state: State::default(),
                anchor: None,
                expected_position: None,
                last_inside: None,
                hover_since: Instant::now(),
                moving_until: Instant::now(),
                rendered_count: 0,
            }),
            gate: tokio::sync::Mutex::new(()),
        }
    }

    pub fn snapshot(&self) -> State {
        self.data.lock().unwrap().state.clone()
    }

    // 程序调整位置时忽略对应 move 事件，保留用户拖动时的展开锚点。
    pub fn moved(&self, position: PhysicalPosition<i32>) {
        let mut data = self.data.lock().unwrap();
        if data.expected_position == Some(position) {
            return;
        }
        data.anchor = Some(position);
        data.moving_until = Instant::now() + Duration::from_millis(600);
        data.last_inside = None;
    }

    fn apply(&self, app: &AppHandle, state: State, show: bool) -> Result<(), String> {
        let window = app.get_webview_window("tasks").ok_or(ERROR)?;
        let anchor = self.data.lock().unwrap().anchor;
        let monitor =
            windows::monitor(app, anchor.map(|p| p.x as f64), anchor.map(|p| p.y as f64))?;
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let count = app.state::<Runtime>().tasks.snapshot().tasks.len().min(4);
        let height = if state.expanded {
            (220 + count * 70).clamp(300, 480) as f64
        } else {
            32.0
        };
        let size = PhysicalSize::new(
            ((if state.expanded { 360.0 } else { 280.0 }) * scale)
                .round()
                .min(area.size.width as f64) as u32,
            (height * scale).round().min(area.size.height as f64) as u32,
        );
        let anchor = anchor.unwrap_or_else(|| {
            PhysicalPosition::new(
                area.position.x + ((area.size.width as f64 - 280.0 * scale) / 2.0).round() as i32,
                area.position.y + (8.0 * scale).round() as i32,
            )
        });
        let position = PhysicalPosition::new(
            windows::clamped(
                anchor.x as f64,
                area.position.x,
                area.size.width,
                size.width,
            ),
            windows::clamped(
                anchor.y as f64,
                area.position.y,
                area.size.height,
                size.height,
            ),
        );
        {
            let mut data = self.data.lock().unwrap();
            if data.anchor.is_none() {
                data.anchor = Some(anchor);
            }
            data.expected_position = Some(position);
        }
        windows::bounds(&window, position, size, show)?;
        {
            let mut data = self.data.lock().unwrap();
            data.state = state.clone();
            data.last_inside = None;
            data.rendered_count = count;
        }
        app.emit_to("tasks", "codex-status:task-window-updated", state)
            .map_err(|_| ERROR.into())
    }

    pub async fn open(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.gate.lock().await;
        if app.get_webview_window("tasks").is_none() {
            windows::create_tasks(app).map_err(|_| ERROR)?;
            crate::register_window_events_for(app, "tasks");
            start_hover(app);
        }
        windows::close_panel(app)?;
        self.apply(app, self.snapshot(), true)
    }

    pub async fn close(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.gate.lock().await;
        if app.get_webview_window("tasks").is_none() {
            return Ok(());
        }
        app.get_webview_window("tasks")
            .ok_or(ERROR)?
            .hide()
            .map_err(|_| ERROR)?;
        self.apply(app, State::default(), false)
    }

    pub async fn pin(&self, app: &AppHandle, pinned: bool) -> Result<(), String> {
        let _guard = self.gate.lock().await;
        let mut state = self.snapshot();
        state.pinned = pinned;
        state.expanded |= pinned;
        self.apply(app, state, false)
    }

    pub async fn resize(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.gate.lock().await;
        self.apply(app, self.snapshot(), false)
    }

    pub async fn tasks_changed(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.gate.lock().await;
        let count = app.state::<Runtime>().tasks.snapshot().tasks.len().min(4);
        let next = {
            let data = self.data.lock().unwrap();
            (data.state.expanded && data.rendered_count != count).then(|| data.state.clone())
        };
        if let Some(state) = next {
            self.apply(app, state, false)?;
        }
        Ok(())
    }

    async fn hover(&self, app: &AppHandle) -> Result<(), String> {
        let Ok(_guard) = self.gate.try_lock() else {
            return Ok(());
        };
        let Some(window) = app.get_webview_window("tasks") else {
            return Ok(());
        };
        if !window.is_visible().map_err(|_| ERROR)?
            || self.data.lock().unwrap().moving_until > Instant::now()
        {
            return Ok(());
        }
        let position = window.outer_position().map_err(|_| ERROR)?;
        let size = window.inner_size().map_err(|_| ERROR)?;
        let pointer = app.cursor_position().map_err(|_| ERROR)?;
        let inside = pointer.x >= position.x as f64
            && pointer.x < position.x as f64 + size.width as f64
            && pointer.y >= position.y as f64
            && pointer.y < position.y as f64 + size.height as f64;
        let next = {
            let mut data = self.data.lock().unwrap();
            if data.last_inside != Some(inside) {
                data.last_inside = Some(inside);
                data.hover_since = Instant::now();
            }
            let elapsed = data.hover_since.elapsed().as_millis();
            let expanded = data.state.pinned
                || if inside {
                    data.state.expanded || elapsed >= 180
                } else {
                    data.state.expanded && elapsed < 450
                };
            if expanded == data.state.expanded {
                None
            } else {
                let mut next = data.state.clone();
                next.expanded = expanded;
                Some(next)
            }
        };
        if let Some(state) = next {
            self.apply(app, state, false)?;
        }
        Ok(())
    }
}

pub fn start_hover(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_error = None;
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            match app.state::<Runtime>().task_window.hover(&app).await {
                Ok(()) => last_error = None,
                Err(error) => {
                    if last_error.as_ref() != Some(&error) {
                        crate::report_issue(&app, error.clone());
                    }
                    last_error = Some(error);
                }
            }
        }
    });
}
