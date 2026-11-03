//! 单文件传输引擎：Range 断点续传、重试退避、全局限速、暂停/取消、进度事件。
//!
//! 设计要点（契约 §5）：
//! - `.part` 保存未完成数据，`.part.json` 保存 etag/lastModified/total/repoId/remotePath；
//! - 206 校验 `Content-Range` 起点与 etag/lastModified；200 从头写；416 且 total == part 长度视为完成；
//! - 401/403/404 不重试；408/429/5xx/网络错误按 `maxRetries` 指数退避（1s、2s、4s… 上限 30s）；
//! - 每块写入前扣减全局令牌桶预算，并检查暂停/取消标志；
//! - 进度事件每任务 ≤ 4 次/秒；完成时先发最终进度，再由 queue 发 task-updated；
//! - 完成后 `fs::rename(part → final)`，删除 `.part.json`。
//!
//! 本模块不依赖 Tauri（事件经 [`EventSink`] 抽象发出）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

use crate::models::Source;
use crate::sources;
use crate::state::TaskControl;
use crate::util::{self, BandwidthLimiter, EventSink};

/// 进度事件最小间隔（≤ 4 次/秒）。
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// 指数退避上限。
pub const BACKOFF_CAP: Duration = Duration::from_secs(30);

/// `.part.json` 断点元数据（camelCase 与任务类型风格一致）。
///
/// v0.2.0 起支持多连接分段下载：`chunk_size` / `chunks` 存在即为分段元数据；
/// 旧版单流元数据这两个字段缺失，反序列化时自动兼容。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PartMeta {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub total: u64,
    pub repo_id: String,
    pub remote_path: String,
    /// v0.2.0：分段大小（为 `None` 表示旧单流元数据）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<u64>,
    /// v0.2.0：各分块已完成字节数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunks: Option<Vec<u64>>,
}

impl PartMeta {
    /// 是否为 v0.2.0 分段下载元数据。
    pub fn is_segmented(&self) -> bool {
        self.chunk_size.is_some() && self.chunks.is_some()
    }

    /// 已下载字节数：分段元数据取 chunks 之和，旧单流元数据返回 0（调用方用 `.part` 长度）。
    pub fn segmented_downloaded(&self) -> Option<u64> {
        self.chunks
            .as_ref()
            .map(|chunks| chunks.iter().copied().sum())
    }
}

