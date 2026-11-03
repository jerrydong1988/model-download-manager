//! v0.2.0 单文件多连接分段下载引擎（契约 §5.8）。
//!
//! - 探头：`Range: bytes=0-0` 探测远端是否支持 Range（206 或 ModelScope 的 200+Content-Range），
//!   同时取得 total/etag/lastModified；不支持则回退单流引擎；
//! - 固定分块 16MiB，`chunks[i]` 记录各块已完成字节；连接池从「未完成且未认领」的块领取；
//! - 每个连接独立文件句柄 `seek+write`；预分配 `set_len(total)`；
//! - 旧单流 `.part`（连续前缀，无 chunks 元数据）按 `floor(len/chunk)` 转换，保留断点；
//! - 暂停/取消/限速/每块重试/进度 ≤4/s 与单流一致；失败保留 `.part` + 元数据；
//! - 完成后删除 `.part.json` 并原子 rename。
//!
//! 本模块不依赖 Tauri，可被单元/集成测试直接驱动。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::{join_all, BoxFuture};
use futures_util::StreamExt;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::download::{
    backoff_delay, header_text, parse_content_range, part_length, sleep_with_control,
    status_is_retryable, with_control, DownloadError, PartMeta, TransferContext, TransferOutcome,
    WaitOutcome,
};
use crate::sources;
use crate::util::{self, EventSink};

/// 分段大小：固定 16 MiB（最后一块可短）。
pub const CHUNK_SIZE: u64 = 16 * 1024 * 1024;

/// 进度事件最小间隔（与单流一致 ≤4 次/秒）。
const PROGRESS_INTERVAL_MS: u64 = 250;
/// 分段元数据落盘间隔。
const META_SAVE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1000);

/// 分段引擎结果：完成/暂停/取消，或探测不支持 Range 需要回退单流。
pub(crate) enum Attempt {
    Done(TransferOutcome),
    Fallback,
}

