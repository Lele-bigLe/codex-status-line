use std::sync::atomic::{AtomicBool, Ordering};

pub struct HttpError {
    pub message: String,
    pub retryable: bool,
}

impl HttpError {
    pub fn new(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            message: message.into(),
            retryable,
        }
    }
}

pub struct Response {
    pub status: u32,
    pub retry_after: bool,
    pub body: Vec<u8>,
}

static REQUEST_ACTIVE: AtomicBool = AtomicBool::new(false);

pub async fn usage(access_token: String, account_id: String) -> Result<Response, HttpError> {
    if REQUEST_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(HttpError::new(
            "上一额度请求仍在结束，请稍后刷新 / The previous request is still finishing",
            false,
        ));
    }
    let job = tauri::async_runtime::spawn_blocking(move || {
        struct Release;
        impl Drop for Release {
            fn drop(&mut self) {
                REQUEST_ACTIVE.store(false, Ordering::Release);
            }
        }
        let _release = Release;
        platform::request(&access_token, &account_id)
    });
    match tokio::time::timeout(std::time::Duration::from_secs(20), job).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(HttpError::new(
            "额度请求未能完成 / Could not complete the usage request",
            false,
        )),
        Err(_) => Err(HttpError::new(
            "官方额度接口请求超时（20秒），请检查系统代理及网络连接",
            true,
        )),
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        ffi::c_void,
        ptr::{null, null_mut},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER},
        Networking::WinHttp::*,
    };

    struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn failure() -> HttpError {
        let code = unsafe { GetLastError() };
        let retryable = !matches!(code, 12037 | 12038 | 12044 | 12045 | 12157 | 12175);
        HttpError::new(
            format!("官方额度网络连接失败（WINHTTP_{code}），请检查系统代理、网络及证书"),
            retryable,
        )
    }

    unsafe fn option(handle: &Handle, name: u32, value: u32) -> Result<(), HttpError> {
        if WinHttpSetOption(handle.0, name, &value as *const _ as _, 4) == 0 {
            return Err(failure());
        }
        Ok(())
    }

    pub fn request(token: &str, account: &str) -> Result<Response, HttpError> {
        if token.contains(['\r', '\n', '\0']) || account.contains(['\r', '\n', '\0']) {
            return Err(HttpError::new("登录凭据格式无效，请重新登录 Codex", false));
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        unsafe {
            let session = Handle(WinHttpOpen(
                wide("codex-cli").as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                null(),
                null(),
                0,
            ));
            if session.0.is_null() {
                return Err(failure());
            }
            if WinHttpSetTimeouts(session.0, 5000, 5000, 5000, 20000) == 0 {
                return Err(failure());
            }
            let connection = Handle(WinHttpConnect(
                session.0,
                wide("chatgpt.com").as_ptr(),
                443,
                0,
            ));
            if connection.0.is_null() {
                return Err(failure());
            }
            let request = Handle(WinHttpOpenRequest(
                connection.0,
                wide("GET").as_ptr(),
                wide("/backend-api/wham/usage").as_ptr(),
                null(),
                null(),
                null(),
                WINHTTP_FLAG_SECURE,
            ));
            if request.0.is_null() {
                return Err(failure());
            }
            option(
                &request,
                WINHTTP_OPTION_DISABLE_FEATURE,
                WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_REDIRECTS,
            )?;
            option(
                &request,
                WINHTTP_OPTION_AUTOLOGON_POLICY,
                WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH,
            )?;
            let headers = wide(&format!("Authorization: Bearer {token}\r\nChatGPT-Account-Id: {account}\r\nAccept: application/json\r\nCache-Control: no-cache\r\n"));
            if WinHttpSendRequest(
                request.0,
                headers.as_ptr(),
                headers.len() as u32 - 1,
                null(),
                0,
                0,
                0,
            ) == 0
            {
                return Err(failure());
            }
            if WinHttpReceiveResponse(request.0, null_mut()) == 0 {
                return Err(failure());
            }
            let mut status = 0u32;
            let mut length = 4u32;
            if WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                null(),
                &mut status as *mut _ as _,
                &mut length,
                null_mut(),
            ) == 0
            {
                return Err(failure());
            }
            let mut retry_buffer = [0u16; 256];
            let mut retry_size = std::mem::size_of_val(&retry_buffer) as u32;
            let has_retry_after = WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_RETRY_AFTER,
                null(),
                retry_buffer.as_mut_ptr() as _,
                &mut retry_size,
                null_mut(),
            ) != 0
                || GetLastError() == ERROR_INSUFFICIENT_BUFFER;
            // 非 2xx 不消费响应体；返回值仅包含状态码，不转发服务端敏感文本。
            if !(200..300).contains(&status) {
                return Ok(Response {
                    status,
                    retry_after: has_retry_after,
                    body: Vec::new(),
                });
            }
            let mut body = Vec::new();
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(HttpError::new("官方额度接口请求超时（20秒）", true));
                }
                let milliseconds = remaining.as_millis().clamp(1, 20000) as i32;
                if WinHttpSetTimeouts(
                    request.0,
                    milliseconds,
                    milliseconds,
                    milliseconds,
                    milliseconds,
                ) == 0
                {
                    return Err(failure());
                }
                let mut buffer = [0u8; 16384];
                let mut count = 0u32;
                if WinHttpReadData(
                    request.0,
                    buffer.as_mut_ptr() as _,
                    buffer.len() as u32,
                    &mut count,
                ) == 0
                {
                    return Err(failure());
                }
                if count == 0 {
                    break;
                }
                body.extend_from_slice(&buffer[..count as usize]);
                if body.len() > 2 * 1024 * 1024 {
                    return Err(HttpError::new("官方额度响应过大，已停止读取", false));
                }
            }
            Ok(Response {
                status,
                retry_after: false,
                body,
            })
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn request(_: &str, _: &str) -> Result<Response, HttpError> {
        Err(HttpError::new(
            "当前额度网络适配仅支持 Windows / This network adapter currently supports Windows",
            false,
        ))
    }
}
