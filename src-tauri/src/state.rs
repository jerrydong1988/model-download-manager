//! 应用状态：设置、任务表、任务控制标志、调度通知、全局限速器、HTTP client。
//!
//! 这里只提供同步的、短临界区的状态操作；异步流程（调度/下载）不在此模块。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::models::{DownloadTask, Settings, Source, TaskStatus};
use crate::util::{self, BandwidthLimiter};

/// 校验结束后的界面回调。由桌面层注册；下载引擎本身不依赖托盘或通知插件。
pub type VerifyReport = Arc<dyn Fn(&DownloadTask, bool) + Send + Sync>;

fn next_task_sequence() -> u64 {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1
}

/// `tasks.json` 持久化格式。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTasks {
    pub version: u32,
    pub tasks: Vec<DownloadTask>,
}

impl PersistedTasks {
    pub const CURRENT_VERSION: u32 = 1;

    pub fn new(tasks: Vec<DownloadTask>) -> Self {
        Self {
            version: Self::CURRENT_VERSION,
            tasks,
        }
    }
}

/// 带前置状态校验的状态迁移结果（避免暂停/取消与下载完成互相覆盖）。
#[derive(Debug, Clone)]
pub enum TransitionOutcome {
    /// 前置状态匹配，已应用更新（返回更新后的任务快照）。
    Updated(DownloadTask),
    /// 前置状态不匹配（并发已被其他迁移改变），未做任何修改。
    Conflict(DownloadTask),
    /// 任务不存在。
    Missing,
}

/// 单任务控制标志：下载循环每块检查。
#[derive(Debug, Default)]
pub struct TaskControl {
    pub cancelled: AtomicBool,
    pub paused: AtomicBool,
    /// 取消时是否删除 `.part` / `.part.json`。
    pub delete_partial: AtomicBool,
}

impl TaskControl {
    /// Poll flags while an HTTP read, request, or limiter is awaiting; all workers see the flags.
    pub async fn stopped(&self) {
        while !self.is_cancelled() && !self.is_paused() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// 置取消标志；`delete_partial` 决定下载循环退出后是否清理临时文件。
    pub fn cancel(&self, delete_partial: bool) {
        self.delete_partial.store(delete_partial, Ordering::SeqCst);
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn should_delete_partial(&self) -> bool {
        self.delete_partial.load(Ordering::SeqCst)
    }

    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.delete_partial.store(false, Ordering::SeqCst);
    }
}

/// 全局应用状态（`tauri::Builder::manage` 注册）。
pub struct AppState {
    /// Serialize enqueue validation and insertion, including physical output-path ownership.
    pub enqueue_lock: Mutex<()>,
    /// 应用数据目录（settings.json / tasks.json 所在）。
    pub data_dir: PathBuf,
    settings: RwLock<Settings>,
    tasks: Mutex<Vec<DownloadTask>>,
    controls: Mutex<HashMap<String, Arc<TaskControl>>>,
    client: RwLock<reqwest::Client>,
    /// 全局字节级限速器（设置变更立即生效）。
    pub limiter: Arc<BandwidthLimiter>,
    /// 调度泵唤醒信号。
    pub scheduler: Notify,
    /// 任务/设置是否有未落盘变更。
    dirty: AtomicBool,
    /// 是否有终态变更需要立即落盘。
    terminal_dirty: AtomicBool,
    /// 校验完成后再通知界面。测试不注册，因此不会链上托盘代码。
    verify_report: Mutex<Option<VerifyReport>>,
}

impl AppState {
    /// 构造状态。client 构建失败时回退默认 client（设置文件可能在启动时不可用）。
    pub fn new(settings: Settings, data_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);
        let _ = std::fs::create_dir_all(&settings.download_dir);
        let client = util::build_http_client(&settings).unwrap_or_else(|err| {
            eprintln!("初始化 HTTP 客户端失败，使用默认配置：{err}");
            reqwest::Client::new()
        });
        let limiter = Arc::new(BandwidthLimiter::new(settings.bandwidth_limit));
        Self {
            enqueue_lock: Mutex::new(()),
            data_dir,
            settings: RwLock::new(settings),
            tasks: Mutex::new(Vec::new()),
            controls: Mutex::new(HashMap::new()),
            client: RwLock::new(client),
            limiter,
            scheduler: Notify::new(),
            dirty: AtomicBool::new(false),
            terminal_dirty: AtomicBool::new(false),
            verify_report: Mutex::new(None),
        }
    }