/// 尝试用多连接分段引擎下载；无法分段时返回 [`Attempt::Fallback`]。
pub(crate) async fn attempt(
    ctx: &TransferContext,
    sink: &dyn EventSink,
) -> Result<Attempt, DownloadError> {
    let stored: PartMeta = util::read_json_opt(&ctx.meta_path).unwrap_or_default();
    let part_len = part_length(&ctx.part_path).await;
    let initial = InitialProgress::from_stored(&stored, part_len);

    // 0. 启动前暂停/取消检查。
    if ctx.control.is_cancelled() {
        return Ok(Attempt::Done(TransferOutcome::Cancelled {
            downloaded: initial.downloaded,
            total_size: initial.total,
        }));
    }
    if ctx.control.is_paused() {
        return Ok(Attempt::Done(TransferOutcome::Paused {
            downloaded: initial.downloaded,
            total_size: initial.total,
            etag: initial.etag,
            last_modified: initial.last_modified,
        }));
    }

    // 1. Range 探测。
    let probe = match probe_remote(ctx).await? {
        ProbeOutcome::Supported(probe) => probe,
        ProbeOutcome::Unsupported => return Ok(Attempt::Fallback),
        ProbeOutcome::Paused => {
            return Ok(Attempt::Done(TransferOutcome::Paused {
                downloaded: initial.downloaded,
                total_size: initial.total,
                etag: initial.etag,
                last_modified: initial.last_modified,
            }))
        }
        ProbeOutcome::Cancelled => {
            return Ok(Attempt::Done(TransferOutcome::Cancelled {
                downloaded: initial.downloaded,
                total_size: initial.total,
            }))
        }
    };

    let total = probe.total;
    let chunk_size = ctx.chunk_size_override.unwrap_or(CHUNK_SIZE).max(1);
    let nchunks = ((total + chunk_size - 1) / chunk_size) as usize;
    if nchunks <= 1 {
        // 只有一个分块：交给原单流引擎（若已有分段元数据需先清理，避免预分配文件干扰）。
        if stored.is_segmented() {
            let _ = tokio::fs::remove_file(&ctx.part_path).await;
            let _ = tokio::fs::remove_file(&ctx.meta_path).await;
        }
        return Ok(Attempt::Fallback);
    }

    // 2. Remote changes invalidate both legacy and segmented partial data.
    let mut stored = stored;
    let mut part_len = part_len;
    let size_changed = stored.total > 0 && stored.total != total;
    let metadata_changed = mismatch(stored.etag.as_deref(), probe.etag.as_deref())
        || mismatch(
            stored.last_modified.as_deref(),
            probe.last_modified.as_deref(),
        );
    let remote_changed = size_changed || metadata_changed;
    if remote_changed {
        let _ = tokio::fs::remove_file(&ctx.part_path).await;
        let _ = tokio::fs::remove_file(&ctx.meta_path).await;
        stored = PartMeta::default();
        part_len = 0;
    }

    // 3. 旧单流 part 长度为 total 且无分段元数据 → 与单流语义一致，视为已完成。
    if !stored.is_segmented() && total > 0 && part_len == total {
        return finish_files(ctx, sink, total, probe.etag, probe.last_modified).map(Attempt::Done);
    }

    // 4. 计算分段进度。
    let segments = if stored.is_segmented()
        && part_len == total
        && stored.total == total
        && stored.chunk_size == Some(chunk_size)
        && stored.chunks.as_ref().map(Vec::len) == Some(nchunks)
    {
        match stored.chunks.as_ref() {
            Some(chunks) => Segments::from_meta(total, chunk_size, chunks),
            None => Segments::new(total, chunk_size),
        }
    } else if stored.is_segmented() {
        // 分段元数据与当前参数不匹配（预分配文件不可信）→ 丢弃重下。
        let _ = tokio::fs::remove_file(&ctx.part_path).await;
        let _ = tokio::fs::remove_file(&ctx.meta_path).await;
        Segments::new(total, chunk_size)
    } else if part_len > 0 && part_len < total {
        // 旧单流连续前缀 → 转换为分段进度，保留断点。
        Segments::from_prefix(part_len, total, chunk_size)
    } else {
        Segments::new(total, chunk_size)
    };

    let etag = probe.etag.clone();
    let last_modified = probe.last_modified.clone();
    // The sidecar must be durable BEFORE the file can acquire a misleading full length.
    save_segmented_meta(
        ctx,
        total,
        chunk_size,
        &segments.chunks,
        &etag,
        &last_modified,
    )?;

    // 5. 预分配 `.part` 到 total 长度（保留已有前缀内容）。
    {
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .open(&ctx.part_path)
            .await
            .map_err(|err| {
                DownloadError::non_retryable(format!(
                    "无法创建临时文件（磁盘空间不足或权限不足）：{err}"
                ))
            })?;
        file.set_len(total).await.map_err(|err| {
            DownloadError::non_retryable(format!(
                "无法预分配临时文件（磁盘空间不足或权限不足）：{err}"
            ))
        })?;
    }

    let mut progress_throttle = ProgressThrottle::new(&ctx.task_id);
    if segments.all_complete() {
        let downloaded = segments.downloaded();
        save_segmented_meta(
            ctx,
            total,
            chunk_size,
            &segments.chunks,
            &etag,
            &last_modified,
        )?;
        util::emit_progress(sink, &ctx.task_id, downloaded, total, 0);
        return finish_files(ctx, sink, total, etag, last_modified).map(Attempt::Done);
    }

    save_segmented_meta(
        ctx,
        total,
        chunk_size,
        &segments.chunks,
        &etag,
        &last_modified,
    )?;
    util::emit_progress(sink, &ctx.task_id, segments.downloaded(), total, 0);
    progress_throttle.reset();

    // 6. 启动连接池。
    let plan = Arc::new(Plan {
        total,
        chunk_size,
        part_path: ctx.part_path.clone(),
        url: ctx.url.clone(),
        client: ctx.client.clone(),
        auth_token: ctx.auth_token.clone(),
        etag: etag.clone(),
        last_modified: last_modified.clone(),
    });
    let shared = Arc::new(Shared {
        state: Mutex::new(SegState {
            segments: segments.clone(),
            claimed: vec![false; nchunks],
        }),
        control: ctx.control.clone(),
        fatal: Mutex::new(None),
        retry_counter: AtomicU64::new(0),
        progress: Mutex::new(ProgressThrottle::new(&ctx.task_id)),
    });

    // 元数据定时落盘（后台任务；worker 结束时 abort）。
    let saver = spawn_meta_saver(
        ctx.meta_path.clone(),
        ctx.repo_id.clone(),
        ctx.remote_path.clone(),
        shared.clone(),
        plan.clone(),
        etag.clone(),
        last_modified.clone(),
    );

    let connections = ctx.connections.clamp(1, 8) as usize;
    let worker_count = connections.min(nchunks);
    let mut workers: Vec<BoxFuture<'_, WorkerEnd>> = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        workers.push(Box::pin(run_worker(
            ctx,
            sink,
            plan.clone(),
            shared.clone(),
        )));
    }
    let ends = join_all(workers).await;
    saver.abort();
    let _ = saver.await;

    // 7. 汇总结果（取消 > 暂停 > 错误 > 完成）。
    let cancelled =
        ctx.control.is_cancelled() || ends.iter().any(|end| matches!(end, WorkerEnd::Cancelled));
    let paused = ctx.control.is_paused() || ends.iter().any(|end| matches!(end, WorkerEnd::Paused));
    let fatal = shared.peek_fatal().or_else(|| {
        ends.iter().find_map(|end| match end {
            WorkerEnd::Fatal(err) => Some(err.clone()),
            _ => None,
        })
    });
    let (downloaded, complete) = shared.snapshot();

    if cancelled {
        save_segmented_meta(
            ctx,
            total,
            chunk_size,
            &shared.chunks_snapshot(),
            &etag,
            &last_modified,
        )?;
        util::emit_progress(sink, &ctx.task_id, downloaded, total, 0);
        return Ok(Attempt::Done(TransferOutcome::Cancelled {
            downloaded,
            total_size: total,
        }));
    }
    if paused {
        save_segmented_meta(
            ctx,
            total,
            chunk_size,
            &shared.chunks_snapshot(),
            &etag,
            &last_modified,
        )?;
        util::emit_progress(sink, &ctx.task_id, downloaded, total, 0);
        return Ok(Attempt::Done(TransferOutcome::Paused {
            downloaded,
            total_size: total,
            etag,
            last_modified,
        }));
    }
    if let Some(err) = fatal {
        save_segmented_meta(
            ctx,
            total,
            chunk_size,
            &shared.chunks_snapshot(),
            &etag,
            &last_modified,
        )?;
        return Err(err);
    }
    if complete {
        return finish_files(ctx, sink, total, etag, last_modified).map(Attempt::Done);
    }
    save_segmented_meta(
        ctx,
        total,
        chunk_size,
        &shared.chunks_snapshot(),
        &etag,
        &last_modified,
    )?;
    Err(DownloadError::retryable(
        "多连接分段下载未能全部完成，请重试任务",
    ))
}

