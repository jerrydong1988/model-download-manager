//! 队列调度：FIFO 调度泵、并发上限、暂停/继续/取消/重试/清理、持久化与启动恢复。
//!
//! 契约 §5.3–§5.6：
//! - 全局并发 = `settings.concurrency`，队列 FIFO；
//! - 每 2 秒或在状态进入终态时原子写 `tasks.json`；
//! - 暂停：active → pausing → paused（下载循环检查标志后收尾），queued → paused；
//! - 取消：active 任务由下载循环收尾为 cancelled，其余状态立即置 cancelled；
//! - 启动恢复：active/pausing → paused；autoResume=false 时 queued → paused。

use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(not(test))]
use std::time::{Duration, Instant};

#[cfg(not(test))]
use crate::download::{self, TransferContext};
use crate::download::{read_part_progress, DownloadError, TransferOutcome};
use crate::models::{DownloadRequest, DownloadTask, TaskStatus, VerifyStatus};
#[cfg(not(test))]
use crate::sources;
use crate::state::{AppState, TaskControl, TransitionOutcome};
use crate::util::{self, EventSink};

/// tasks.json 落盘间隔。
#[cfg(not(test))]
pub const PERSIST_INTERVAL: Duration = Duration::from_secs(2);
/// 调度泵轮询间隔（通知之外的兜底）。
#[cfg(not(test))]
const PUMP_TICK: Duration = Duration::from_millis(500);

// ---------------------------------------------------------------------------
// 事件 sink：转发到前端，并把进度同步进任务表（仅非单元测试构建编译）
// ---------------------------------------------------------------------------

#[cfg(not(test))]
struct QueueSink {
    app: tauri::AppHandle,
    state: Arc<AppState>,
}

#[cfg(not(test))]
impl EventSink for QueueSink {
    fn emit(&self, event: &str, mut payload: serde_json::Value) {
        use tauri::Emitter;

        if event == "download-progress" {
            let task_id = payload.get("taskId").and_then(|value| value.as_str());
            let downloaded = payload.get("downloaded").and_then(|value| value.as_u64());
            let total_size = payload.get("totalSize").and_then(|value| value.as_u64());
            let speed = payload.get("speed").and_then(|value| value.as_u64());
            if let (Some(task_id), Some(downloaded), Some(total_size), Some(speed)) =
                (task_id, downloaded, total_size, speed)
            {
                let updated = self.state.update_task(task_id, |task| {
                    task.downloaded = downloaded;
                    if total_size > 0 {
                        task.total_size = total_size;
                    }
                    task.speed = speed;
                });
                if let Some(task) = updated {
                    payload["updateSeq"] = serde_json::json!(task.update_seq);
                }
            }
        }
        if let Err(err) = self.app.emit(event, payload) {
            eprintln!("发送事件 {event} 失败：{err}");
        }
    }

    fn app_handle(&self) -> Option<&tauri::AppHandle> {
        Some(&self.app)
    }
}

/// v0.1.3：任务终态时按设置发送系统通知（发送失败不影响队列）。
#[cfg(not(test))]
fn notify_terminal(
    sink: &dyn EventSink,
    state: &Arc<AppState>,
    task: &DownloadTask,
    error: Option<&str>,
) {
    if !state.current_settings().notifications_enabled {
        return;
    }
    let Some(app) = sink.app_handle() else {
        return;
    };
    match error {
        Some(error) => crate::notifications::notify_failed(app, task, error),
        None => crate::notifications::notify_completed(app, task),
    }
}

fn normalized_sha(raw: Option<&str>) -> Option<String> {
    raw.and_then(crate::integrity::normalize_sha256)
}

struct VerifyJob {
    state: Arc<AppState>,
    task_id: String,
    save_path: String,
    expected: String,
    notify_success: bool,
}

/// 改名之后比对 sha256。不一致则把任务改为失败，并删除损坏文件，避免按大小被当成已完成。
fn apply_verify_outcome(
    state: &Arc<AppState>,
    task_id: &str,
    save_path: &str,
    outcome: crate::integrity::ContentCheck,
) -> Option<DownloadTask> {
    let updated = match outcome {
        crate::integrity::ContentCheck::Match => {
            state.transition_task(task_id, &[TaskStatus::Completed], |task| {
                task.verify_status = VerifyStatus::Verified;
                task.error = None;
            })
        }
        crate::integrity::ContentCheck::Mismatch { actual } => {
            let expected = state
                .get_task(task_id)
                .and_then(|task| task.sha256)
                .unwrap_or_default();
            let message = format!(
                "文件校验不一致（期望 {expected}，实际 {actual}）。已删除损坏文件，可重试下载。"
            );
            let updated = state.transition_task(task_id, &[TaskStatus::Completed], |task| {
                task.status = TaskStatus::Error;
                task.verify_status = VerifyStatus::Mismatch;
                task.speed = 0;
                task.error = Some(message);
            });
            if matches!(updated, TransitionOutcome::Updated(_)) {
                let _ = std::fs::remove_file(save_path);
            }
            updated
        }
        crate::integrity::ContentCheck::Unreadable { message } => {
            state.transition_task(task_id, &[TaskStatus::Completed], |task| {
                task.status = TaskStatus::Error;
                task.verify_status = VerifyStatus::Unavailable;
                task.speed = 0;
                task.error = Some(format!("下载已写入，但无法校验文件：{message}"));
            })
        }
    };
    match updated {
        TransitionOutcome::Updated(task) => {
            state.mark_dirty(true);
            Some(task)
        }
        TransitionOutcome::Conflict(_) | TransitionOutcome::Missing => None,
    }
}