    /// 桌面层注册校验完成回调。后注册的覆盖先前的。
    pub fn set_verify_report(&self, report: VerifyReport) {
        *self
            .verify_report
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(report);
    }

    /// 把校验后的任务交给已注册回调。没有回调时只保留任务状态。
    pub fn report_verify(&self, task: &DownloadTask, notify_success: bool) {
        let guard = self
            .verify_report
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(report) = guard.as_ref() {
            report(task, notify_success);
        }
    }

    pub fn tasks_path(&self) -> PathBuf {
        self.data_dir.join("tasks.json")
    }

    pub fn settings_path(&self) -> PathBuf {
        crate::settings::settings_path(&self.data_dir)
    }

    // -- 设置 --------------------------------------------------------------

    /// 当前设置快照。
    pub fn current_settings(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// 当前 HTTP client 克隆（reqwest::Client 内部为 Arc，克隆廉价）。
    pub fn current_client(&self) -> reqwest::Client {
        self.client
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// 校验、持久化并应用设置；返回生效值。
    pub fn save_settings(&self, settings: Settings) -> Result<Settings, String> {
        let effective = crate::settings::validate_and_clamp(settings)?;
        // 先用新设置重建 client，失败则不落盘、不生效。
        let client = util::build_http_client(&effective)?;
        crate::settings::save(&self.data_dir, &effective)?;
        self.limiter.set_rate(effective.bandwidth_limit);
        {
            let mut guard = self
                .settings
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = effective.clone();
        }
        {
            let mut guard = self
                .client
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = client;
        }
        Ok(effective)
    }

    // -- 任务表 ------------------------------------------------------------

    fn tasks_guard(&self) -> MutexGuard<'_, Vec<DownloadTask>> {
        self.tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 任务列表快照（按加入时间升序）。
    pub fn tasks_snapshot(&self) -> Vec<DownloadTask> {
        let mut tasks = self.tasks_guard().clone();
        tasks.sort_by_key(|task| task.added_at);
        tasks
    }

    pub fn get_task(&self, task_id: &str) -> Option<DownloadTask> {
        self.tasks_guard()
            .iter()
            .find(|task| task.task_id == task_id)
            .cloned()
    }

    /// 找到「来源 + 仓库 + 远端路径 + revision + 最终路径」完全相同的已有任务（用于去重）。
    ///
    /// 契约要求去重键包含 source 与 revision。
    pub fn find_duplicate_task(
        &self,
        source: Source,
        repo_id: &str,
        remote_path: &str,
        revision: &str,
        save_path: &str,
    ) -> Option<DownloadTask> {
        self.tasks_guard()
            .iter()
            .find(|task| {
                task.source == source
                    && task.repo_id == repo_id
                    && task.remote_path == remote_path
                    && task.revision == revision
                    && task.save_path == save_path
            })
            .cloned()
    }

    /// 当前正在占用并发槽的任务数（active / pausing）。
    pub fn running_count(&self) -> usize {
        self.tasks_guard()
            .iter()
            .filter(|task| task.status.is_running())
            .count()
    }

    pub fn insert_tasks(&self, tasks: Vec<DownloadTask>) {
        if tasks.is_empty() {
            return;
        }
        {
            let mut guard = self.tasks_guard();
            guard.extend(tasks);
        }
        self.mark_dirty(false);
    }

    pub fn update_task<F>(&self, task_id: &str, update: F) -> Option<DownloadTask>
    where
        F: FnOnce(&mut DownloadTask),
    {
        let updated = {
            let mut guard = self.tasks_guard();
            let task = guard.iter_mut().find(|task| task.task_id == task_id)?;
            update(task);
            task.update_seq = next_task_sequence();
            task.clone()
        };
        self.mark_dirty(false);
        Some(updated)
    }

    /// 带前置状态校验的原子更新（CAS）：仅当当前状态 ∈ `expected` 时应用 `update`。
    ///
    /// 用于消除暂停/取消/完成并发时的覆盖竞态（P1-1）：
    /// 冲突时**不修改任务**，由调用方决定丢弃或重试，避免任务卡在 `pausing` 等中间态。
    pub fn transition_task<F>(
        &self,
        task_id: &str,
        expected: &[TaskStatus],
        update: F,
    ) -> TransitionOutcome
    where
        F: FnOnce(&mut DownloadTask),
    {
        let outcome = {
            let mut guard = self.tasks_guard();
            match guard.iter_mut().find(|task| task.task_id == task_id) {
                None => TransitionOutcome::Missing,
                Some(task) => {
                    if !expected.contains(&task.status) {
                        TransitionOutcome::Conflict(task.clone())
                    } else {
                        update(task);
                        task.update_seq = next_task_sequence();
                        TransitionOutcome::Updated(task.clone())
                    }
                }
            }
        };
        if matches!(outcome, TransitionOutcome::Updated(_)) {
            self.mark_dirty(false);
        }
        outcome
    }

    /// 删除任务记录，返回实际删除的 taskId 列表。
    pub fn remove_tasks(&self, task_ids: &[String]) -> Vec<String> {
        let mut removed = Vec::new();
        {
            let mut guard = self.tasks_guard();
            guard.retain(|task| {
                let matched = task_ids.iter().any(|id| id == &task.task_id);
                if matched {
                    removed.push(task.task_id.clone());
                    false
                } else {
                    true
                }
            });
        }
        if !removed.is_empty() {
            self.mark_dirty(false);
        }
        removed
    }

    /// 下一个可启动的 queued 任务（按加入时间 FIFO）。
    pub fn next_queued_task(&self) -> Option<DownloadTask> {
        let guard = self.tasks_guard();
        guard
            .iter()
            .filter(|task| task.status == crate::models::TaskStatus::Queued)
            .min_by_key(|task| task.added_at)
            .cloned()
    }

    // -- 控制标志 ----------------------------------------------------------

    /// 取得任务控制标志（不存在则创建）。
    pub fn control_for(&self, task_id: &str) -> Arc<TaskControl> {
        let mut guard = self
            .controls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .entry(task_id.to_string())
            .or_insert_with(TaskControl::new)
            .clone()
    }

    /// 取得已有控制标志（不创建）。
    pub fn get_control(&self, task_id: &str) -> Option<Arc<TaskControl>> {
        self.controls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(task_id)
            .cloned()
    }

    /// 覆盖任务控制标志（队列启动任务时使用）。
    pub fn set_control(&self, task_id: &str, control: Arc<TaskControl>) {
        self.controls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(task_id.to_string(), control);
    }

    /// 移除控制标志（任务结束/删除时）。
    pub fn remove_control(&self, task_id: &str) {
        self.controls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(task_id);
    }

    // -- 持久化 ------------------------------------------------------------

    /// 标记有未落盘变更；`terminal = true` 表示需尽快落盘。
    pub fn mark_dirty(&self, terminal: bool) {
        self.dirty.store(true, Ordering::SeqCst);
        if terminal {
            self.terminal_dirty.store(true, Ordering::SeqCst);
        }
    }

    /// 是否需要立即落盘（终态变更）。
    pub fn take_terminal_dirty(&self) -> bool {
        self.terminal_dirty.swap(false, Ordering::SeqCst)
    }

    /// 是否有任意未落盘变更。
    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::SeqCst)
    }