// ---------------------------------------------------------------------------
// 探头
// ---------------------------------------------------------------------------

struct Probe {
    total: u64,
    etag: Option<String>,
    last_modified: Option<String>,
}

enum ProbeOutcome {
    Supported(Probe),
    Unsupported,
    Paused,
    Cancelled,
}

async fn probe_remote(ctx: &TransferContext) -> Result<ProbeOutcome, DownloadError> {
    let mut attempts = 0u32;
    loop {
        let mut request = ctx
            .client
            .get(&ctx.url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .header(reqwest::header::RANGE, "bytes=0-0");
        if let Some(token) = ctx.auth_token.as_deref() {
            request = request.bearer_auth(token);
        }
        let response = match with_control(&ctx.control, request.send()).await {
            Ok(Ok(response)) => response,
            Err(WaitOutcome::Cancelled) => return Ok(ProbeOutcome::Cancelled),
            Err(_) => return Ok(ProbeOutcome::Paused),
            Ok(Err(err)) => {
                attempts += 1;
                if attempts > ctx.max_retries {
                    return Err(DownloadError::retryable(util::redact_urls(&format!(
                        "分段下载探测网络请求失败（{err}）"
                    ))));
                }
                match sleep_with_control(&ctx.control, backoff_delay(attempts)).await {
                    WaitOutcome::Done => continue,
                    WaitOutcome::Paused => return Ok(ProbeOutcome::Paused),
                    WaitOutcome::Cancelled => return Ok(ProbeOutcome::Cancelled),
                }
            }
        };

        let status = response.status();
        let content_range = header_text(&response, reqwest::header::CONTENT_RANGE)
            .and_then(|value| parse_content_range(&value));
        let etag = header_text(&response, reqwest::header::ETAG);
        let last_modified = header_text(&response, reqwest::header::LAST_MODIFIED);

        match status.as_u16() {
            200 | 206 => {
                if let Some(range) = content_range {
                    if range.start == Some(0) {
                        if let Some(total) = range.total.filter(|total| *total > 0) {
                            return Ok(ProbeOutcome::Supported(Probe {
                                total,
                                etag,
                                last_modified,
                            }));
                        }
                    }
                }
                // 200 且无可用 Content-Range：服务器忽略 Range（不支持分段）。
                return Ok(ProbeOutcome::Unsupported);
            }
            401 | 403 | 404 => {
                return Err(DownloadError::non_retryable(sources::map_http_error(
                    ctx.source,
                    status,
                    "分段下载探测",
                )))
            }
            code if status_is_retryable(code) => {
                attempts += 1;
                if attempts > ctx.max_retries {
                    return Err(DownloadError::retryable(sources::map_http_error(
                        ctx.source,
                        status,
                        "分段下载探测",
                    )));
                }
                match sleep_with_control(&ctx.control, backoff_delay(attempts)).await {
                    WaitOutcome::Done => continue,
                    WaitOutcome::Paused => return Ok(ProbeOutcome::Paused),
                    WaitOutcome::Cancelled => return Ok(ProbeOutcome::Cancelled),
                }
            }
            _ => return Ok(ProbeOutcome::Unsupported),
        }
    }
}

// ---------------------------------------------------------------------------
// 分段状态
// ---------------------------------------------------------------------------

/// 各分块完成进度。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Segments {
    pub total: u64,
    pub chunk_size: u64,
    pub chunks: Vec<u64>,
}