fn schedule_content_verify(job: VerifyJob) {
    let work = move || {
        let outcome = crate::integrity::check_file(Path::new(&job.save_path), &job.expected);
        let Some(task) = apply_verify_outcome(&job.state, &job.task_id, &job.save_path, outcome) else {
            return;
        };
        job.state.report_verify(&task, job.notify_success);
    };
    #[cfg(test)]
    work();
    #[cfg(not(test))]
    {
        if let Err(error) = std::thread::Builder::new().name("mdm-verify".into()).spawn(work) {
            eprintln!("无法启动文件校验线程：{error}");
        }
    }
}

// ---------------------------------------------------------------------------
// 启动恢复 + 调度泵
// ---------------------------------------------------------------------------

/// 启动恢复：载入 tasks.json、应用恢复规则并落盘（不修改 tauri 状态）。
pub fn recover(state: &Arc<AppState>) -> Result<(), String> {
    let mut tasks = state.load_persisted_tasks();
    // v0.2.0：旧 tasks.json 缺少 revision 时按来源默认值补齐。
    for task in &mut tasks {
        if task.revision.trim().is_empty() {
            task.revision = task.source.default_revision().to_string();
        }
    }
    state.install_recovered_tasks(tasks)
}

/// 启动调度泵（`setup` 中调用）。
#[cfg(not(test))]
pub fn spawn_pump(app: tauri::AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        pump_loop(app, state).await;
    });
}

#[cfg(not(test))]
async fn pump_loop(app: tauri::AppHandle, state: Arc<AppState>) {
    let mut last_persist = Instant::now();
    loop {
        let concurrency = state.current_settings().concurrency.clamp(1, 8) as usize;
        // 按 FIFO 填充并发槽。
        while state.running_count() < concurrency {
            let Some(task) = state.next_queued_task() else {
                break;
            };
            start_task(&app, &state, task);
        }

        // 持久化：终态立即落盘，其余每 2 秒一次。
        let terminal_dirty = state.take_terminal_dirty();
        if state.is_dirty() && (terminal_dirty || last_persist.elapsed() >= PERSIST_INTERVAL) {
            if let Err(err) = state.persist_tasks() {
                eprintln!("保存任务列表失败：{err}");
            }
            last_persist = Instant::now();
        }

        tokio::select! {
            _ = state.scheduler.notified() => {}
            _ = tokio::time::sleep(PUMP_TICK) => {}
        }
    }
}

/// 启动一个任务：置 active、构造传输上下文并 spawn 下载协程。
#[cfg(not(test))]
fn start_task(app: &tauri::AppHandle, state: &Arc<AppState>, task: DownloadTask) {
    let task_id = task.task_id.clone();
    // Old persisted queues may already contain aliases created by v0.2.0.
    if state.tasks_snapshot().iter().any(|other| {
        other.task_id != task_id
            && util::task_paths_conflict(Path::new(&other.save_path), Path::new(&task.save_path))
    }) {
        if let TransitionOutcome::Updated(task) =
            state.transition_task(&task_id, &[TaskStatus::Queued], |task| {
                task.status = TaskStatus::Error;
                task.error =
                    Some("目标路径与其他任务冲突，请清理冲突记录或改用其他下载目录".to_string());
            })
        {
            let sink = QueueSink {
                app: app.clone(),
                state: state.clone(),
            };
            util::emit_task_updated(&sink, &task);
            state.mark_dirty(true);
        }
        return;
    }
    let settings = state.current_settings();
    let part_path = PathBuf::from(&task.temp_path);
    let meta_path = util::with_suffix(&part_path, ".json");
    // v0.2.0：分段任务的 .part 已预分配为 total 长度，必须由元数据 chunks 计算已下载量。
    let part_progress = read_part_progress(&part_path, &meta_path);
    let total_size = if task.total_size > 0 {
        task.total_size
    } else {
        part_progress.total
    };
    let etag = part_progress.etag.clone().or_else(|| task.etag.clone());
    let last_modified = part_progress
        .last_modified
        .clone()
        .or_else(|| task.last_modified.clone());
    let downloaded = part_progress.downloaded;
    let revision = if task.revision.trim().is_empty() {
        task.source.default_revision().to_string()
    } else {
        task.revision.clone()
    };

    // 新一次运行使用全新的控制标志（清除上次的取消/暂停标记）。
    let control = state.control_for(&task_id);
    control.reset();
    state.set_control(&task_id, control.clone());

    // P1-1 CAS：仅 queued 任务可启动；与 pause/cancel 并发时丢弃本次启动，避免覆盖。
    let updated = match state.transition_task(&task_id, &[TaskStatus::Queued], |task| {
        task.status = TaskStatus::Active;
        task.downloaded = downloaded;
        task.total_size = total_size;
        task.speed = 0;
        task.error = None;
        task.completed_at = None;
        task.revision = revision.clone();
    }) {
        TransitionOutcome::Updated(task) => task,
        _ => {
            state.remove_control(&task_id);
            return;
        }
    };
    {
        let sink = QueueSink {
            app: app.clone(),
            state: state.clone(),
        };
        util::emit_task_updated(&sink, &updated);
    }

    let url = sources::download_url(
        &settings,
        task.source,
        &task.repo_id,
        &revision,
        &task.remote_path,
    );

    // P1-2：重试发生时把累计次数回写任务表并推送 task-updated。
    let retry_state = state.clone();
    let retry_app = app.clone();
    let retry_task_id = task_id.clone();
    let on_retry: download::RetryCallback = Arc::new(move |retries: u32| {
        if let Some(task) = retry_state.update_task(&retry_task_id, |task| task.retries = retries) {
            let sink = QueueSink {
                app: retry_app.clone(),
                state: retry_state.clone(),
            };
            util::emit_task_updated(&sink, &task);
        }
    });

    let context = TransferContext {
        task_id: task_id.clone(),
        repo_id: task.repo_id.clone(),
        remote_path: task.remote_path.clone(),
        client: state.current_client(),
        url,
        source: task.source,
        auth_token: sources::auth_token(&settings, task.source),
        save_path: PathBuf::from(&task.save_path),
        part_path,
        meta_path,
        total_size,
        etag,
        last_modified,
        max_retries: settings.max_retries,
        limiter: state.limiter.clone(),
        control,
        on_retry: Some(on_retry),
        connections: settings.connections_per_file.clamp(1, 8),
        chunk_size_override: None,
    };

    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let sink = QueueSink {
            app: app.clone(),
            state: state.clone(),
        };
        let result = download::transfer_auto(context, &sink).await;
        finish_task(&state, &sink, &task_id, result);
        // 释放并发槽后唤醒调度泵。
        state.scheduler.notify_one();
    });
}