    /// 落盘 tasks.json（原子写）。
    pub fn persist_tasks(&self) -> Result<(), String> {
        let tasks = self.tasks_snapshot();
        util::atomic_write_json(&self.tasks_path(), &PersistedTasks::new(tasks))?;
        self.dirty.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// 启动恢复：载入 tasks.json 并应用恢复规则。
    ///
    /// - `active` / `pausing` → `paused`；
    /// - `queued` 在 `autoResume == false` 时 → `paused`；
    /// - 终态与已暂停任务保持不变；速度清零。
    pub fn load_persisted_tasks(&self) -> Vec<DownloadTask> {
        let path = self.tasks_path();
        let mut tasks: Vec<DownloadTask> = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<PersistedTasks>(&bytes) {
                Ok(persisted) => persisted.tasks,
                Err(err) => {
                    // P2c：损坏文件不静默清空，改名隔离保留可诊断性后以空列表启动。
                    eprintln!(
                        "警告：任务文件解析失败（{err}），将隔离该文件并以空任务列表启动：{}",
                        path.display()
                    );
                    quarantine_corrupt_tasks_file(&path);
                    Vec::new()
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => {
                eprintln!("警告：任务文件读取失败（{err}）：{}", path.display());
                Vec::new()
            }
        };

        let auto_resume = self.current_settings().auto_resume;
        for task in &mut tasks {
            task.update_seq = 0;
            task.speed = 0;
            match task.status {
                crate::models::TaskStatus::Active | crate::models::TaskStatus::Pausing => {
                    task.status = crate::models::TaskStatus::Paused;
                }
                crate::models::TaskStatus::Queued if !auto_resume => {
                    task.status = crate::models::TaskStatus::Paused;
                }
                _ => {}
            }
        }
        tasks.sort_by_key(|task| task.added_at);
        tasks
    }

    /// 安装已恢复的任务并立即落盘。
    pub fn install_recovered_tasks(&self, tasks: Vec<DownloadTask>) -> Result<(), String> {
        {
            let mut guard = self.tasks_guard();
            guard.clear();
            guard.extend(tasks);
        }
        self.persist_tasks()
    }
}

/// 把损坏的 `tasks.json` 改名为 `tasks.corrupt-<毫秒>.json`（保留现场便于诊断）。
fn quarantine_corrupt_tasks_file(path: &std::path::Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let target = parent.join(format!("tasks.corrupt-{}.json", util::now_millis()));
    match std::fs::rename(path, &target) {
        Ok(()) => {
            eprintln!("警告：损坏的任务文件已隔离为：{}", target.display());
            Some(target)
        }
        Err(err) => {
            eprintln!("警告：无法隔离损坏的任务文件（{err}）：{}", path.display());
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Settings, TaskStatus};

    fn unique_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mdm-state-test-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_state() -> (Arc<AppState>, PathBuf) {
        let dir = unique_dir("corrupt");
        let mut settings = Settings::default();
        settings.download_dir = dir.join("models").to_string_lossy().into_owned();
        settings.auto_resume = true;
        let state = Arc::new(AppState::new(settings, dir.join("appdata")));
        (state, dir)
    }

    fn sample_task(status: TaskStatus) -> DownloadTask {
        DownloadTask {
            update_seq: 0,
            task_id: "t1".to_string(),
            source: Source::Huggingface,
            repo_id: "org/model".to_string(),
            remote_path: "w.bin".to_string(),
            file_name: "w.bin".to_string(),
            save_path: "C:\\Models\\org\\model\\w.bin".to_string(),
            temp_path: "C:\\Models\\org\\model\\w.bin.part".to_string(),
            total_size: 10,
            downloaded: 1,
            status,
            speed: 0,
            error: None,
            retries: 0,
            revision: "main".to_string(),
            added_at: 1,
            completed_at: None,
            etag: None,
            last_modified: None,
            sha256: None,
            verify_status: crate::models::VerifyStatus::Unavailable,
        }
    }

    #[test]
    fn corrupt_tasks_file_is_quarantined() {
        let (state, dir) = sample_state();
        std::fs::write(state.tasks_path(), b"{ this is not valid json").unwrap();

        let tasks = state.load_persisted_tasks();
        assert!(tasks.is_empty(), "损坏文件应以空任务列表启动");
        assert!(!state.tasks_path().exists(), "损坏文件应被改名隔离");
        let quarantined: Vec<_> = std::fs::read_dir(&state.data_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("tasks.corrupt-")
            })
            .collect();
        assert_eq!(quarantined.len(), 1, "应生成 1 个隔离文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transition_task_rejects_stale_expected_status() {
        let (state, dir) = sample_state();
        state.insert_tasks(vec![sample_task(TaskStatus::Paused)]);

        // paused 任务不能被当作 queued 启动。
        let outcome = state.transition_task("t1", &[TaskStatus::Queued], |task| {
            task.status = TaskStatus::Active;
        });
        assert!(
            matches!(outcome, TransitionOutcome::Conflict(ref task) if task.status == TaskStatus::Paused),
            "前置状态不匹配时必须冲突且不修改任务"
        );
        assert_eq!(state.get_task("t1").unwrap().status, TaskStatus::Paused);

        // 前置状态匹配时正常迁移。
        let outcome = state.transition_task("t1", &[TaskStatus::Paused], |task| {
            task.status = TaskStatus::Queued;
        });
        assert!(matches!(outcome, TransitionOutcome::Updated(_)));
        assert_eq!(state.get_task("t1").unwrap().status, TaskStatus::Queued);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