impl Segments {
    pub(crate) fn new(total: u64, chunk_size: u64) -> Self {
        let nchunks = ((total + chunk_size - 1) / chunk_size) as usize;
        Self {
            total,
            chunk_size,
            chunks: vec![0; nchunks],
        }
    }

    /// 旧单流 `.part`（连续前缀）→ 分段进度：`floor(len/chunk)` 块完成 + 边界块部分。
    pub(crate) fn from_prefix(prefix_len: u64, total: u64, chunk_size: u64) -> Self {
        let mut segments = Self::new(total, chunk_size);
        for (index, done) in segments.chunks.iter_mut().enumerate() {
            let start = index as u64 * chunk_size;
            let end = (start + chunk_size).min(total);
            *done = prefix_len.saturating_sub(start).min(end - start);
        }
        segments
    }

    fn from_meta(total: u64, chunk_size: u64, chunks: &[u64]) -> Self {
        let mut segments = Self::new(total, chunk_size);
        if chunks.len() == segments.chunks.len() {
            for (index, done) in chunks.iter().enumerate() {
                let chunk_len = segments.chunk_len(index);
                segments.chunks[index] = (*done).min(chunk_len);
            }
        }
        segments
    }

    fn chunk_len(&self, index: usize) -> u64 {
        let start = index as u64 * self.chunk_size;
        (self.total - start).min(self.chunk_size)
    }

    pub(crate) fn downloaded(&self) -> u64 {
        self.chunks.iter().sum()
    }

    fn all_complete(&self) -> bool {
        self.chunks
            .iter()
            .enumerate()
            .all(|(index, done)| *done >= self.chunk_len(index))
    }
}

struct SegState {
    segments: Segments,
    claimed: Vec<bool>,
}

struct Shared {
    state: Mutex<SegState>,
    control: Arc<crate::state::TaskControl>,
    fatal: Mutex<Option<DownloadError>>,
    retry_counter: AtomicU64,
    progress: Mutex<ProgressThrottle>,
}