/// 下载协程结束后的状态收尾（完成 / 暂停 / 取消 / 失败）。
///
/// P1-1：所有迁移均以 `[Active, Pausing] → 终态` 的 CAS 执行；暂停/取消与完成并发时
/// 不再互相覆盖，避免任务卡在 `pausing`。取消意图优先于暂停/失败结果。
fn finish_task(
    state: &Arc<AppState>,
    sink: &dyn EventSink,
    task_id: &str,
    result: Result<TransferOutcome, DownloadError>,
) {
    let Some(current) = state.get_task(task_id) else {
        // 任务记录已被删除（例如 remove_tasks 竞态）→ 只清理控制标志。
        state.remove_control(task_id);
        return;
    };
    let control = state.get_control(task_id);
    let cancelled = control
        .as_ref()
        .map(|control| control.is_cancelled())
        .unwrap_or(false);
    let delete_partial = control
        .as_ref()
        .map(|control| control.should_delete_partial())
        .unwrap_or(false);

    // 取消优先：暂停/失败结果若已请求取消，统一按取消收尾。
    let outcome = match result {
        Ok(TransferOutcome::Paused {
            downloaded,
            total_size,
            ..
        }) if cancelled => Ok(TransferOutcome::Cancelled {
            downloaded,
            total_size,
        }),
        Err(_) if cancelled => {
            let meta_path = util::with_suffix(Path::new(&current.temp_path), ".json");
            let downloaded =
                read_part_progress(Path::new(&current.temp_path), &meta_path).downloaded;
            Ok(TransferOutcome::Cancelled {
                downloaded,
                total_size: current.total_size,
            })
        }
        other => other,
    };

    let expected = [TaskStatus::Active, TaskStatus::Pausing];

    match outcome {
        Ok(TransferOutcome::Completed {
            downloaded,
            total_size,
            etag,
            last_modified,
        }) => {
            let expected_sha = normalized_sha(current.sha256.as_deref());
            let updated = state.transition_task(task_id, &expected, |task| {
                task.status = TaskStatus::Completed;
                task.downloaded = downloaded;
                task.total_size = total_size;
                task.speed = 0;
                task.error = None;
                task.completed_at = Some(util::now_millis());
                task.etag = etag;
                task.last_modified = last_modified;
                task.verify_status = if expected_sha.is_some() {
                    VerifyStatus::Pending
                } else {
                    VerifyStatus::Unavailable
                };
            });
            let accepted = matches!(updated, TransitionOutcome::Updated(_));
            if let TransitionOutcome::Updated(task) = updated {
                util::emit_task_updated(sink, &task);
                // 没有校验和时立即通知完成。有校验和则先释放并发槽，再在后台比对。
                if expected_sha.is_none() {
                    #[cfg(not(test))]
                    notify_terminal(sink, state, &task, None);
                }
            }
            state.remove_control(task_id);
            state.mark_dirty(true);
            if accepted {
                if let Some(expected_sha) = expected_sha {
                    schedule_content_verify(VerifyJob {
                        state: state.clone(),
                        task_id: task_id.to_string(),
                        save_path: current.save_path.clone(),
                        expected: expected_sha,
                        notify_success: true,
                    });
                }
            }
        }
        Ok(TransferOutcome::Paused {
            downloaded,
            total_size,
            etag,
            last_modified,
        }) => {
            let updated = state.transition_task(task_id, &expected, |task| {
                task.status = TaskStatus::Paused;
                task.downloaded = downloaded;
                task.total_size = total_size;
                task.speed = 0;
                task.etag = etag;
                task.last_modified = last_modified;
            });
            if let TransitionOutcome::Updated(task) = updated {
                util::emit_task_updated(sink, &task);
            }
            state.remove_control(task_id);
            state.mark_dirty(false);
        }
        Ok(TransferOutcome::Cancelled {
            downloaded,
            total_size,
        }) => {
            let updated = state.transition_task(task_id, &expected, |task| {
                task.status = TaskStatus::Cancelled;
                task.downloaded = downloaded;
                task.total_size = total_size;
                task.speed = 0;
                task.error = None;
                task.completed_at = Some(util::now_millis());
            });
            if delete_partial {
                let paths = util::TaskPaths {
                    final_path: PathBuf::from(&current.save_path),
                    part_path: PathBuf::from(&current.temp_path),
                    meta_path: util::with_suffix(Path::new(&current.temp_path), ".json"),
                };
                util::remove_task_temp_files(&paths);
            }
            if let TransitionOutcome::Updated(task) = updated {
                util::emit_task_updated(sink, &task);
            }
            state.remove_control(task_id);
            state.mark_dirty(true);
        }
        Err(error) => {
            let meta_path = util::with_suffix(Path::new(&current.temp_path), ".json");
            let part_length =
                read_part_progress(Path::new(&current.temp_path), &meta_path).downloaded;
            let updated = state.transition_task(task_id, &expected, |task| {
                task.status = TaskStatus::Error;
                task.error = Some(error.message.clone());
                task.downloaded = part_length;
                task.speed = 0;
            });
            if let TransitionOutcome::Updated(task) = updated {
                util::emit_task_updated(sink, &task);
                // v0.1.3：下载失败系统通知（含简短且已脱敏的错误；单元测试构建不编译）。
                #[cfg(not(test))]
                notify_terminal(sink, state, &task, Some(&error.message));
            }
            state.remove_control(task_id);
            state.mark_dirty(true);
        }
    }
}

