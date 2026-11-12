use crate::task_events::{self, Question, Session, Task, TaskStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::oneshot;

const MAX_LINE: usize = 1024 * 1024;
const WORKER_ERROR: &str = "任务监视服务不可用 / Task monitor unavailable";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedTask {
    pub thread_id: String,
    pub title: String,
}

#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    pub tasks: Vec<Task>,
    pub monitoring: bool,
    pub removed: Vec<RemovedTask>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
}

enum Action {
    Enable(bool),
    Mute(String, bool),
    Remove(String),
    Restore(String),
    NotificationResult(Option<String>),
    Stop,
}
struct Command {
    action: Action,
    reply: oneshot::Sender<Result<(), String>>,
}

pub struct Service {
    sender: mpsc::Sender<Command>,
    snapshot: Arc<Mutex<Snapshot>>,
}

impl Service {
    pub fn new() -> (Self, Worker) {
        let (sender, receiver) = mpsc::channel();
        let snapshot = Arc::new(Mutex::new(Snapshot::default()));
        (
            Self {
                sender,
                snapshot: Arc::clone(&snapshot),
            },
            Worker { receiver, snapshot },
        )
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }

    async fn request(&self, action: Action) -> Result<(), String> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .send(Command { action, reply })
            .map_err(|_| WORKER_ERROR)?;
        receiver.await.map_err(|_| WORKER_ERROR)?
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        self.request(Action::Enable(enabled)).await
    }
    pub async fn set_muted(&self, id: String, muted: bool) -> Result<(), String> {
        self.request(Action::Mute(id, muted)).await
    }
    pub async fn remove(&self, id: String) -> Result<(), String> {
        self.request(Action::Remove(id)).await
    }
    pub async fn restore(&self, id: String) -> Result<(), String> {
        self.request(Action::Restore(id)).await
    }
    pub async fn stop(&self) -> Result<(), String> {
        self.request(Action::Stop).await
    }
    pub fn notification_result(&self, issue: Option<String>) {
        let (reply, _) = oneshot::channel();
        let _ = self.sender.send(Command {
            action: Action::NotificationResult(issue),
            reply,
        });
    }
}

pub struct Worker {
    receiver: mpsc::Receiver<Command>,
    snapshot: Arc<Mutex<Snapshot>>,
}