impl Shared {
    fn claim(&self) -> Option<Job> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for index in 0..state.segments.chunks.len() {
            let chunk_len = state.segments.chunk_len(index);
            if state.segments.chunks[index] < chunk_len && !state.claimed[index] {
                state.claimed[index] = true;
                let start = index as u64 * state.segments.chunk_size;
                let end = start + chunk_len - 1;
                return Some(Job { index, start, end });
            }
        }
        None
    }

    fn chunk_done(&self, index: usize) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .segments
            .chunks[index]
    }

    fn update(&self, index: usize, done: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let chunk_len = state.segments.chunk_len(index);
        let done = done.min(chunk_len);
        if done > state.segments.chunks[index] {
            state.segments.chunks[index] = done;
        }
    }

    fn snapshot(&self) -> (u64, bool) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (state.segments.downloaded(), state.segments.all_complete())
    }

    fn chunks_snapshot(&self) -> Vec<u64> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .segments
            .chunks
            .clone()
    }

    fn set_fatal(&self, error: DownloadError) {
        let mut fatal = self
            .fatal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if fatal.is_none() {
            *fatal = Some(error);
        }
    }

    fn peek_fatal(&self) -> Option<DownloadError> {
        self.fatal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn bump_retry(&self, ctx: &TransferContext) {
        let retries = self.retry_counter.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(callback) = &ctx.on_retry {
            callback(retries.min(u32::MAX as u64) as u32);
        }
    }

    fn emit_progress(&self, sink: &dyn EventSink, ctx: &TransferContext, total: u64) {
        let downloaded = self.snapshot().0;
        let mut progress = self
            .progress
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        progress.emit(sink, &ctx.task_id, downloaded, total);
    }
}

struct Job {
    index: usize,
    start: u64,
    end: u64,
}

struct Plan {
    total: u64,
    chunk_size: u64,
    part_path: PathBuf,
    url: String,
    client: reqwest::Client,
    auth_token: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
}

// ---------------------------------------------------------------------------
// 进度限流
// ---------------------------------------------------------------------------

struct ProgressThrottle {
    last_emit_ms: u64,
    last_bytes: u64,
}

impl ProgressThrottle {
    fn new(_task_id: &str) -> Self {
        Self {
            last_emit_ms: 0,
            last_bytes: 0,
        }
    }

    fn reset(&mut self) {
        self.last_emit_ms = 0;
        self.last_bytes = 0;
    }

    fn emit(&mut self, sink: &dyn EventSink, task_id: &str, downloaded: u64, total: u64) {
        let now = util::now_millis();
        if now.saturating_sub(self.last_emit_ms) < PROGRESS_INTERVAL_MS {
            return;
        }
        let elapsed = now.saturating_sub(self.last_emit_ms).max(1);
        let delta = downloaded.saturating_sub(self.last_bytes);
        let speed = delta.saturating_mul(1000) / elapsed;
        self.last_emit_ms = now;
        self.last_bytes = downloaded;
        util::emit_progress(sink, task_id, downloaded, total, speed);
    }
}

// ---------------------------------------------------------------------------
// 连接 worker
// ---------------------------------------------------------------------------

enum WorkerEnd {
    Done,
    Paused,
    Cancelled,
    Fatal(DownloadError),
}

enum ChunkEnd {
    Paused,
    Cancelled,
    Fatal(DownloadError),
}

async fn run_worker(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    plan: Arc<Plan>,
    shared: Arc<Shared>,
) -> WorkerEnd {
    let mut file = match OpenOptions::new().write(true).open(&plan.part_path).await {
        Ok(file) => file,
        Err(err) => {
            return WorkerEnd::Fatal(DownloadError::non_retryable(format!(
                "无法打开临时文件（权限不足或文件被占用）：{err}"
            )))
        }
    };

    loop {
        if shared.control.is_cancelled() {
            return WorkerEnd::Cancelled;
        }
        if shared.control.is_paused() {
            return WorkerEnd::Paused;
        }
        if let Some(error) = shared.peek_fatal() {
            return WorkerEnd::Fatal(error);
        }
        let Some(job) = shared.claim() else {
            return WorkerEnd::Done;
        };
        match fetch_chunk(ctx, sink, &plan, &shared, &mut file, job).await {
            Ok(()) => {}
            Err(ChunkEnd::Paused) => return WorkerEnd::Paused,
            Err(ChunkEnd::Cancelled) => return WorkerEnd::Cancelled,
            Err(ChunkEnd::Fatal(error)) => {
                shared.set_fatal(error.clone());
                return WorkerEnd::Fatal(error);
            }
        }
    }
}