// ---------------------------------------------------------------------------
// 命令实现（薄命令层直接调用）
// ---------------------------------------------------------------------------

/// 命令 4：新建下载任务。
///
/// - 去重键 = `source + repoId + remotePath + 最终路径`（P2b：HF 与 MS 的同名仓库/文件
///   不互相去重）；
/// - P2a：逐条校验，非法项**跳过**（记录到 stderr 汇总）；仅当整批全部非法时返回首个
///   中文错误（前端 toast 可提示）。返回类型保持契约的 `DownloadTask[]`（只含新建任务）。
pub fn start_downloads(
    state: &Arc<AppState>,
    requests: Vec<DownloadRequest>,
    sink: &dyn EventSink,
) -> Result<Vec<DownloadTask>, String> {
    let _enqueue = state
        .enqueue_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    let mut created: Vec<DownloadTask> = Vec::new();
    let mut now = util::now_millis();
    let mut skipped_errors: Vec<String> = Vec::new();

    for request in requests {
        match build_task_from_request(state, &created, request, &mut now) {
            Ok(Some(task)) => created.push(task),
            Ok(None) => {}
            Err(err) => skipped_errors.push(err),
        }
    }

    if created.is_empty() {
        if let Some(first_error) = skipped_errors.first() {
            return Err(first_error.clone());
        }
        return Ok(created);
    }
    if !skipped_errors.is_empty() {
        eprintln!(
            "已跳过 {} 个非法下载请求，首个错误：{}",
            skipped_errors.len(),
            skipped_errors[0]
        );
    }
    let has_queued = created.iter().any(|task| task.status == TaskStatus::Queued);
    state.insert_tasks(created.clone());
    for task in &created {
        util::emit_task_updated(sink, task);
        if task.status == TaskStatus::Completed {
            if let Some(expected) = task.sha256.clone() {
                schedule_content_verify(VerifyJob {
                    state: state.clone(),
                    task_id: task.task_id.clone(),
                    save_path: task.save_path.clone(),
                    expected,
                    notify_success: false,
                });
            }
        }
    }
    if has_queued {
        state.scheduler.notify_one();
    }
    Ok(created)
}

/// 校验单个下载请求并构造任务；重复/非法分别返回 `Ok(None)` / `Err`。
fn build_task_from_request(
    state: &Arc<AppState>,
    created: &[DownloadTask],
    request: DownloadRequest,
    now: &mut u64,
) -> Result<Option<DownloadTask>, String> {
    let repo_id = util::sanitize_repo_id(&request.repo_id)?;
    let remote_path = util::sanitize_remote_path(&request.remote_path)?;
    // v0.2.0：revision 缺省用来源默认值；自定义文本按仓库相对路径规则净化（允许 `feature/x`）。
    let revision = match request
        .revision
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => util::sanitize_remote_path(raw)?,
        None => request.source.default_revision().to_string(),
    };
    let paths = util::prepare_download_revision(
        &request.save_dir,
        &repo_id,
        &remote_path,
        &revision,
        request.source.default_revision(),
    )?;
    let save_path = paths.final_path.to_string_lossy().into_owned();

    // 去重：同 source+repo+remotePath+revision+最终路径已在任务表中（任意状态）→ 复用。
    if state
        .find_duplicate_task(
            request.source,
            &repo_id,
            &remote_path,
            &revision,
            &save_path,
        )
        .is_some()
    {
        return Ok(None);
    }
    if created.iter().any(|task| {
        task.source == request.source
            && task.repo_id == repo_id
            && task.remote_path == remote_path
            && task.revision == revision
            && task.save_path == save_path
    }) {
        return Ok(None);
    }

    if state
        .tasks_snapshot()
        .iter()
        .chain(created.iter())
        .any(|task| util::task_paths_conflict(Path::new(&task.save_path), &paths.final_path))
    {
        return Err("目标文件已属于另一个来源或 revision 的任务，请选择其他下载目录，或先清理冲突的任务记录".to_string());
    }

    // v0.2.0：分段任务的 .part 已预分配为 total 长度，用元数据 chunks 计算已下载量。
    let progress = read_part_progress(&paths.part_path, &paths.meta_path);
    let total_size = if request.size > 0 {
        request.size
    } else {
        progress.total
    };

    // 最终文件已存在且大小一致 → 直接标记完成。
    let existing_length = std::fs::metadata(&paths.final_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let sha256 = normalized_sha(request.sha256.as_deref());
    let already_completed = total_size > 0 && existing_length == total_size;
    let verify_status = if already_completed && sha256.is_some() {
        VerifyStatus::Pending
    } else {
        VerifyStatus::Unavailable
    };

    *now = now.saturating_add(1); // 保证同毫秒入队仍保持 FIFO
    let added_at = *now;
    Ok(Some(DownloadTask {
        update_seq: 0,
        task_id: uuid::Uuid::new_v4().to_string(),
        source: request.source,
        repo_id,
        remote_path,
        file_name: paths
            .final_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        save_path: paths.final_path.to_string_lossy().into_owned(),
        temp_path: paths.part_path.to_string_lossy().into_owned(),
        total_size,
        downloaded: if already_completed {
            existing_length
        } else {
            progress.downloaded
        },
        status: if already_completed {
            TaskStatus::Completed
        } else {
            TaskStatus::Queued
        },
        speed: 0,
        error: None,
        retries: 0,
        revision,
        added_at,
        completed_at: if already_completed {
            Some(added_at)
        } else {
            None
        },
        etag: progress.etag,
        last_modified: progress.last_modified,
        sha256,
        verify_status,
    }))
}

