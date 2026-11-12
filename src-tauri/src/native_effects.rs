use crate::{model::Settings, task_events::Task};

fn clipped(value: &str, limit: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > limit {
        format!(
            "{}…",
            text.chars()
                .take(limit.saturating_sub(1))
                .collect::<String>()
        )
    } else {
        text
    }
}

fn notification_content(tasks: &[Task], english: bool) -> (String, String) {
    let label = |task: &Task| {
        clipped(
            &task
                .title
                .as_ref()
                .filter(|value| !value.is_empty())
                .cloned()
                .unwrap_or_else(|| {
                    task.cwd
                        .replace('\\', "/")
                        .rsplit('/')
                        .find(|v| !v.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            task.thread_id
                                .chars()
                                .rev()
                                .take(8)
                                .collect::<Vec<_>>()
                                .into_iter()
                                .rev()
                                .collect()
                        })
                }),
            28,
        )
    };
    let status = |task: &Task| match (task.status.as_str(), english) {
        ("waiting_input", true) => "Awaiting your answer",
        ("waiting_input", false) => "等待你回答",
        ("interrupted", true) => "Interrupted",
        ("interrupted", false) => "已中断",
        (_, true) => "Turn ended",
        (_, false) => "本轮结束",
    };
    let summary = |task: &Task, limit: usize| {
        let questions = if task.status == "waiting_input" {
            task.pending_questions.as_slice()
        } else {
            &[]
        };
        let more = if questions.len() > 1 {
            if english {
                format!(" (+{} more)", questions.len() - 1)
            } else {
                format!("（另有 {} 个问题）", questions.len() - 1)
            }
        } else {
            String::new()
        };
        let text = questions
            .first()
            .map(|q| q.text.as_str())
            .filter(|text| !text.is_empty())
            .or(task.request_summary.as_deref())
            .unwrap_or("");
        format!(
            "{}{more}",
            clipped(text, limit.saturating_sub(more.chars().count()))
        )
    };
    if tasks.len() == 1 {
        return (
            format!("{} · {}", label(&tasks[0]), status(&tasks[0])),
            summary(&tasks[0], 60),
        );
    }
    let waiting = tasks.iter().any(|task| task.status == "waiting_input");
    let title = match (english, waiting) {
        (true, true) => format!("{} Codex session updates · Answers needed", tasks.len()),
        (false, true) => format!("{} 个 Codex 会话有更新 · 有问题待回答", tasks.len()),
        (true, false) => format!("{} Codex turns ended", tasks.len()),
        (false, false) => format!("{} 个 Codex 轮次已结束", tasks.len()),
    };
    let mut ordered: Vec<_> = tasks.iter().collect();
    ordered.sort_by_key(|t| t.status != "waiting_input");
    let body = ordered
        .into_iter()
        .take(3)
        .map(|task| {
            let summary = summary(task, 40);
            format!(
                "{} · {}{}",
                label(task),
                status(task),
                if summary.is_empty() {
                    summary
                } else {
                    format!("：{summary}")
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    (title, body)
}

pub fn notify(app: &tauri::AppHandle, tasks: &[Task], settings: &Settings) -> Result<(), String> {
    if tasks.is_empty() || !settings.task_monitoring || !settings.task_notifications {
        return Ok(());
    }
    let (title, body) = notification_content(tasks, settings.locale == "en-US");
    platform::notify(
        &app.config().identifier,
        &title,
        &body,
        settings.task_notification_sound,
    )
}

pub fn copy_session(window: &tauri::WebviewWindow, thread: &str) -> Result<(), String> {
    platform::copy_session(window, thread)
}

#[cfg(windows)]
mod platform {
    use std::ptr;
    use windows::{
        core::HSTRING,
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        UI::Notifications::{
            NotificationSetting, ToastNotification, ToastNotificationManager, ToastTemplateType,
        },
    };
    use windows_sys::Win32::{
        Foundation::{GlobalFree, HGLOBAL},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::CF_UNICODETEXT,
        },
    };

    pub fn notify(identifier: &str, title: &str, body: &str, sound: bool) -> Result<(), String> {
        let send = || -> windows::core::Result<()> {
            unsafe {
                RoInitialize(RO_INIT_MULTITHREADED)?;
            }
            struct Apartment;
            impl Drop for Apartment {
                fn drop(&mut self) {
                    unsafe {
                        RoUninitialize();
                    }
                }
            }
            let _apartment = Apartment;
            let xml = ToastNotificationManager::GetTemplateContent(ToastTemplateType::ToastText02)?;
            let nodes = xml.GetElementsByTagName(&HSTRING::from("text"))?;
            nodes
                .Item(0)?
                .AppendChild(&xml.CreateTextNode(&HSTRING::from(title))?)?;
            nodes
                .Item(1)?
                .AppendChild(&xml.CreateTextNode(&HSTRING::from(body))?)?;
            if !sound {
                let audio = xml.CreateElement(&HSTRING::from("audio"))?;
                audio.SetAttribute(&HSTRING::from("silent"), &HSTRING::from("true"))?;
                xml.DocumentElement()?.AppendChild(&audio)?;
            }
            // 与 Tauri 官方通知适配一致：未安装的开发版使用系统开发身份，无需注册开始菜单。
            let app_id = if tauri::is_dev() {
                "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
            } else {
                identifier
            };
            let notifier =
                ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?;
            if notifier.Setting()? != NotificationSetting::Enabled {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80070005u32 as i32,
                )));
            }
            notifier.Show(&ToastNotification::CreateToastNotification(&xml)?)
        };
        send().map_err(|error| format!("桌面通知发送失败（0x{:08X}），请检查 Windows 通知设置 / Desktop notification failed", error.code().0 as u32))
    }

    pub fn copy_session(window: &tauri::WebviewWindow, thread: &str) -> Result<(), String> {
        const ERROR: &str = "复制会话 ID 失败，请稍后重试 / Could not copy session ID; try again";
        struct Allocation(HGLOBAL);
        impl Drop for Allocation {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe {
                        GlobalFree(self.0);
                    }
                }
            }
        }
        struct Clipboard;
        impl Drop for Clipboard {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }
        let owner = window.hwnd().map_err(|_| ERROR)?;
        let text: Vec<u16> = thread.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let mut allocation = Allocation(GlobalAlloc(
                GMEM_MOVEABLE,
                text.len() * std::mem::size_of::<u16>(),
            ));
            if allocation.0.is_null() {
                return Err(ERROR.into());
            }
            let memory = GlobalLock(allocation.0);
            if memory.is_null() {
                return Err(ERROR.into());
            }
            ptr::copy_nonoverlapping(text.as_ptr(), memory as *mut u16, text.len());
            GlobalUnlock(allocation.0);
            if OpenClipboard(owner.0 as _) == 0 {
                return Err(ERROR.into());
            }
            let _clipboard = Clipboard;
            if EmptyClipboard() == 0
                || SetClipboardData(CF_UNICODETEXT as u32, allocation.0).is_null()
            {
                return Err(ERROR.into());
            }
            allocation.0 = ptr::null_mut();
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn notify(_: &str, _: &str, _: &str, _: bool) -> Result<(), String> {
        Err(
            "桌面通知暂仅支持 Windows / Desktop notifications currently support Windows only"
                .into(),
        )
    }
    pub fn copy_session(_: &tauri::WebviewWindow, _: &str) -> Result<(), String> {
        Err(
            "复制会话 ID 暂仅支持 Windows / Copying session IDs currently supports Windows only"
                .into(),
        )
    }
}