async fn fetch_chunk(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    plan: &Plan,
    shared: &Arc<Shared>,
    file: &mut tokio::fs::File,
    job: Job,
) -> Result<(), ChunkEnd> {
    let mut retries = 0u32;
    loop {
        if shared.control.is_cancelled() {
            return Err(ChunkEnd::Cancelled);
        }
        if shared.control.is_paused() {
            return Err(ChunkEnd::Paused);
        }
        if let Some(error) = shared.peek_fatal() {
            return Err(ChunkEnd::Fatal(error));
        }
        let offset = job.start + shared.chunk_done(job.index);
        if offset > job.end {
            return Ok(());
        }
        let range = format!("bytes={offset}-{}", job.end);
        let mut request = plan
            .client
            .get(&plan.url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .header(reqwest::header::RANGE, range);
        if let Some(validator) = plan.etag.as_deref().or(plan.last_modified.as_deref()) {
            request = request.header(reqwest::header::IF_RANGE, validator);
        }
        if let Some(token) = plan.auth_token.as_deref() {
            request = request.bearer_auth(token);
        }

        let response = match with_control(&ctx.control, request.send()).await {
            Ok(Ok(response)) => response,
            Err(WaitOutcome::Cancelled) => return Err(ChunkEnd::Cancelled),
            Err(_) => return Err(ChunkEnd::Paused),
            Ok(Err(err)) => {
                let reason = util::redact_urls(&format!("网络请求失败（{err}）"));
                if let Some(end) = retry_or_end(ctx, shared, &mut retries, &reason).await {
                    return Err(end);
                }
                continue;
            }
        };

        let status = response.status();
        let content_range = header_text(&response, reqwest::header::CONTENT_RANGE)
            .and_then(|value| parse_content_range(&value));
        match status.as_u16() {
            200 | 206 => {
                if mismatch(
                    plan.etag.as_deref(),
                    header_text(&response, reqwest::header::ETAG).as_deref(),
                ) || mismatch(
                    plan.last_modified.as_deref(),
                    header_text(&response, reqwest::header::LAST_MODIFIED).as_deref(),
                ) {
                    return Err(ChunkEnd::Fatal(DownloadError::non_retryable(
                        "远端文件版本在下载期间变化，请重试任务",
                    )));
                }
                let range_ok = content_range
                    .map(|range| {
                        range.start == Some(offset)
                            && range.end == Some(job.end)
                            && range.total == Some(plan.total)
                    })
                    .unwrap_or(false);
                if !range_ok {
                    if status.as_u16() == 200 && content_range.is_none() {
                        return Err(ChunkEnd::Fatal(DownloadError::non_retryable(
                            "服务器不再支持分段 Range，请重新开始下载",
                        )));
                    }
                    return Err(ChunkEnd::Fatal(DownloadError::non_retryable(
                        "远端文件已变化（Content-Range 与预期不一致），请重新开始下载",
                    )));
                }
                match stream_chunk(ctx, sink, plan, shared, file, &job, offset, response).await {
                    Ok(written) => {
                        if written > job.end + 1 {
                            return Err(ChunkEnd::Fatal(DownloadError::non_retryable(
                                "分块响应长度超出预期",
                            )));
                        }
                        if written == job.end + 1 {
                            return Ok(());
                        }
                        if let Some(end) =
                            retry_or_end(ctx, shared, &mut retries, "连接中断，分块未下载完整")
                                .await
                        {
                            return Err(end);
                        }
                        continue;
                    }
                    Err(end) => return Err(end),
                }
            }
            401 | 403 | 404 => {
                return Err(ChunkEnd::Fatal(DownloadError::non_retryable(
                    sources::map_http_error(ctx.source, status, "分段下载"),
                )))
            }
            code if status_is_retryable(code) => {
                let reason = sources::map_http_error(ctx.source, status, "分段下载");
                if let Some(end) = retry_or_end(ctx, shared, &mut retries, &reason).await {
                    return Err(end);
                }
                continue;
            }
            _ => {
                return Err(ChunkEnd::Fatal(DownloadError::non_retryable(
                    sources::map_http_error(ctx.source, status, "分段下载"),
                )))
            }
        }
    }
}

/// 流式写入当前分块；返回已写入到的绝对偏移（exclusive）。
#[allow(clippy::too_many_arguments)]
async fn stream_chunk(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    plan: &Plan,
    shared: &Arc<Shared>,
    file: &mut tokio::fs::File,
    job: &Job,
    start_offset: u64,
    response: reqwest::Response,
) -> Result<u64, ChunkEnd> {
    file.seek(std::io::SeekFrom::Start(start_offset))
        .await
        .map_err(|err| {
            ChunkEnd::Fatal(DownloadError::non_retryable(format!(
                "写入文件失败（磁盘空间不足或权限不足）：{err}"
            )))
        })?;
    let mut written = start_offset;
    let mut stream = response.bytes_stream();
    loop {
        let item = match with_control(&ctx.control, stream.next()).await {
            Ok(Some(item)) => item,
            Ok(None) => break,
            Err(reason) => {
                let _ = file.flush().await;
                return Err(if matches!(reason, WaitOutcome::Cancelled) {
                    ChunkEnd::Cancelled
                } else {
                    ChunkEnd::Paused
                });
            }
        };
        if shared.control.is_cancelled() {
            let _ = file.flush().await;
            return Err(ChunkEnd::Cancelled);
        }
        if shared.control.is_paused() {
            let _ = file.flush().await;
            return Err(ChunkEnd::Paused);
        }
        if let Some(error) = shared.peek_fatal() {
            let _ = file.flush().await;
            return Err(ChunkEnd::Fatal(error));
        }
        let chunk = match item {
            Ok(chunk) => chunk,
            // 连接中断：保存已写字节后按短块重试。
            Err(_) => break,
        };
        if chunk.is_empty() {
            continue;
        }
        if written + chunk.len() as u64 > job.end + 1 {
            return Err(ChunkEnd::Fatal(DownloadError::non_retryable(
                "分块响应长度超出预期",
            )));
        }
        if let Err(reason) =
            with_control(&ctx.control, ctx.limiter.acquire(chunk.len() as u64)).await
        {
            let _ = file.flush().await;
            return Err(if matches!(reason, WaitOutcome::Cancelled) {
                ChunkEnd::Cancelled
            } else {
                ChunkEnd::Paused
            });
        }
        if shared.control.is_cancelled() {
            let _ = file.flush().await;
            return Err(ChunkEnd::Cancelled);
        }
        if shared.control.is_paused() {
            let _ = file.flush().await;
            return Err(ChunkEnd::Paused);
        }
        if let Err(err) = file.write_all(&chunk).await {
            return Err(ChunkEnd::Fatal(DownloadError::non_retryable(format!(
                "写入文件失败（磁盘空间不足或权限不足）：{err}"
            ))));
        }
        file.flush().await.map_err(|error| {
            ChunkEnd::Fatal(DownloadError::non_retryable(format!(
                "写入分块失败：{error}"
            )))
        })?;
        written += chunk.len() as u64;
        shared.update(job.index, written - job.start);
        shared.emit_progress(sink, ctx, plan.total);
    }
    let _ = file.flush().await;
    Ok(written)
}

async fn retry_or_end(
    ctx: &TransferContext,
    shared: &Arc<Shared>,
    retries: &mut u32,
    reason: &str,
) -> Option<ChunkEnd> {
    if *retries >= ctx.max_retries {
        return Some(ChunkEnd::Fatal(DownloadError::retryable(format!(
            "分块下载失败：已重试 {} 次仍失败（{reason}）",
            retries
        ))));
    }
    *retries += 1;
    shared.bump_retry(ctx);
    match sleep_with_control(&ctx.control, backoff_delay(*retries)).await {
        WaitOutcome::Done => None,
        WaitOutcome::Paused => Some(ChunkEnd::Paused),
        WaitOutcome::Cancelled => Some(ChunkEnd::Cancelled),
    }
}

// ---------------------------------------------------------------------------
// 元数据 / 完成
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct InitialProgress {
    downloaded: u64,
    total: u64,
    etag: Option<String>,
    last_modified: Option<String>,
}

impl InitialProgress {
    fn from_stored(stored: &PartMeta, part_len: u64) -> Self {
        let total = stored.total;
        let downloaded = if stored.is_segmented() {
            stored.segmented_downloaded().unwrap_or(0)
        } else if total > 0 {
            part_len.min(total)
        } else {
            part_len
        };
        Self {
            downloaded,
            total,
            etag: stored.etag.clone(),
            last_modified: stored.last_modified.clone(),
        }
    }
}

fn mismatch(saved: Option<&str>, current: Option<&str>) -> bool {
    match (
        saved.filter(|value| !value.trim().is_empty()),
        current.filter(|value| !value.trim().is_empty()),
    ) {
        (Some(saved), Some(current)) => saved != current,
        _ => false,
    }
}

fn save_segmented_meta(
    ctx: &TransferContext,
    total: u64,
    chunk_size: u64,
    chunks: &[u64],
    etag: &Option<String>,
    last_modified: &Option<String>,
) -> Result<(), DownloadError> {
    let meta = PartMeta {
        etag: etag.clone(),
        last_modified: last_modified.clone(),
        total,
        repo_id: ctx.repo_id.clone(),
        remote_path: ctx.remote_path.clone(),
        chunk_size: Some(chunk_size),
        chunks: Some(chunks.to_vec()),
    };
    util::atomic_write_json(&ctx.meta_path, &meta)
        .map_err(|err| DownloadError::non_retryable(format!("保存分段断点信息失败：{err}")))
}

fn save_segmented_meta_owned(
    meta_path: &std::path::Path,
    repo_id: &str,
    remote_path: &str,
    total: u64,
    chunk_size: u64,
    chunks: Vec<u64>,
    etag: &Option<String>,
    last_modified: &Option<String>,
) -> Result<(), DownloadError> {
    let meta = PartMeta {
        etag: etag.clone(),
        last_modified: last_modified.clone(),
        total,
        repo_id: repo_id.to_string(),
        remote_path: remote_path.to_string(),
        chunk_size: Some(chunk_size),
        chunks: Some(chunks),
    };
    util::atomic_write_json(meta_path, &meta)
        .map_err(|err| DownloadError::non_retryable(format!("保存分段断点信息失败：{err}")))
}

fn spawn_meta_saver(
    meta_path: PathBuf,
    repo_id: String,
    remote_path: String,
    shared: Arc<Shared>,
    plan: Arc<Plan>,
    etag: Option<String>,
    last_modified: Option<String>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(META_SAVE_INTERVAL).await;
            let chunks = shared.chunks_snapshot();
            if let Err(error) = save_segmented_meta_owned(
                &meta_path,
                &repo_id,
                &remote_path,
                plan.total,
                plan.chunk_size,
                chunks,
                &etag,
                &last_modified,
            ) {
                shared.set_fatal(error);
                break;
            }
        }
    })
}