/// 命令 5：暂停单个任务（P1-1：CAS 迁移，冲突时安全丢弃）。
pub fn pause_task(
    state: &Arc<AppState>,
    sink: &dyn EventSink,
    task_id: &str,
) -> Result<(), String> {
    let task = state
        .get_task(task_id)
        .ok_or_else(|| "任务不存在".to_string())?;
    match task.status {
        TaskStatus::Active | TaskStatus::Pausing | TaskStatus::Queued => {
            // Active → Pausing（下载循环收尾为 paused）；Queued → Paused。
            let transition = if task.status == TaskStatus::Queued {
                state.transition_task(task_id, &[TaskStatus::Queued], |task| {
                    task.status = TaskStatus::Paused;
                    task.speed = 0;
                })
            } else {
                state.transition_task(task_id, &[TaskStatus::Active], |task| {
                    task.status = TaskStatus::Pausing;
                    task.speed = 0;
                })
            };
            match transition {
                TransitionOutcome::Updated(updated) => {
                    if updated.status == TaskStatus::Pausing {
                        // 只读取既有控制标志：若下载已收尾（标志被移除）则无事可做。
                        if let Some(control) = state.get_control(task_id) {
                            control.set_paused(true);
                        }
                    } else {
                        state.remove_control(task_id);
                    }
                    util::emit_task_updated(sink, &updated);
                    state.mark_dirty(false);
                    Ok(())
                }
                // 已被并发完成/取消：丢弃暂停请求，绝不再覆盖终态。
                TransitionOutcome::Conflict(_) | TransitionOutcome::Missing => Ok(()),
            }
        }
        TaskStatus::Paused => Ok(()),
        // 终态任务的暂停请求安全丢弃（与下载完成并发时前端不需要看到错误）。
        TaskStatus::Completed | TaskStatus::Error | TaskStatus::Cancelled => Ok(()),
    }
}

/// 命令 6：继续单个任务（paused/error/cancelled → queued，CAS）。
pub fn resume_task(
    state: &Arc<AppState>,
    sink: &dyn EventSink,
    task_id: &str,
) -> Result<(), String> {
    let task = state
        .get_task(task_id)
        .ok_or_else(|| "任务不存在".to_string())?;
    let meta_path = util::with_suffix(Path::new(&task.temp_path), ".json");
    let part_length = read_part_progress(Path::new(&task.temp_path), &meta_path).downloaded;
    match state.transition_task(
        task_id,
        &[TaskStatus::Paused, TaskStatus::Error, TaskStatus::Cancelled],
        |task| {
            task.status = TaskStatus::Queued;
            task.error = None;
            task.speed = 0;
            task.completed_at = None;
            task.downloaded = part_length;
        },
    ) {
        TransitionOutcome::Updated(updated) => {
            state.remove_control(task_id);
            util::emit_task_updated(sink, &updated);
            state.mark_dirty(false);
            state.scheduler.notify_one();
            Ok(())
        }
        TransitionOutcome::Conflict(current) => match current.status {
            TaskStatus::Queued | TaskStatus::Active | TaskStatus::Pausing => Ok(()),
            TaskStatus::Completed => Err("任务已完成，无需继续".to_string()),
            _ => Ok(()),
        },
        TransitionOutcome::Missing => Err("任务不存在".to_string()),
    }
}

/// 命令 7：暂停全部（active/queued）。
pub fn pause_all(state: &Arc<AppState>, sink: &dyn EventSink) {
    let task_ids: Vec<String> = state
        .tasks_snapshot()
        .into_iter()
        .filter(|task| {
            matches!(
                task.status,
                TaskStatus::Active | TaskStatus::Pausing | TaskStatus::Queued
            )
        })
        .map(|task| task.task_id)
        .collect();
    for task_id in task_ids {
        let _ = pause_task(state, sink, &task_id);
    }
}

/// 命令 8：继续全部（paused/error/cancelled）。
pub fn resume_all(state: &Arc<AppState>, sink: &dyn EventSink) {
    let task_ids: Vec<String> = state
        .tasks_snapshot()
        .into_iter()
        .filter(|task| {
            matches!(
                task.status,
                TaskStatus::Paused | TaskStatus::Error | TaskStatus::Cancelled
            )
        })
        .map(|task| task.task_id)
        .collect();
    for task_id in task_ids {
        let _ = resume_task(state, sink, &task_id);
    }
}

/// 命令 9：取消任务（P1-1：active 只置控制标志，由下载循环 CAS 收尾为 cancelled）。
pub fn cancel_task(
    state: &Arc<AppState>,
    sink: &dyn EventSink,
    task_id: &str,
    delete_partial: bool,
) -> Result<(), String> {
    let task = state
        .get_task(task_id)
        .ok_or_else(|| "任务不存在".to_string())?;
    match task.status {
        TaskStatus::Active | TaskStatus::Pausing => {
            match state.get_control(task_id) {
                Some(control) => control.cancel(delete_partial),
                None => {
                    // 下载收尾竞态：若已进入终态则忽略；否则补建控制标志。
                    if let Some(current) = state.get_task(task_id) {
                        if current.status.is_terminal() {
                            return Ok(());
                        }
                    }
                    let control = state.control_for(task_id);
                    control.cancel(delete_partial);
                    state.set_control(task_id, control);
                }
            }
            // 状态由下载循环收尾为 cancelled（毫秒级），避免提前释放并发槽。
            Ok(())
        }
        TaskStatus::Queued | TaskStatus::Paused | TaskStatus::Error => {
            let meta_path = util::with_suffix(Path::new(&task.temp_path), ".json");
            let part_length = read_part_progress(Path::new(&task.temp_path), &meta_path).downloaded;
            match state.transition_task(
                task_id,
                &[TaskStatus::Queued, TaskStatus::Paused, TaskStatus::Error],
                |task| {
                    task.status = TaskStatus::Cancelled;
                    task.downloaded = part_length;
                    task.speed = 0;
                    task.error = None;
                    task.completed_at = Some(util::now_millis());
                },
            ) {
                TransitionOutcome::Updated(updated) => {
                    if delete_partial {
                        let paths = util::TaskPaths {
                            final_path: PathBuf::from(&updated.save_path),
                            part_path: PathBuf::from(&updated.temp_path),
                            meta_path: util::with_suffix(Path::new(&updated.temp_path), ".json"),
                        };
                        util::remove_task_temp_files(&paths);
                    }
                    state.remove_control(task_id);
                    util::emit_task_updated(sink, &updated);
                    state.mark_dirty(true);
                    Ok(())
                }
                // 并发完成/取消：丢弃本次取消请求。
                TransitionOutcome::Conflict(_) | TransitionOutcome::Missing => Ok(()),
            }
        }
        TaskStatus::Cancelled => Ok(()),
        TaskStatus::Completed => Err("任务已完成，无法取消".to_string()),
    }
}