/// 任务断点进度（v0.2.0：兼容单流 `.part` 长度与分段 `chunks` 之和）。
#[derive(Debug, Clone, Default)]
pub struct PartProgress {
    pub downloaded: u64,
    pub total: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// 读取 `.part.json` + `.part` 计算任务已下载进度（供 queue 恢复/展示）。
pub fn read_part_progress(
    part_path: &std::path::Path,
    meta_path: &std::path::Path,
) -> PartProgress {
    let meta: PartMeta = util::read_json_opt(meta_path).unwrap_or_default();
    let part_len = std::fs::metadata(part_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let downloaded = if meta.is_segmented() {
        meta.segmented_downloaded().unwrap_or(0)
    } else {
        part_len
    };
    let total = meta.total;
    PartProgress {
        downloaded: downloaded.min(if total > 0 { total } else { downloaded }),
        total,
        etag: meta.etag,
        last_modified: meta.last_modified,
    }
}

/// 重试回调：每次计划重试时携带累计重试次数（用于回写任务表并推送 UI）。
pub type RetryCallback = Arc<dyn Fn(u32) + Send + Sync>;

/// 传输上下文（由 queue 构造）。
pub struct TransferContext {
    pub task_id: String,
    pub repo_id: String,
    pub remote_path: String,
    pub client: reqwest::Client,
    pub url: String,
    pub source: Source,
    pub auth_token: Option<String>,
    pub save_path: PathBuf,
    pub part_path: PathBuf,
    pub meta_path: PathBuf,
    pub total_size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub max_retries: u32,
    pub limiter: Arc<BandwidthLimiter>,
    pub control: Arc<TaskControl>,
    /// 每次重试时回调（P1-2：让前端「已重试 N 次」实时可见）。
    pub on_retry: Option<RetryCallback>,
    /// v0.2.0：单文件最大连接数（1 = 原单流引擎）。
    pub connections: u32,
    /// 测试用分块大小覆盖（生产为 `segmented::CHUNK_SIZE`）。
    pub chunk_size_override: Option<u64>,
}

/// 传输结果。
#[derive(Debug, Clone)]
pub enum TransferOutcome {
    Completed {
        downloaded: u64,
        total_size: u64,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    Paused {
        downloaded: u64,
        total_size: u64,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    Cancelled {
        downloaded: u64,
        total_size: u64,
    },
}

/// 传输错误（消息为中文，可直接展示给用户）。
#[derive(Debug, Clone)]
pub struct DownloadError {
    pub message: String,
    pub retryable: bool,
}

impl DownloadError {
    pub fn new(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            message: message.into(),
            retryable,
        }
    }

    pub fn non_retryable(message: impl Into<String>) -> Self {
        Self::new(message, false)
    }

    pub fn retryable(message: impl Into<String>) -> Self {
        Self::new(message, true)
    }
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<DownloadError> for String {
    fn from(error: DownloadError) -> Self {
        error.message
    }
}

// ---------------------------------------------------------------------------
// 纯函数（可单元测试）
// ---------------------------------------------------------------------------

/// `Content-Range` 解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentRange {
    pub start: Option<u64>,
    pub end: Option<u64>,
    pub total: Option<u64>,
}

/// 解析 `Content-Range: bytes 0-499/1234` 或 `bytes */1234`。
pub fn parse_content_range(value: &str) -> Option<ContentRange> {
    let value = value.trim();
    let rest = value.strip_prefix("bytes")?.trim_start();
    let (range_part, total_part) = rest.split_once('/')?;
    let total = match total_part.trim() {
        "*" => None,
        other => Some(other.parse::<u64>().ok()?),
    };
    let range_part = range_part.trim();
    if range_part == "*" {
        return Some(ContentRange {
            start: None,
            end: None,
            total,
        });
    }
    let (start_text, end_text) = range_part.split_once('-')?;
    let start = start_text.trim().parse::<u64>().ok()?;
    let end = end_text.trim().parse::<u64>().ok()?;
    if end < start {
        return None;
    }
    Some(ContentRange {
        start: Some(start),
        end: Some(end),
        total,
    })
}

/// 可重试的 HTTP 状态码：408、429、5xx。
pub fn status_is_retryable(status: u16) -> bool {
    status == 408 || status == 429 || (500..=599).contains(&status)
}

/// 第 `retry_number` 次重试的退避时间（1s、2s、4s… 上限 30s）。
pub fn backoff_delay(retry_number: u32) -> Duration {
    let shift = retry_number.saturating_sub(1).min(5);
    let seconds = 1u64 << shift;
    Duration::from_secs(seconds).min(BACKOFF_CAP)
}

/// 续传前校验 `.part.json` 记录的 etag/lastModified 与响应头是否一致。
/// 任一记录缺失时视为一致（无法校验时不阻塞续传）。
pub fn resume_headers_match(
    meta: &PartMeta,
    response_etag: Option<&str>,
    response_last_modified: Option<&str>,
) -> bool {
    fn non_empty(value: Option<&str>) -> Option<&str> {
        value.filter(|text| !text.trim().is_empty())
    }
    let etag_ok = match (non_empty(meta.etag.as_deref()), non_empty(response_etag)) {
        (Some(saved), Some(current)) => saved == current,
        _ => true,
    };
    let modified_ok = match (
        non_empty(meta.last_modified.as_deref()),
        non_empty(response_last_modified),
    ) {
        (Some(saved), Some(current)) => saved == current,
        _ => true,
    };
    etag_ok && modified_ok
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

struct ProgressReporter<'a> {
    sink: &'a dyn EventSink,
    task_id: &'a str,
    interval: Duration,
    last_emit: Instant,
    last_bytes: u64,
    last_instant: Instant,
}

impl<'a> ProgressReporter<'a> {
    fn new(sink: &'a dyn EventSink, task_id: &'a str, downloaded: u64) -> Self {
        let now = Instant::now();
        Self {
            sink,
            task_id,
            interval: PROGRESS_INTERVAL,
            last_emit: now,
            last_bytes: downloaded,
            last_instant: now,
        }
    }

    /// 发送进度（受 250ms 限流）；`force = true` 时立即发送。
    fn emit(&mut self, downloaded: u64, total_size: u64, force: bool) {
        let now = Instant::now();
        let since_emit = now.duration_since(self.last_emit);
        if !force && since_emit < self.interval {
            return;
        }
        let since_bytes = downloaded.saturating_sub(self.last_bytes);
        let elapsed_secs = now
            .duration_since(self.last_instant)
            .as_secs_f64()
            .max(0.001);
        let speed = if since_bytes == 0 {
            0
        } else {
            (since_bytes as f64 / elapsed_secs) as u64
        };
        self.last_emit = now;
        self.last_instant = now;
        self.last_bytes = downloaded;
        util::emit_progress(self.sink, self.task_id, downloaded, total_size, speed);
    }
}

pub(crate) enum WaitOutcome {
    Done,
    Paused,
    Cancelled,
}

pub(crate) async fn with_control<F: std::future::Future>(
    control: &TaskControl,
    future: F,
) -> Result<F::Output, WaitOutcome> {
    tokio::select! {
        biased;
        _ = control.stopped() => Err(if control.is_cancelled() { WaitOutcome::Cancelled } else { WaitOutcome::Paused }),
        result = future => Ok(result),
    }
}

pub(crate) async fn sleep_with_control(control: &TaskControl, duration: Duration) -> WaitOutcome {
    let deadline = Instant::now() + duration;
    loop {
        if control.is_cancelled() {
            return WaitOutcome::Cancelled;
        }
        if control.is_paused() {
            return WaitOutcome::Paused;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return WaitOutcome::Done;
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
    }
}

/// 一次流式写入的中断原因。
enum StreamStop {
    Pause,
    Cancel,
    Error(DownloadError),
}

pub(crate) fn header_text(
    response: &reqwest::Response,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) async fn part_length(part_path: &std::path::Path) -> u64 {
    tokio::fs::metadata(part_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn save_part_meta(
    ctx: &TransferContext,
    total: u64,
    etag: &Option<String>,
    last_modified: &Option<String>,
) {
    let meta = PartMeta {
        etag: etag.clone(),
        last_modified: last_modified.clone(),
        total,
        repo_id: ctx.repo_id.clone(),
        remote_path: ctx.remote_path.clone(),
        chunk_size: None,
        chunks: None,
    };
    if let Err(err) = util::atomic_write_json(&ctx.meta_path, &meta) {
        eprintln!("保存断点信息失败：{err}");
    }
}

fn pause_outcome(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    downloaded: u64,
    total_size: u64,
    etag: Option<String>,
    last_modified: Option<String>,
) -> TransferOutcome {
    let downloaded = actual_downloaded(ctx, downloaded);
    save_part_meta(ctx, total_size, &etag, &last_modified);
    util::emit_progress(sink, &ctx.task_id, downloaded, total_size, 0);
    TransferOutcome::Paused {
        downloaded,
        total_size,
        etag,
        last_modified,
    }
}

fn cancel_outcome(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    downloaded: u64,
    total_size: u64,
) -> TransferOutcome {
    let downloaded = actual_downloaded(ctx, downloaded);
    util::emit_progress(sink, &ctx.task_id, downloaded, total_size, 0);
    TransferOutcome::Cancelled {
        downloaded,
        total_size,
    }
}

/// `.part` 实际长度与内存已知值取最大（暂停/取消时报告真实字节数）。
fn actual_downloaded(ctx: &TransferContext, fallback: u64) -> u64 {
    std::fs::metadata(&ctx.part_path)
        .map(|metadata| metadata.len())
        .unwrap_or(fallback)
        .max(fallback)
}

/// 完成：rename part → final，删除 part.json，发最终进度。
async fn finish_transfer(
    ctx: &TransferContext,
    downloaded: u64,
    total_size: u64,
    etag: Option<String>,
    last_modified: Option<String>,
    progress: &mut ProgressReporter<'_>,
) -> Result<TransferOutcome, DownloadError> {
    let total_size = if total_size == 0 {
        downloaded
    } else {
        total_size
    };
    if let Err(err) = tokio::fs::rename(&ctx.part_path, &ctx.save_path).await {
        return Err(DownloadError::non_retryable(format!(
            "无法完成文件重命名（文件可能被占用或权限不足）：{err}"
        )));
    }
    let _ = tokio::fs::remove_file(&ctx.meta_path).await;
    progress.emit(downloaded, total_size, true);
    Ok(TransferOutcome::Completed {
        downloaded,
        total_size,
        etag,
        last_modified,
    })
}

/// 流式读取响应体写入 `.part`，每块检查暂停/取消并扣减令牌。
async fn stream_to_part(
    response: reqwest::Response,
    ctx: &TransferContext,
    append: bool,
    start_offset: u64,
    total_size: u64,
    progress: &mut ProgressReporter<'_>,
) -> Result<u64, StreamStop> {
    use futures_util::StreamExt;

    let mut file = {
        let mut options = OpenOptions::new();
        options.create(true).write(true);
        if append {
            options.append(true);
        } else {
            options.truncate(true);
        }
        options.open(&ctx.part_path).await.map_err(|err| {
            StreamStop::Error(DownloadError::non_retryable(format!(
                "无法写入临时文件（磁盘空间不足或权限不足）：{err}"
            )))
        })?
    };

    let mut downloaded = start_offset;
    let mut stream = response.bytes_stream();
    loop {
        let chunk = match with_control(&ctx.control, stream.next()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(reason) => {
                let _ = file.flush().await;
                return Err(if matches!(reason, WaitOutcome::Cancelled) {
                    StreamStop::Cancel
                } else {
                    StreamStop::Pause
                });
            }
        };
        // 取消优先于暂停。
        if ctx.control.is_cancelled() {
            let _ = file.flush().await;
            return Err(StreamStop::Cancel);
        }
        if ctx.control.is_paused() {
            let _ = file.flush().await;
            return Err(StreamStop::Pause);
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                let _ = file.flush().await;
                return Err(StreamStop::Error(DownloadError::retryable(
                    util::redact_urls(&format!("下载连接中断（{err}）")),
                )));
            }
        };
        if chunk.is_empty() {
            continue;
        }
        if let Err(reason) =
            with_control(&ctx.control, ctx.limiter.acquire(chunk.len() as u64)).await
        {
            let _ = file.flush().await;
            return Err(if matches!(reason, WaitOutcome::Cancelled) {
                StreamStop::Cancel
            } else {
                StreamStop::Pause
            });
        }
        // 限速等待期间可能被暂停/取消。
        if ctx.control.is_cancelled() {
            let _ = file.flush().await;
            return Err(StreamStop::Cancel);
        }
        if ctx.control.is_paused() {
            let _ = file.flush().await;
            return Err(StreamStop::Pause);
        }
        if let Err(err) = file.write_all(&chunk).await {
            return Err(StreamStop::Error(DownloadError::non_retryable(format!(
                "写入文件失败（磁盘空间不足或权限不足）：{err}"
            ))));
        }
        downloaded += chunk.len() as u64;
        progress.emit(downloaded, total_size, false);
    }
    let _ = file.flush().await;
    Ok(downloaded)
}

/// 重试或终止：返回 `Some(outcome)` 表示应直接暂停/取消返回，`Ok(None)` 表示重试。
async fn retry_or_stop(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    retries_used: &mut u32,
    reason: &str,
    downloaded: u64,
    total_size: u64,
    etag: &Option<String>,
    last_modified: &Option<String>,
) -> Result<Option<TransferOutcome>, DownloadError> {
    if *retries_used >= ctx.max_retries {
        return Err(DownloadError::retryable(format!(
            "下载失败：已重试 {} 次仍失败（{reason}）",
            retries_used
        )));
    }
    *retries_used += 1;
    // P1-2：重试发生时立即回调（queue 回写 task.retries 并 emit task-updated）。
    if let Some(callback) = &ctx.on_retry {
        callback(*retries_used);
    }
    match sleep_with_control(&ctx.control, backoff_delay(*retries_used)).await {
        WaitOutcome::Done => Ok(None),
        WaitOutcome::Paused => Ok(Some(pause_outcome(
            ctx,
            sink,
            downloaded,
            total_size,
            etag.clone(),
            last_modified.clone(),
        ))),
        WaitOutcome::Cancelled => Ok(Some(cancel_outcome(ctx, sink, downloaded, total_size))),
    }
}

/// 一次传输尝试：流式写入 + 完成/重试/暂停/取消的统一处理。
///
/// - `Ok(Some(outcome))`：应直接返回该结果（完成/暂停/取消）；
/// - `Ok(None)`：本次尝试失败但可重试，调用方应 `continue` 主循环；
/// - `Err`：不可恢复错误。
#[allow(clippy::too_many_arguments)]
async fn run_stream_attempt(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    retries_used: &mut u32,
    response: reqwest::Response,
    append: bool,
    offset: u64,
    total_size: u64,
    etag: &Option<String>,
    last_modified: &Option<String>,
    progress: &mut ProgressReporter<'_>,
) -> Result<Option<TransferOutcome>, DownloadError> {
    match stream_to_part(response, ctx, append, offset, total_size, progress).await {
        Ok(written) => {
            finish_or_retry(
                ctx,
                sink,
                retries_used,
                written,
                total_size,
                etag,
                last_modified,
                progress,
            )
            .await
        }
        Err(StreamStop::Pause) => Ok(Some(pause_outcome(
            ctx,
            sink,
            offset,
            total_size,
            etag.clone(),
            last_modified.clone(),
        ))),
        Err(StreamStop::Cancel) => Ok(Some(cancel_outcome(ctx, sink, offset, total_size))),
        Err(StreamStop::Error(err)) => {
            if !err.retryable {
                return Err(err);
            }
            retry_or_stop(
                ctx,
                sink,
                retries_used,
                &err.message,
                offset,
                total_size,
                etag,
                last_modified,
            )
            .await
        }
    }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/// 下载前目标安全检查：拒绝符号链接目标、创建父目录（单流/分段共用）。
pub(crate) async fn prepare_target(ctx: &TransferContext) -> Result<(), DownloadError> {
    for path in [&ctx.save_path, &ctx.part_path, &ctx.meta_path] {
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            if metadata.file_type().is_symlink() {
                return Err(DownloadError::non_retryable(format!(
                    "目标路径包含符号链接，已拒绝下载：{}",
                    path.display()
                )));
            }
        }
    }
    let parent = ctx
        .save_path
        .parent()
        .ok_or_else(|| DownloadError::non_retryable("目标文件路径无效"))?;
    tokio::fs::create_dir_all(parent).await.map_err(|err| {
        DownloadError::non_retryable(format!("无法创建下载目录 {}：{err}", parent.display()))
    })?;
    Ok(())
}

/// v0.2.0 自动选择引擎：多连接分段下载（`connectionsPerFile > 1` 且 total 已知 >
/// 一个分块）或原单流引擎（`1`、小文件、total 未知、远端不支持 Range）。
///
/// 分段元数据存在时必须用分段引擎恢复（`.part` 已被预分配为 total 长度）。
pub async fn transfer_auto(
    ctx: TransferContext,
    sink: &dyn EventSink,
) -> Result<TransferOutcome, DownloadError> {
    prepare_target(&ctx).await?;
    discard_untracked_part(&ctx).await?;
    let stored_meta: PartMeta = util::read_json_opt(&ctx.meta_path).unwrap_or_default();
    if stored_meta.is_segmented() {
        prepare_target(&ctx).await?;
        return match crate::segmented::attempt(&ctx, sink).await? {
            crate::segmented::Attempt::Done(outcome) => Ok(outcome),
            crate::segmented::Attempt::Fallback => {
                // 远端已不支持 Range：删除预分配 part 后按单流从头下载。
                let _ = tokio::fs::remove_file(&ctx.part_path).await;
                let _ = tokio::fs::remove_file(&ctx.meta_path).await;
                transfer(ctx, sink).await
            }
        };
    }

    // 多连接条件：开启 >1 且 total 已知且大于一个分块。
    let chunk_size = ctx
        .chunk_size_override
        .unwrap_or(crate::segmented::CHUNK_SIZE);
    let want_segmented = ctx.connections > 1 && ctx.total_size > chunk_size;
    if !want_segmented {
        return transfer(ctx, sink).await;
    }
    // 最终文件已存在且大小一致 → 交给单流引擎走快速完成分支。
    if let Ok(metadata) = tokio::fs::metadata(&ctx.save_path).await {
        if metadata.is_file() && metadata.len() == ctx.total_size {
            return transfer(ctx, sink).await;
        }
    }

    prepare_target(&ctx).await?;
    match crate::segmented::attempt(&ctx, sink).await? {
        crate::segmented::Attempt::Done(outcome) => Ok(outcome),
        crate::segmented::Attempt::Fallback => {
            // 探测不支持 Range：清理可能产生的分段元数据后回退单流。
            if util::read_json_opt::<PartMeta>(&ctx.meta_path)
                .map(|meta| meta.is_segmented())
                .unwrap_or(false)
            {
                let _ = tokio::fs::remove_file(&ctx.part_path).await;
                let _ = tokio::fs::remove_file(&ctx.meta_path).await;
            }
            transfer(ctx, sink).await
        }
    }
}

/// A bare/preallocated part is not proof of downloaded bytes. Only resume a
/// sidecar belonging to this file; failed writes must never turn zeros into data.
async fn discard_untracked_part(ctx: &TransferContext) -> Result<(), DownloadError> {
    let tracked = util::read_json_opt::<PartMeta>(&ctx.meta_path)
        .map(|meta| meta.repo_id == ctx.repo_id && meta.remote_path == ctx.remote_path)
        .unwrap_or(false);
    if !tracked && tokio::fs::try_exists(&ctx.part_path).await.unwrap_or(false) {
        tokio::fs::remove_file(&ctx.part_path)
            .await
            .map_err(|error| {
                DownloadError::non_retryable(format!("无法清理缺少有效断点信息的临时文件：{error}"))
            })?;
        match tokio::fs::remove_file(&ctx.meta_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(DownloadError::non_retryable(format!(
                    "无法清理损坏的断点信息：{error}"
                )))
            }
        }
    }
    Ok(())
}

/// 单文件传输主循环。
pub async fn transfer(
    ctx: TransferContext,
    sink: &dyn EventSink,
) -> Result<TransferOutcome, DownloadError> {
    // 本函数后续统一以引用方式使用上下文（helper 均接收 `&TransferContext`）。
    let ctx = &ctx;

    // 0. 拒绝符号链接目标 + 创建父目录（下载前检查，契约 §5.1）。
    prepare_target(ctx).await?;
    discard_untracked_part(ctx).await?;

    // 1. 最终文件已存在且大小一致 → 直接完成（不重复下载）。
    if ctx.total_size > 0 {
        if let Ok(metadata) = tokio::fs::metadata(&ctx.save_path).await {
            if metadata.is_file() && metadata.len() == ctx.total_size {
                util::emit_progress(sink, &ctx.task_id, ctx.total_size, ctx.total_size, 0);
                return Ok(TransferOutcome::Completed {
                    downloaded: ctx.total_size,
                    total_size: ctx.total_size,
                    etag: ctx.etag.clone(),
                    last_modified: ctx.last_modified.clone(),
                });
            }
        }
    }

    let stored_meta: PartMeta = util::read_json_opt(&ctx.meta_path).unwrap_or_default();
    // v0.2.0：分段断点必须由分段引擎恢复，单流引擎写入会破坏预分配文件。
    if stored_meta.is_segmented() {
        return Err(DownloadError::non_retryable(
            "检测到多连接分段下载断点，请使用分段下载引擎恢复该任务",
        ));
    }
    let mut total_size = if ctx.total_size > 0 {
        ctx.total_size
    } else {
        stored_meta.total
    };
    let mut etag = stored_meta
        .etag
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| ctx.etag.clone());
    let mut last_modified = stored_meta
        .last_modified
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| ctx.last_modified.clone());

    let mut downloaded = part_length(&ctx.part_path).await;
    let mut stale_part_reset_used = false;

    // P1-3：本地 part 比远端声明更长（远端变小/文件被污染）→ 丢弃重下，
    // 不能直接 rename 完成，否则多余字节会被当作有效内容。
    if total_size > 0 && downloaded > total_size {
        let _ = tokio::fs::remove_file(&ctx.part_path).await;
        let _ = tokio::fs::remove_file(&ctx.meta_path).await;
        downloaded = 0;
        stale_part_reset_used = true;
    }

    let mut progress = ProgressReporter::new(sink, &ctx.task_id, downloaded);
    progress.emit(downloaded, total_size, true);

    // 2. 上次已下载完整但尚未 rename（例如完成瞬间被暂停/崩溃）。
    //    仅当 part 长度**恰好等于** total 时直接完成（P1-3）。
    if total_size > 0 && downloaded == total_size {
        return finish_transfer(
            ctx,
            downloaded,
            total_size,
            etag,
            last_modified,
            &mut progress,
        )
        .await;
    }

    let mut retries_used: u32 = 0;
    let mut remote_reset_used = false;

    'transfer: loop {
        if ctx.control.is_cancelled() {
            return Ok(cancel_outcome(ctx, sink, downloaded, total_size));
        }
        if ctx.control.is_paused() {
            return Ok(pause_outcome(
                ctx,
                sink,
                downloaded,
                total_size,
                etag,
                last_modified,
            ));
        }

        downloaded = part_length(&ctx.part_path).await;
        if total_size > 0 && downloaded >= total_size {
            if downloaded == total_size {
                return finish_transfer(
                    ctx,
                    downloaded,
                    total_size,
                    etag,
                    last_modified,
                    &mut progress,
                )
                .await;
            }
            // part 超长：仅允许丢弃重下一次，避免异常情况下无限循环。
            if stale_part_reset_used {
                return Err(DownloadError::non_retryable(
                    "本地临时文件大小与远端不一致，已停止下载，请删除该任务后重试",
                ));
            }
            stale_part_reset_used = true;
            let _ = tokio::fs::remove_file(&ctx.part_path).await;
            let _ = tokio::fs::remove_file(&ctx.meta_path).await;
            downloaded = 0;
            progress.emit(0, total_size, true);
            continue 'transfer;
        }

        // 3. 构造请求：有已下载数据时带 Range。
        let mut request = ctx
            .client
            .get(&ctx.url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if let Some(token) = ctx.auth_token.as_deref() {
            request = request.bearer_auth(token);
        }
        if downloaded > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
            if let Some(validator) = etag.as_deref().or(last_modified.as_deref()) {
                request = request.header(reqwest::header::IF_RANGE, validator);
            }
        }

        let response = match with_control(&ctx.control, request.send()).await {
            Ok(Ok(response)) => response,
            Err(WaitOutcome::Cancelled) => {
                return Ok(cancel_outcome(ctx, sink, downloaded, total_size))
            }
            Err(_) => {
                return Ok(pause_outcome(
                    ctx,
                    sink,
                    downloaded,
                    total_size,
                    etag,
                    last_modified,
                ))
            }
            Ok(Err(err)) => {
                let reason = util::redact_urls(&format!("网络请求失败（{err}）"));
                if let Some(outcome) = retry_or_stop(
                    ctx,
                    sink,
                    &mut retries_used,
                    &reason,
                    downloaded,
                    total_size,
                    &etag,
                    &last_modified,
                )
                .await?
                {
                    return Ok(outcome);
                }
                continue 'transfer;
            }
        };

        let status = response.status();
        let response_etag = header_text(&response, reqwest::header::ETAG);
        let response_last_modified = header_text(&response, reqwest::header::LAST_MODIFIED);

        match status.as_u16() {
            200 | 206 => {
                let content_range = header_text(&response, reqwest::header::CONTENT_RANGE)
                    .and_then(|value| parse_content_range(&value));
                let range_start = content_range.and_then(|range| range.start);
                // 标准 206 视为续传；此外 ModelScope 实测对 Range 请求返回
                // `200 + Content-Range: bytes N-M/T`（非标准），只要起点一致也按续传处理。
                let resume_semantics =
                    range_start == Some(downloaded) && (status.as_u16() == 206 || downloaded > 0);

                if resume_semantics {
                    // 续传前校验 etag/lastModified，不一致说明远端已变 → 删除 part 从头下载（最多 1 次）。
                    if downloaded > 0
                        && !resume_headers_match(
                            &PartMeta {
                                etag: etag.clone(),
                                last_modified: last_modified.clone(),
                                ..PartMeta::default()
                            },
                            response_etag.as_deref(),
                            response_last_modified.as_deref(),
                        )
                    {
                        if remote_reset_used {
                            return Err(DownloadError::non_retryable(
                                "远端文件已更新，请重新开始下载",
                            ));
                        }
                        remote_reset_used = true;
                        let _ = tokio::fs::remove_file(&ctx.part_path).await;
                        let _ = tokio::fs::remove_file(&ctx.meta_path).await;
                        downloaded = 0;
                        total_size = ctx.total_size;
                        etag = None;
                        last_modified = None;
                        progress.emit(0, total_size, true);
                        continue 'transfer;
                    }
                    // 以 Content-Range 的 `*/total` 为准（覆盖列表中的 size）。
                    if let Some(range_total) = content_range.and_then(|range| range.total) {
                        total_size = range_total;
                    }
                    etag = response_etag.clone().or(etag);
                    last_modified = response_last_modified.clone().or(last_modified);
                    save_part_meta(ctx, total_size, &etag, &last_modified);
                    match run_stream_attempt(
                        ctx,
                        sink,
                        &mut retries_used,
                        response,
                        true,
                        downloaded,
                        total_size,
                        &etag,
                        &last_modified,
                        &mut progress,
                    )
                    .await?
                    {
                        Some(outcome) => return Ok(outcome),
                        None => continue 'transfer,
                    }
                } else if status.as_u16() == 206 {
                    // 206 但起点不一致：远端文件已变，删除 part 从头再来一次（最多 1 次）。
                    if remote_reset_used {
                        return Err(DownloadError::non_retryable(
                            "远端文件已发生变化，无法继续断点续传，请删除任务后重新下载",
                        ));
                    }
                    remote_reset_used = true;
                    let _ = tokio::fs::remove_file(&ctx.part_path).await;
                    let _ = tokio::fs::remove_file(&ctx.meta_path).await;
                    downloaded = 0;
                    total_size = ctx.total_size;
                    progress.emit(0, total_size, true);
                    continue 'transfer;
                } else {
                    // 200 且无有效 Content-Range：服务器不支持 Range（或远端已变）→ 截断 part 从头写。
                    // Remove the old prefix before associating it with new response validators.
                    if downloaded > 0 {
                        tokio::fs::remove_file(&ctx.part_path)
                            .await
                            .map_err(|error| {
                                DownloadError::non_retryable(format!("无法重置临时文件：{error}"))
                            })?;
                    }
                    if let Some(length) = response.content_length() {
                        if length > 0 {
                            total_size = length;
                        }
                    }
                    downloaded = 0;
                    etag = response_etag.clone().or(etag);
                    last_modified = response_last_modified.clone().or(last_modified);
                    save_part_meta(ctx, total_size, &etag, &last_modified);
                    progress.emit(0, total_size, true);
                    match run_stream_attempt(
                        ctx,
                        sink,
                        &mut retries_used,
                        response,
                        false,
                        0,
                        total_size,
                        &etag,
                        &last_modified,
                        &mut progress,
                    )
                    .await?
                    {
                        Some(outcome) => return Ok(outcome),
                        None => continue 'transfer,
                    }
                }
            }
            416 => {
                // `Content-Range: bytes */N` 且 N == 已下载长度 → 已经完整。
                let range_total = header_text(&response, reqwest::header::CONTENT_RANGE)
                    .and_then(|value| parse_content_range(&value))
                    .and_then(|range| range.total);
                if downloaded > 0 && range_total == Some(downloaded) {
                    return finish_transfer(
                        ctx,
                        downloaded,
                        range_total.unwrap_or(downloaded),
                        etag,
                        last_modified,
                        &mut progress,
                    )
                    .await;
                }
                if remote_reset_used {
                    return Err(DownloadError::non_retryable(
                        "无法继续断点续传：远端文件已变化或服务器拒绝 Range 请求",
                    ));
                }
                remote_reset_used = true;
                let _ = tokio::fs::remove_file(&ctx.part_path).await;
                let _ = tokio::fs::remove_file(&ctx.meta_path).await;
                downloaded = 0;
                total_size = ctx.total_size;
                progress.emit(0, total_size, true);
                continue 'transfer;
            }
            401 | 403 | 404 => {
                return Err(DownloadError::non_retryable(sources::map_http_error(
                    ctx.source,
                    status,
                    "下载文件",
                )));
            }
            code if status_is_retryable(code) => {
                let reason = sources::map_http_error(ctx.source, status, "下载文件");
                if let Some(outcome) = retry_or_stop(
                    ctx,
                    sink,
                    &mut retries_used,
                    &reason,
                    downloaded,
                    total_size,
                    &etag,
                    &last_modified,
                )
                .await?
                {
                    return Ok(outcome);
                }
                continue 'transfer;
            }
            _ => {
                return Err(DownloadError::non_retryable(sources::map_http_error(
                    ctx.source,
                    status,
                    "下载文件",
                )));
            }
        }
    }
}

/// 流式写入完成后：足够长则完成，不足则按可重试中断处理。
#[allow(clippy::too_many_arguments)]
async fn finish_or_retry(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    retries_used: &mut u32,
    written: u64,
    total_size: u64,
    etag: &Option<String>,
    last_modified: &Option<String>,
    progress: &mut ProgressReporter<'_>,
) -> Result<Option<TransferOutcome>, DownloadError> {
    let complete = total_size > 0 && written >= total_size;
    let unknown_total_finished = total_size == 0;
    if complete || unknown_total_finished {
        let outcome = finish_transfer(
            ctx,
            written,
            total_size,
            etag.clone(),
            last_modified.clone(),
            progress,
        )
        .await?;
        return Ok(Some(outcome));
    }
    let reason = format!("连接中断，文件未下载完整（已下载 {written}/{total_size} 字节）");
    save_part_meta(ctx, total_size, etag, last_modified);
    retry_or_stop(
        ctx,
        sink,
        retries_used,
        &reason,
        written,
        total_size,
        etag,
        last_modified,
    )
    .await
}

// ---------------------------------------------------------------------------
// 单元测试（纯函数）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_range_variants() {
        assert_eq!(
            parse_content_range("bytes 0-499/1234"),
            Some(ContentRange {
                start: Some(0),
                end: Some(499),
                total: Some(1234)
            })
        );
        assert_eq!(
            parse_content_range("bytes 300-999/1000"),
            Some(ContentRange {
                start: Some(300),
                end: Some(999),
                total: Some(1000)
            })
        );
        assert_eq!(
            parse_content_range("bytes */1000"),
            Some(ContentRange {
                start: None,
                end: None,
                total: Some(1000)
            })
        );
        assert_eq!(
            parse_content_range("bytes 0-99/*"),
            Some(ContentRange {
                start: Some(0),
                end: Some(99),
                total: None
            })
        );
        assert_eq!(parse_content_range("garbage"), None);
        assert_eq!(parse_content_range("bytes 10-5/100"), None);
        assert_eq!(parse_content_range("bytes 0-99"), None);
    }

    #[test]
    fn retryable_status_classification() {
        for retryable in [408, 429, 500, 502, 503, 504, 599] {
            assert!(status_is_retryable(retryable), "{retryable} 应可重试");
        }
        for fatal in [400, 401, 403, 404, 410, 416, 422] {
            assert!(!status_is_retryable(fatal), "{fatal} 不应重试");
        }
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        assert_eq!(backoff_delay(1), Duration::from_secs(1));
        assert_eq!(backoff_delay(2), Duration::from_secs(2));
        assert_eq!(backoff_delay(3), Duration::from_secs(4));
        assert_eq!(backoff_delay(4), Duration::from_secs(8));
        assert_eq!(backoff_delay(16), Duration::from_secs(30));
    }

    #[test]
    fn resume_headers_validation() {
        let mut meta = PartMeta {
            etag: Some("\"abc\"".to_string()),
            last_modified: Some("Wed, 21 Oct 2015 07:28:00 GMT".to_string()),
            total: 100,
            ..Default::default()
        };
        assert!(resume_headers_match(
            &meta,
            Some("\"abc\""),
            Some("Wed, 21 Oct 2015 07:28:00 GMT")
        ));
        assert!(!resume_headers_match(
            &meta,
            Some("\"def\""),
            Some("Wed, 21 Oct 2015 07:28:00 GMT")
        ));
        assert!(!resume_headers_match(
            &meta,
            Some("\"abc\""),
            Some("Thu, 22 Oct 2015 07:28:00 GMT")
        ));
        // 记录缺失或响应缺失时不阻塞续传。
        meta.etag = None;
        assert!(resume_headers_match(&meta, Some("\"def\""), None));
        meta.last_modified = None;
        assert!(resume_headers_match(&meta, None, None));
    }
}