/// 完成：删除 `.part.json`，`part → final` 原子 rename，发最终进度。
fn finish_files(
    ctx: &TransferContext,
    sink: &dyn EventSink,
    total: u64,
    etag: Option<String>,
    last_modified: Option<String>,
) -> Result<TransferOutcome, DownloadError> {
    if let Err(err) = std::fs::rename(&ctx.part_path, &ctx.save_path) {
        return Err(DownloadError::non_retryable(format!(
            "无法完成文件重命名（文件可能被占用或权限不足）：{err}"
        )));
    }
    let _ = std::fs::remove_file(&ctx.meta_path);
    util::emit_progress(sink, &ctx.task_id, total, total, 0);
    Ok(TransferOutcome::Completed {
        downloaded: total,
        total_size: total,
        etag,
        last_modified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_from_prefix_converts_legacy_single_stream_part() {
        // 1000 字节、分块 128：旧单流 300 字节 → 2 块满(256) + 边界块 44。
        let segments = Segments::from_prefix(300, 1000, 128);
        assert_eq!(segments.chunks.len(), 8);
        assert_eq!(segments.chunks[0], 128);
        assert_eq!(segments.chunks[1], 128);
        assert_eq!(segments.chunks[2], 44);
        assert_eq!(segments.chunks[3], 0);
        assert_eq!(segments.downloaded(), 300);
        assert_eq!(segments.chunk_len(7), 1000 - 7 * 128);
        assert!(!segments.all_complete());

        // 已完整前缀 → 全部完成。
        let complete = Segments::from_prefix(1000, 1000, 128);
        assert!(complete.all_complete());
        assert_eq!(complete.downloaded(), 1000);
    }

    #[test]
    fn segments_new_and_from_meta_are_clamped() {
        let segments = Segments::new(1000, 128);
        assert_eq!(segments.chunks.len(), 8);
        let meta = Segments::from_meta(1000, 128, &[999, 5, 0, 0, 0, 0, 0, 0]);
        assert_eq!(meta.chunks[0], 128, "超长块进度应被钳制");
        assert_eq!(meta.chunks[1], 5);
        assert_eq!(meta.downloaded(), 133);
    }
}