/// 命令 10：重试失败任务（error → queued，保留已下载字节；CAS）。
pub fn retry_task(
    state: &Arc<AppState>,
    sink: &dyn EventSink,
    task_id: &str,
) -> Result<(), String> {
    match state.transition_task(task_id, &[TaskStatus::Error], |task| {
        task.status = TaskStatus::Queued;
        task.error = None;
        task.speed = 0;
        task.completed_at = None;
    }) {
        TransitionOutcome::Updated(updated) => {
            state.remove_control(task_id);
            util::emit_task_updated(sink, &updated);
            state.mark_dirty(false);
            state.scheduler.notify_one();
            Ok(())
        }
        TransitionOutcome::Conflict(_) => Err("只有失败的任务可以重试".to_string()),
        TransitionOutcome::Missing => Err("任务不存在".to_string()),
    }
}

/// 命令 11：删除任务记录（仅终态）。
pub fn remove_tasks(
    state: &Arc<AppState>,
    sink: &dyn EventSink,
    task_ids: &[String],
) -> Result<(), String> {
    let snapshot = state.tasks_snapshot();
    for task_id in task_ids {
        if let Some(task) = snapshot.iter().find(|task| &task.task_id == task_id) {
            if !task.status.is_terminal() {
                return Err(format!("任务「{}」尚未结束，无法删除记录", task.file_name));
            }
        }
    }
    let removed = state.remove_tasks(task_ids);
    if removed.is_empty() {
        return Ok(());
    }
    for task_id in &removed {
        state.remove_control(task_id);
    }
    util::emit_tasks_removed(sink, &removed);
    state.mark_dirty(true);
    Ok(())
}

/// 命令 12：清理全部终态任务记录（不删除文件）。
pub fn clear_finished(state: &Arc<AppState>, sink: &dyn EventSink) -> Result<(), String> {
    let terminal_ids: Vec<String> = state
        .tasks_snapshot()
        .into_iter()
        .filter(|task| task.status.is_terminal())
        .map(|task| task.task_id)
        .collect();
    remove_tasks(state, sink, &terminal_ids)
}