impl Worker {
    pub fn start(
        self,
        app: tauri::AppHandle,
        root: PathBuf,
        state_file: PathBuf,
        legacy: Option<PathBuf>,
        enabled: bool,
    ) -> io::Result<()> {
        std::thread::Builder::new()
            .name("task-monitor".into())
            .spawn(move || {
                let mut monitor = Monitor::new(root, state_file);
                monitor.load(legacy);
                monitor.enable(enabled);
                let _ = monitor.publish(&app, &self.snapshot);
                let mut next_poll = Instant::now() + Duration::from_millis(1500);
                loop {
                    match self
                        .receiver
                        .recv_timeout(next_poll.saturating_duration_since(Instant::now()))
                    {
                        Ok(command) => {
                            let stop = matches!(&command.action, Action::Stop);
                            let persistent = matches!(
                                &command.action,
                                Action::Mute(..) | Action::Remove(..) | Action::Restore(..)
                            );
                            let result = monitor.command(command.action);
                            let saved = if monitor.store.changed {
                                monitor.publish(&app, &self.snapshot)
                            } else {
                                Ok(())
                            };
                            let result = if persistent {
                                result.and(saved)
                            } else {
                                result
                            };
                            let _ = command.reply.send(result);
                            if stop {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    if Instant::now() >= next_poll {
                        monitor.poll(false);
                        if monitor.store.changed {
                            let _ = monitor.publish(&app, &self.snapshot);
                        }
                        next_poll = Instant::now() + Duration::from_millis(1500);
                    }
                }
            })
            .map(|_| ())
    }
}

struct Cursor {
    offset: u64,
    file_id: (u64, u64),
    created: Option<SystemTime>,
    modified: Option<SystemTime>,
    baseline: bool,
    pending: Vec<u8>,
    skipping: bool,
    session: Option<Session>,
    recovering_until: Option<u64>,
    recovered: HashSet<String>,
}

impl Cursor {
    fn new(
        file: &File,
        metadata: &Metadata,
        offset: u64,
        baseline: bool,
        recovering_until: Option<u64>,
    ) -> io::Result<Self> {
        Ok(Self {
            offset,
            file_id: file_id(file)?,
            created: metadata.created().ok(),
            modified: metadata.modified().ok(),
            baseline,
            pending: Vec::new(),
            skipping: false,
            session: None,
            recovering_until,
            recovered: HashSet::new(),
        })
    }
}

struct Monitor {
    root: PathBuf,
    state_file: PathBuf,
    store: TaskStore,
    cursors: HashMap<PathBuf, Cursor>,
    active: bool,
    issue: Option<String>,
    notification_issue: Option<String>,
    can_persist: bool,
    last_scan: Option<Instant>,
    scan_failed: bool,
}

impl Monitor {
    fn new(root: PathBuf, state_file: PathBuf) -> Self {
        Self {
            root,
            state_file,
            store: TaskStore::new(),
            cursors: HashMap::new(),
            active: false,
            issue: None,
            notification_issue: None,
            can_persist: true,
            last_scan: None,
            scan_failed: false,
        }
    }

    fn load(&mut self, legacy: Option<PathBuf>) {
        let file = if self.state_file.exists() {
            Some(self.state_file.clone())
        } else {
            legacy.filter(|path| path.exists())
        };
        let Some(file) = file else {
            return;
        };
        let stored = fs::read(file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let rows = stored
            .as_ref()
            .and_then(|v| v.as_array().or_else(|| v["tasks"].as_array()));
        let Some(rows) = rows else {
            self.can_persist = false;
            self.issue = Some("任务记录读取失败，已保留原文件 / Could not read task history; original file preserved".into());
            return;
        };
        for row in rows {
            if let Some(task) = load_task(row) {
                self.store.tasks.insert(task.id.clone(), task);
            }
        }
        let state = stored.as_ref().unwrap_or(&Value::Null);
        if let Some(ids) = state["muted"].as_array() {
            self.store.muted.extend(
                ids.iter()
                    .filter_map(Value::as_str)
                    .filter(|id| task_events::valid_id(id))
                    .map(str::to_owned),
            );
        }
        if let Some(rows) = state["removed"].as_array() {
            for row in rows {
                if let (Some(id), Some(title)) = (row["threadId"].as_str(), row["title"].as_str()) {
                    if task_events::valid_id(id) {
                        self.store
                            .removed
                            .insert(id.into(), title.chars().take(160).collect());
                    }
                }
            }
        }
    }

    fn enable(&mut self, enabled: bool) {
        self.active = enabled;
        self.cursors.clear();
        self.last_scan = None;
        self.store.reset();
        if enabled {
            self.scan(true);
            self.poll(false);
        }
        self.read_titles();
    }

    fn command(&mut self, action: Action) -> Result<(), String> {
        if !self.can_persist
            && matches!(
                &action,
                Action::Mute(..) | Action::Remove(..) | Action::Restore(..)
            )
        {
            return Err("任务记录当前只读，请先修复原记录文件 / Task history is read-only; repair the original file first".into());
        }
        match action {
            Action::Enable(enabled) => self.enable(enabled),
            Action::Mute(id, muted) => {
                let thread = self
                    .store
                    .tasks
                    .get(&id)
                    .ok_or("会话已不可用 / Session unavailable")?
                    .thread_id
                    .clone();
                if muted {
                    self.store.muted.insert(thread);
                } else {
                    self.store.muted.remove(&thread);
                }
                self.store.changed = true;
            }
            Action::Remove(id) => {
                let task = self
                    .store
                    .tasks
                    .get(&id)
                    .ok_or("会话已不可用 / Session unavailable")?;
                let thread = task.thread_id.clone();
                let title = task
                    .title
                    .as_ref()
                    .filter(|value| !value.is_empty())
                    .cloned()
                    .unwrap_or_else(|| {
                        task.cwd
                            .replace('\\', "/")
                            .rsplit('/')
                            .find(|v| !v.is_empty())
                            .unwrap_or(&thread)
                            .into()
                    });
                self.store.removed.insert(thread.clone(), title);
                self.store.active.remove(&thread);
                for task in self
                    .store
                    .tasks
                    .values_mut()
                    .filter(|t| t.thread_id == thread)
                {
                    if matches!(task.status.as_str(), "running" | "waiting_input") {
                        task.status = "unknown".into();
                    }
                }
                self.store.changed = true;
            }
            Action::Restore(thread) => {
                if !task_events::valid_id(&thread) || !self.store.removed.contains_key(&thread) {
                    return Err("已移除会话不可用 / Removed session unavailable".into());
                }
                self.poll(true);
                for (path, cursor) in &mut self.cursors {
                    if cursor
                        .session
                        .as_ref()
                        .is_some_and(|session| session.thread_id == thread)
                    {
                        if let Ok(metadata) = fs::metadata(path) {
                            cursor.offset = metadata.len();
                            cursor.pending.clear();
                            cursor.skipping = false;
                            cursor.baseline = true;
                        }
                    }
                }
                self.store.removed.remove(&thread);
                self.store.changed = true;
            }
            Action::Stop => {
                self.active = false;
                self.store.changed = true;
            }
            Action::NotificationResult(issue) => {
                if self.notification_issue != issue {
                    self.notification_issue = issue;
                    self.store.changed = true;
                }
            }
        }
        Ok(())
    }

    fn scan(&mut self, baseline: bool) {
        self.last_scan = Some(Instant::now());
        self.scan_failed = false;
        let mut found = Vec::new();
        if collect_files(&self.root, &mut found).is_err() {
            self.scan_failed = true;
            self.set_issue("会话目录不可读取，正在重试 / Session directory unavailable; retrying");
            return;
        }
        let paths: HashSet<_> = found.iter().cloned().collect();
        self.cursors.retain(|path, _| paths.contains(path));
        for path in found {
            if self.cursors.contains_key(&path) {
                continue;
            }
            let open = File::open(&path).and_then(|file| {
                let metadata = file.metadata()?;
                let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
                let recover = baseline
                    && self
                        .store
                        .tasks
                        .values()
                        .any(|task| name.ends_with(&format!("-{}.jsonl", task.thread_id)));
                let offset = if recover {
                    metadata.len().saturating_sub(8 * MAX_LINE as u64)
                } else if baseline {
                    metadata.len()
                } else {
                    0
                };
                Cursor::new(
                    &file,
                    &metadata,
                    offset,
                    baseline,
                    recover.then_some(metadata.len()),
                )
            });
            match open {
                Ok(cursor) => {
                    self.cursors.insert(path, cursor);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => {
                    self.scan_failed = true;
                    self.set_issue(
                        "部分会话读取失败，正在重试 / Some sessions could not be read; retrying",
                    );
                }
            }
        }
        if self
            .issue
            .as_ref()
            .is_some_and(|v| v.starts_with("会话目录"))
        {
            self.issue = None;
            self.store.changed = true;
        }
    }

    fn poll(&mut self, rescan: bool) {
        if !self.active {
            return;
        }
        // 已知文件先增量读取，再扫描目录发现新会话；无需读取历史文件正文。
        self.read_changes();
        if rescan
            || self
                .last_scan
                .is_none_or(|time| time.elapsed().as_secs() >= 5)
        {
            self.scan(false);
            self.read_titles();
            self.read_changes();
        }
    }

    fn read_changes(&mut self) {
        let paths: Vec<_> = self.cursors.keys().cloned().collect();
        let mut failed = false;
        for path in paths {
            let Some(mut cursor) = self.cursors.remove(&path) else {
                continue;
            };
            let result = fs::metadata(&path).and_then(|metadata| {
                if cursor.recovering_until.is_some()
                    || cursor.offset != metadata.len()
                    || cursor.created != metadata.created().ok()
                    || cursor.modified != metadata.modified().ok()
                {
                    self.read_file(&path, &mut cursor)?;
                }
                Ok(())
            });
            match result {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    continue;
                }
                Err(_) => {
                    failed = true;
                    self.set_issue(
                        "部分会话读取失败，正在重试 / Some sessions could not be read; retrying",
                    );
                }
                Ok(()) => {}
            }
            self.cursors.insert(path, cursor);
        }
        if !failed
            && !self.scan_failed
            && self
                .issue
                .as_ref()
                .is_some_and(|v| v.starts_with("部分会话"))
        {
            self.issue = None;
            self.store.changed = true;
        }
    }

    fn read_file(&mut self, path: &Path, cursor: &mut Cursor) -> io::Result<()> {
        let mut file = File::open(path)?;
        let metadata = file.metadata()?;
        if file_id(&file)? != cursor.file_id || metadata.len() < cursor.offset {
            *cursor = Cursor::new(&file, &metadata, 0, false, None)?;
        }
        cursor.created = metadata.created().ok();
        cursor.modified = metadata.modified().ok();
        if cursor.baseline {
            if cursor.offset > 0 {
                file.seek(SeekFrom::Start(cursor.offset - 1))?;
                let mut byte = [0];
                file.read_exact(&mut byte)?;
                cursor.skipping = byte[0] != b'\n';
            }
            cursor.baseline = false;
        }
        if cursor.session.is_none() {
            file.seek(SeekFrom::Start(0))?;
            let mut header = Vec::new();
            BufReader::new(&mut file)
                .take(MAX_LINE as u64 + 1)
                .read_until(b'\n', &mut header)?;
            if header.last() != Some(&b'\n') || header.len() > MAX_LINE {
                return Ok(());
            }
            cursor.session = serde_json::from_slice::<Value>(&header)
                .ok()
                .and_then(|v| task_events::session(&v));
            if cursor.session.is_none() {
                cursor.offset = metadata.len();
                cursor.recovering_until = None;
                cursor.recovered.clear();
                return Ok(());
            }
        }
        let session = cursor.session.as_ref().unwrap();
        if self.store.removed.contains_key(&session.thread_id) {
            cursor.offset = metadata.len();
            cursor.pending.clear();
            cursor.skipping = false;
            cursor.recovering_until = None;
            cursor.recovered.clear();
            return Ok(());
        }
        self.store.restore_active(&session.thread_id);
        let end = metadata
            .len()
            .min(cursor.offset.saturating_add(8 * MAX_LINE as u64));
        file.seek(SeekFrom::Start(cursor.offset))?;
        while cursor.offset < end {
            let length = (end - cursor.offset).min(256 * 1024) as usize;
            let mut buffer = vec![0; length];
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            buffer.truncate(read);
            cursor.offset += read as u64;
            let mut data = std::mem::take(&mut cursor.pending);
            data.extend_from_slice(&buffer);
            let mut start = 0;
            for (newline, _) in data.iter().enumerate().filter(|(_, byte)| **byte == b'\n') {
                if !cursor.skipping && newline - start <= MAX_LINE {
                    if let Ok(value) = serde_json::from_slice::<Value>(&data[start..newline]) {
                        let position = cursor.offset - data.len() as u64 + newline as u64 + 1;
                        let notify = cursor.recovering_until.is_none_or(|until| position > until);
                        self.store
                            .consume(&value, session, notify, &mut cursor.recovered);
                    }
                }
                cursor.skipping = false;
                start = newline + 1;
            }
            cursor.pending = data[start..].to_vec();
            if cursor.pending.len() > MAX_LINE || cursor.skipping {
                cursor.pending.clear();
                cursor.skipping = true;
            }
        }
        if cursor
            .recovering_until
            .is_some_and(|until| cursor.offset >= until)
        {
            cursor.recovering_until = None;
            cursor.recovered.clear();
        }
        Ok(())
    }

    fn read_titles(&mut self) {
        if self.store.tasks.is_empty() {
            return;
        }
        let Some(parent) = self.root.parent() else {
            return;
        };
        let read = || -> io::Result<Vec<u8>> {
            let mut file = File::open(parent.join("session_index.jsonl"))?;
            let offset = file.metadata()?.len().saturating_sub(MAX_LINE as u64);
            file.seek(SeekFrom::Start(offset))?;
            let mut bytes = Vec::new();
            file.take(MAX_LINE as u64).read_to_end(&mut bytes)?;
            if offset > 0 {
                if let Some(index) = bytes.iter().position(|b| *b == b'\n') {
                    bytes.drain(..=index);
                } else {
                    bytes.clear();
                }
            }
            Ok(bytes)
        };
        let Ok(bytes) = read() else {
            return;
        };
        let mut titles = HashMap::new();
        for line in bytes.split(|b| *b == b'\n') {
            if let Ok(value) = serde_json::from_slice::<Value>(line) {
                if let (Some(id), Some(title)) =
                    (value["id"].as_str(), value["thread_name"].as_str())
                {
                    let title = task_events::brief(title, 160);
                    if !title.is_empty() {
                        titles.insert(id.to_owned(), title);
                    }
                }
            }
        }
        for task in self.store.tasks.values_mut() {
            if let Some(title) = titles.get(&task.thread_id) {
                if task.title.as_ref() != Some(title) {
                    task.title = Some(title.clone());
                    self.store.changed = true;
                }
            }
        }
    }

    fn snapshot(&self) -> Snapshot {
        let mut sessions: HashMap<String, Task> = HashMap::new();
        for task in self
            .store
            .tasks
            .values()
            .filter(|task| !self.store.removed.contains_key(&task.thread_id))
        {
            if sessions
                .get(task.thread_id.as_str())
                .is_none_or(|previous| task.updated_at >= previous.updated_at)
            {
                let mut task = task.clone();
                task.muted = self.store.muted.contains(&task.thread_id);
                sessions.insert(task.thread_id.clone(), task);
            }
        }
        let mut tasks: Vec<_> = sessions.into_values().collect();
        tasks.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let mut removed: Vec<_> = self
            .store
            .removed
            .iter()
            .map(|(id, title)| RemovedTask {
                thread_id: id.clone(),
                title: title.clone(),
            })
            .collect();
        removed.sort_by(|a, b| a.thread_id.cmp(&b.thread_id));
        let issues: Vec<_> = self
            .issue
            .iter()
            .chain(self.notification_issue.iter())
            .cloned()
            .collect();
        Snapshot {
            tasks,
            monitoring: self.active,
            removed,
            issue: (!issues.is_empty()).then(|| issues.join("\n")),
        }
    }

    fn publish(
        &mut self,
        app: &tauri::AppHandle,
        snapshot: &Mutex<Snapshot>,
    ) -> Result<(), String> {
        self.read_titles();
        let mut history: Vec<_> = self
            .store
            .tasks
            .values()
            .filter(|t| self.store.active.get(&t.thread_id) != Some(&t.id) || t.status == "unknown")
            .map(|t| (t.id.clone(), t.updated_at.clone()))
            .collect();
        history.sort_by(|a, b| b.1.cmp(&a.1));
        for (id, _) in history.into_iter().skip(200) {
            self.store.tasks.remove(&id);
        }
        self.store
            .active
            .retain(|_, id| self.store.tasks.contains_key(id));
        let mut notifications: HashMap<_, _> = std::mem::take(&mut self.store.notifications)
            .into_iter()
            .map(|task| (task.id.clone(), task))
            .collect();
        notifications.retain(|_, task| {
            !self.store.muted.contains(&task.thread_id)
                && !self.store.removed.contains_key(&task.thread_id)
                && (task.status != "waiting_input"
                    || (self.store.active.get(&task.thread_id) == Some(&task.id)
                        && self
                            .store
                            .tasks
                            .get(&task.id)
                            .is_some_and(|v| v.status == "waiting_input")))
        });
        let mut notifications: Vec<_> = notifications
            .into_values()
            .map(|task| {
                if task.status == "waiting_input" {
                    self.store.tasks.get(&task.id).cloned().unwrap_or(task)
                } else {
                    task
                }
            })
            .collect();
        notifications.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
        self.store.changed = false;
        let saved = self.save();
        if let Err(error) = &saved {
            self.issue = Some(error.clone());
        }
        let value = self.snapshot();
        *snapshot.lock().unwrap() = value.clone();
        crate::update_tasks(app, value, notifications);
        saved
    }

    fn save(&mut self) -> Result<(), String> {
        if !self.can_persist {
            return Ok(());
        }
        let value = json!({ "tasks": self.store.tasks.values().collect::<Vec<_>>(), "muted": self.store.muted, "removed": self.snapshot().removed });
        let bytes = serde_json::to_vec(&value)
            .map_err(|_| "无法序列化任务记录 / Could not serialize task history")?;
        if let Some(parent) = self.state_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "无法创建任务记录目录 / Could not create task history directory")?;
        }
        let temporary = self.state_file.with_extension("json.tmp");
        fs::write(&temporary, bytes)
            .and_then(|_| fs::rename(temporary, &self.state_file))
            .map_err(|_| "任务记录未保存 / Could not save task history")?;
        if self
            .issue
            .as_ref()
            .is_some_and(|v| v.starts_with("任务记录未保存"))
        {
            self.issue = None;
        }
        Ok(())
    }

    fn set_issue(&mut self, message: &str) {
        if self.issue.as_deref() != Some(message) {
            self.issue = Some(message.into());
            self.store.changed = true;
        }
    }
}

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_files(&entry.path(), files)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "jsonl") {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn load_task(value: &Value) -> Option<Task> {
    let thread = value["threadId"].as_str()?;
    let turn = value["turnId"].as_str()?;
    let cwd = value["cwd"].as_str()?;
    let status = value["status"].as_str()?;
    let client = value["client"].as_str()?;
    if !task_events::valid_id(thread)
        || !task_events::valid_id(turn)
        || value["id"] != format!("{thread}:{turn}")
        || cwd.len() > 4096
        || ![
            "running",
            "waiting_input",
            "completed",
            "interrupted",
            "unknown",
        ]
        .contains(&status)
        || !["vscode", "cli", "unknown"].contains(&client)
    {
        return None;
    }
    let questions = value["pendingQuestions"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let call_id = row["callId"].as_str()?;
                    let text = row["text"].as_str()?;
                    if call_id.len() > 200 || text.chars().count() > 220 {
                        return None;
                    }
                    Some(Question {
                        call_id: call_id.into(),
                        text: text.into(),
                        asynchronous: row["asynchronous"].as_bool()?,
                    })
                })
                .take(20)
                .collect()
        })
        .unwrap_or_default();
    Some(Task {
        id: format!("{thread}:{turn}"),
        thread_id: thread.into(),
        turn_id: turn.into(),
        cwd: cwd.into(),
        client: client.into(),
        status: if status == "running" {
            "unknown".into()
        } else {
            status.into()
        },
        updated_at: task_events::timestamp(value["updatedAt"].as_str()?)?,
        title: value["title"]
            .as_str()
            .map(|v| v.chars().take(160).collect()),
        started_at: value["startedAt"].as_str().and_then(task_events::timestamp),
        duration_ms: value["durationMs"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0),
        request_summary: value["requestSummary"]
            .as_str()
            .map(|v| v.chars().take(220).collect()),
        pending_questions: questions,
        ended_at: value["endedAt"].as_str().and_then(task_events::timestamp),
        muted: false,
    })
}

#[cfg(windows)]
fn file_id(file: &File) -> io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber as u64,
        (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64,
    ))
}

#[cfg(unix)]
fn file_id(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}