/// 暂停/继续等操作后测试所需的控制标志工厂（保持与 `state` 模块一致）。
pub fn new_control() -> Arc<TaskControl> {
    TaskControl::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Settings;
    use crate::state::PersistedTasks;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), payload));
        }
    }

    impl RecordingSink {
        fn count(&self, name: &str) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(event, _)| event == name)
                .count()
        }
    }

    fn unique_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mdm-queue-test-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_state(auto_resume: bool) -> (Arc<AppState>, PathBuf) {
        let dir = unique_dir("state");
        let mut settings = Settings::default();
        settings.download_dir = dir.join("models").to_string_lossy().into_owned();
        settings.auto_resume = auto_resume;
        let state = Arc::new(AppState::new(settings, dir.join("appdata")));
        (state, dir)
    }

    fn sample_request(save_dir: &std::path::Path, remote: &str, size: u64) -> DownloadRequest {
        DownloadRequest {
            source: crate::models::Source::Huggingface,
            repo_id: "org/model".to_string(),
            remote_path: remote.to_string(),
            size,
            save_dir: save_dir.to_string_lossy().into_owned(),
            revision: None,
            sha256: None,
        }
    }

    #[test]
    fn start_downloads_dedupes_by_final_path() {
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let models = dir.join("models");
        let created = start_downloads(
            &state,
            vec![
                sample_request(&models, "a.bin", 100),
                sample_request(&models, "a.bin", 100),
                sample_request(&models, "b.bin", 200),
            ],
            &sink,
        )
        .unwrap();
        assert_eq!(created.len(), 2, "同批重复的最终路径只应创建一个任务");
        assert!(created.iter().all(|task| task.status == TaskStatus::Queued));
        assert_eq!(sink.count("task-updated"), 2);
        assert_eq!(state.tasks_snapshot().len(), 2);

        let again =
            start_downloads(&state, vec![sample_request(&models, "a.bin", 100)], &sink).unwrap();
        assert!(again.is_empty(), "已有同路径任务时应复用而不是新建");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn queued_pause_resume_cancel_and_remove_rules() {
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let models = dir.join("models");
        let created =
            start_downloads(&state, vec![sample_request(&models, "w.bin", 10)], &sink).unwrap();
        let task_id = created[0].task_id.clone();

        // queued → paused → queued
        pause_task(&state, &sink, &task_id).unwrap();
        assert_eq!(state.get_task(&task_id).unwrap().status, TaskStatus::Paused);
        resume_task(&state, &sink, &task_id).unwrap();
        assert_eq!(state.get_task(&task_id).unwrap().status, TaskStatus::Queued);

        // 未终态不能删除记录
        assert!(remove_tasks(&state, &sink, &[task_id.clone()]).is_err());

        // queued → cancelled（终态）
        cancel_task(&state, &sink, &task_id, true).unwrap();
        assert_eq!(
            state.get_task(&task_id).unwrap().status,
            TaskStatus::Cancelled
        );

        // 终态可删除记录，并发出 tasks-removed
        remove_tasks(&state, &sink, &[task_id.clone()]).unwrap();
        assert!(state.get_task(&task_id).is_none());
        assert_eq!(sink.count("tasks-removed"), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn completed_file_is_detected_at_enqueue() {
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let models = dir.join("models");
        let target = models.join("org").join("model").join("done.bin");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, [1u8, 2, 3, 4]).unwrap();

        let created =
            start_downloads(&state, vec![sample_request(&models, "done.bin", 4)], &sink).unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].status, TaskStatus::Completed);
        assert_eq!(created[0].downloaded, 4);
        assert!(created[0].completed_at.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 创建 queued 任务并模拟 pump 的 CAS 启动（queued → active）。
    fn make_active_task(state: &Arc<AppState>, dir: &Path, name: &str) -> String {
        let sink = RecordingSink::default();
        let models = dir.join("models");
        let created =
            start_downloads(state, vec![sample_request(&models, name, 100)], &sink).unwrap();
        let task_id = created[0].task_id.clone();
        let outcome = state.transition_task(&task_id, &[TaskStatus::Queued], |task| {
            task.status = TaskStatus::Active;
            task.downloaded = 10;
        });
        assert!(matches!(outcome, TransitionOutcome::Updated(_)));
        task_id
    }

    #[test]
    fn active_completion_not_overridden_by_concurrent_pause() {
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let task_id = make_active_task(&state, &dir, "race.bin");

        // 暂停先到：active → pausing。
        pause_task(&state, &sink, &task_id).unwrap();
        assert_eq!(
            state.get_task(&task_id).unwrap().status,
            TaskStatus::Pausing
        );

        // 下载协程随后完成：必须从 active/pausing 迁移到 completed，不能卡在 pausing。
        finish_task(
            &state,
            &sink,
            &task_id,
            Ok(TransferOutcome::Completed {
                downloaded: 100,
                total_size: 100,
                etag: None,
                last_modified: None,
            }),
        );
        assert_eq!(
            state.get_task(&task_id).unwrap().status,
            TaskStatus::Completed,
            "完成后必须离开 pausing，不允许卡死"
        );

        // 完成后再暂停：CAS 冲突被丢弃，终态不被覆盖。
        pause_task(&state, &sink, &task_id).unwrap();
        assert_eq!(
            state.get_task(&task_id).unwrap().status,
            TaskStatus::Completed
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pause_after_completion_is_noop() {
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let task_id = make_active_task(&state, &dir, "done-race.bin");
        finish_task(
            &state,
            &sink,
            &task_id,
            Ok(TransferOutcome::Completed {
                downloaded: 100,
                total_size: 100,
                etag: None,
                last_modified: None,
            }),
        );
        assert_eq!(
            state.get_task(&task_id).unwrap().status,
            TaskStatus::Completed
        );

        pause_task(&state, &sink, &task_id).unwrap();
        assert_eq!(
            state.get_task(&task_id).unwrap().status,
            TaskStatus::Completed
        );
        assert!(
            resume_task(&state, &sink, &task_id).is_err(),
            "已完成任务不允许继续"
        );
        assert_eq!(
            state.get_task(&task_id).unwrap().status,
            TaskStatus::Completed
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn start_downloads_skips_invalid_request_but_keeps_valid() {
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let models = dir.join("models");

        let mut invalid = sample_request(&models, "ok.bin", 10);
        invalid.remote_path = "../escape.bin".to_string();
        let created = start_downloads(
            &state,
            vec![invalid, sample_request(&models, "ok.bin", 10)],
            &sink,
        )
        .unwrap();
        assert_eq!(created.len(), 1, "非法项应被跳过，合法项正常创建");
        assert_eq!(state.tasks_snapshot().len(), 1);

        // 整批全部非法 → 返回首个中文错误。
        let mut bad = sample_request(&models, "x.bin", 1);
        bad.remote_path = "C:\\windows\\evil.bin".to_string();
        let error = start_downloads(&state, vec![bad], &sink).unwrap_err();
        assert!(!error.is_empty(), "全非法时应返回明确错误");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn distinct_sources_cannot_own_the_same_output() {
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let models = dir.join("models");
        let hf = sample_request(&models, "same.bin", 10);
        let mut ms = sample_request(&models, "same.bin", 10);
        ms.source = crate::models::Source::Modelscope;
        let created = start_downloads(&state, vec![hf, ms], &sink).unwrap();
        assert_eq!(created.len(), 1, "不同来源不得同时写入相同目标");
        assert_eq!(state.tasks_snapshot().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_pauses_active_tasks_and_respects_auto_resume() {
        let (state, dir) = sample_state(false);
        let now = util::now_millis();
        let make_task = |id: &str, status: TaskStatus| DownloadTask {
            update_seq: 0,
            task_id: id.to_string(),
            source: crate::models::Source::Modelscope,
            repo_id: "org/model".to_string(),
            remote_path: "w.bin".to_string(),
            file_name: "w.bin".to_string(),
            save_path: dir
                .join("models")
                .join("org/model/w.bin")
                .to_string_lossy()
                .into_owned(),
            temp_path: dir
                .join("models")
                .join("org/model/w.bin.part")
                .to_string_lossy()
                .into_owned(),
            total_size: 100,
            downloaded: 10,
            status,
            speed: 0,
            error: None,
            retries: 0,
            revision: "master".to_string(),
            added_at: now,
            completed_at: None,
            etag: None,
            last_modified: None,
            sha256: None,
            verify_status: VerifyStatus::Unavailable,
        };
        let persisted = PersistedTasks::new(vec![
            make_task("active", TaskStatus::Active),
            make_task("pausing", TaskStatus::Pausing),
            make_task("queued", TaskStatus::Queued),
            make_task("completed", TaskStatus::Completed),
        ]);
        util::atomic_write_json(&state.tasks_path(), &persisted).unwrap();

        let recovered = state.load_persisted_tasks();
        let status = |id: &str| {
            recovered
                .iter()
                .find(|task| task.task_id == id)
                .unwrap()
                .status
        };
        assert_eq!(status("active"), TaskStatus::Paused);
        assert_eq!(status("pausing"), TaskStatus::Paused);
        assert_eq!(
            status("queued"),
            TaskStatus::Paused,
            "autoResume=false 时 queued 应暂停"
        );
        assert_eq!(status("completed"), TaskStatus::Completed);

        // autoResume=true 时 queued 保持 queued。
        let (state_auto, dir_auto) = sample_state(true);
        util::atomic_write_json(&state_auto.tasks_path(), &persisted).unwrap();
        let recovered_auto = state_auto.load_persisted_tasks();
        assert_eq!(
            recovered_auto
                .iter()
                .find(|task| task.task_id == "queued")
                .unwrap()
                .status,
            TaskStatus::Queued
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir_auto);
    }

    #[test]
    fn dedupe_key_includes_revision() {
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let models = dir.join("models");

        let mut main_request = sample_request(&models, "same.bin", 10);
        main_request.revision = None; // 缺省 → 来源默认 main
        let created = start_downloads(&state, vec![main_request], &sink).unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].revision, "main");

        // 同 revision 重复 → 去重复用。
        let duplicate =
            start_downloads(&state, vec![sample_request(&models, "same.bin", 10)], &sink).unwrap();
        assert!(duplicate.is_empty(), "同 revision 应复用");

        // 不同 revision → 允许创建第二个任务，且最终保存路径包含 revision 段。
        let mut dev_request = sample_request(&models, "same.bin", 10);
        dev_request.revision = Some("dev".to_string());
        let dev_created = start_downloads(&state, vec![dev_request], &sink).unwrap();
        assert_eq!(dev_created.len(), 1, "不同 revision 不应互相去重");
        assert_eq!(dev_created[0].revision, "dev");
        assert!(
            dev_created[0].save_path.contains(".mdm-revisions"),
            "非默认 revision 路径应包含 revision 段：{}",
            dev_created[0].save_path
        );
        assert_ne!(
            dev_created[0].save_path, created[0].save_path,
            "同名文件不同 revision 的 savePath 必须不同"
        );
        assert_eq!(state.tasks_snapshot().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_fills_missing_revision_from_source_default() {
        let (state, dir) = sample_state(true);
        let now = util::now_millis();
        let mut task = DownloadTask {
            update_seq: 0,
            task_id: "legacy".to_string(),
            source: crate::models::Source::Modelscope,
            repo_id: "org/model".to_string(),
            remote_path: "w.bin".to_string(),
            file_name: "w.bin".to_string(),
            save_path: dir
                .join("models/org/model/w.bin")
                .to_string_lossy()
                .into_owned(),
            temp_path: dir
                .join("models/org/model/w.bin.part")
                .to_string_lossy()
                .into_owned(),
            total_size: 10,
            downloaded: 0,
            status: TaskStatus::Queued,
            speed: 0,
            error: None,
            retries: 0,
            revision: "master".to_string(),
            added_at: now,
            completed_at: None,
            etag: None,
            last_modified: None,
            sha256: None,
            verify_status: VerifyStatus::Unavailable,
        };
        // 模拟旧版 tasks.json：缺少 revision 字段。
        let mut value = serde_json::to_value(&task).unwrap();
        value.as_object_mut().unwrap().remove("revision");
        task.revision = String::new();
        let persisted = serde_json::json!({ "version": 1, "tasks": [value] });
        util::atomic_write_json(&state.tasks_path(), &persisted).unwrap();

        recover(&state).expect("启动恢复应成功");
        let restored = state.get_task("legacy").expect("任务应被恢复");
        assert_eq!(
            restored.revision, "master",
            "旧任务缺失 revision 时按来源默认值补齐"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_file_is_verified_or_rejected_by_sha256() {
        let hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let (state, dir) = sample_state(true);
        let sink = RecordingSink::default();
        let models = dir.join("models");
        let final_path = models.join("org").join("model").join("a.bin");
        std::fs::create_dir_all(final_path.parent().unwrap()).unwrap();
        std::fs::write(&final_path, b"abc").unwrap();

        let mut request = sample_request(&models, "a.bin", 3);
        request.sha256 = Some(format!("sha256:{hex}"));
        let created = start_downloads(&state, vec![request], &sink).unwrap();
        assert_eq!(created.len(), 1);
        let stored = state.get_task(&created[0].task_id).unwrap();
        assert_eq!(stored.status, TaskStatus::Completed);
        assert_eq!(stored.verify_status, VerifyStatus::Verified);
        assert_eq!(stored.sha256.as_deref(), Some(hex));
        assert!(final_path.exists());

        let _ = std::fs::remove_dir_all(&dir);

        let (state, dir) = sample_state(true);
        let models = dir.join("models");
        let final_path = models.join("org").join("model").join("a.bin");
        std::fs::create_dir_all(final_path.parent().unwrap()).unwrap();
        std::fs::write(&final_path, b"abc").unwrap();
        let mut request = sample_request(&models, "a.bin", 3);
        request.sha256 = Some("a".repeat(64));
        let created = start_downloads(&state, vec![request], &sink).unwrap();
        let stored = state.get_task(&created[0].task_id).unwrap();
        assert_eq!(stored.status, TaskStatus::Error);
        assert_eq!(stored.verify_status, VerifyStatus::Mismatch);
        assert!(stored.error.unwrap_or_default().contains("校验不一致"));
        assert!(!final_path.exists(), "校验失败的文件应删除，避免下次按大小跳过");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
