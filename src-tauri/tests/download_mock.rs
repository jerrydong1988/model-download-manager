//! 下载引擎集成测试：本地 tokio mock HTTP server（不联网）。
//!
//! 覆盖（ARCHITECTURE §3.5）：
//! - 中途断开 → Range 续传，最终内容与源一致；
//! - ModelScope 语义：`200 + Content-Range` 也按续传处理；
//! - HF 镜像语义：请求带 Range 但返回 200 全量 → 从头写，不写坏文件；
//! - 416 且 total == 旧 part 长度 → 重取响应体，不信任预分配长度；
//! - 5xx → 重试次数用尽后 error（重试次数正确）；
//! - 401 → 不重试；
//! - 暂停 → `.part` 保留，resume 后内容完整。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use model_download_manager_lib::download::{
    transfer, transfer_auto, TransferContext, TransferOutcome,
};
use model_download_manager_lib::models::Source;
use model_download_manager_lib::state::TaskControl;
use model_download_manager_lib::util::{self, BandwidthLimiter, EventSink, NoopSink};

const TOTAL: usize = 1000;
/// 1000 字节的可校验内容。
fn content() -> Vec<u8> {
    (0..TOTAL).map(|index| (index % 251) as u8).collect()
}

// ---------------------------------------------------------------------------
// 极简 HTTP/1.1 mock server
// ---------------------------------------------------------------------------

#[allow(dead_code)]
struct MockRequest {
    method: String,
    path: String,
    /// `Range: bytes=N-` 的起始偏移（无 Range 为 None）。
    range_start: Option<u64>,
    /// `Range: bytes=N-M` 的结束偏移（v0.2.0 分段下载测试使用）。
    range_end: Option<u64>,
}

struct MockResponse {
    status: u16,
    reason: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// 只发送前 N 字节后立刻关闭连接（模拟传输中途断开）。
    truncate_to: Option<usize>,
    /// 分块发送大小与块间延迟（模拟慢速服务器以便测试暂停）。
    chunk_size: Option<usize>,
    chunk_delay: Duration,
}

impl MockResponse {
    fn new(status: u16, reason: &'static str, body: Vec<u8>) -> Self {
        Self {
            status,
            reason,
            headers: Vec::new(),
            body,
            truncate_to: None,
            chunk_size: None,
            chunk_delay: Duration::ZERO,
        }
    }

    fn ok(body: Vec<u8>) -> Self {
        Self::new(200, "OK", body)
    }

    fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    fn truncated(mut self, bytes: usize) -> Self {
        self.truncate_to = Some(bytes);
        self
    }

    fn slow(mut self, chunk_size: usize, delay_ms: u64) -> Self {
        self.chunk_size = Some(chunk_size);
        self.chunk_delay = Duration::from_millis(delay_ms);
        self
    }
}

/// 启动 mock server，返回 `(base_url, request_counter)`。
async fn spawn_mock_server<F>(handler: F) -> (String, Arc<AtomicU64>)
where
    F: Fn(u64, &MockRequest) -> MockResponse + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let counter = Arc::new(AtomicU64::new(0));
    let counter_for_server = counter.clone();
    let handler = Arc::new(handler);

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let handler = handler.clone();
            let counter = counter_for_server.clone();
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    match socket.read(&mut chunk).await {
                        Ok(0) => return,
                        Ok(read) => {
                            buffer.extend_from_slice(&chunk[..read]);
                            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                                break;
                            }
                            if buffer.len() > 16_384 {
                                return;
                            }
                        }
                        Err(_) => return,
                    }
                }
                let text = String::from_utf8_lossy(&buffer).to_string();
                let mut lines = text.split("\r\n");
                let request_line = lines.next().unwrap_or("");
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("GET").to_string();
                let path = parts.next().unwrap_or("/").to_string();
                let mut range_start = None;
                let mut range_end = None;
                for line in lines {
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("range") {
                            if let Some(rest) = value.trim().strip_prefix("bytes=") {
                                let mut bounds = rest.split('-');
                                range_start =
                                    bounds.next().and_then(|start| start.parse::<u64>().ok());
                                range_end = bounds.next().and_then(|end| end.parse::<u64>().ok());
                            }
                        }
                    }
                }
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let request = MockRequest {
                    method,
                    path,
                    range_start,
                    range_end,
                };
                let response = handler(index, &request);

                let mut head = Vec::new();
                head.extend_from_slice(
                    format!("HTTP/1.1 {} {}\r\n", response.status, response.reason).as_bytes(),
                );
                let mut has_length = false;
                for (name, value) in &response.headers {
                    head.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
                    if name.eq_ignore_ascii_case("content-length") {
                        has_length = true;
                    }
                }
                if !has_length {
                    head.extend_from_slice(
                        format!("Content-Length: {}\r\n", response.body.len()).as_bytes(),
                    );
                }
                head.extend_from_slice(b"Connection: close\r\n\r\n");
                if socket.write_all(&head).await.is_err() {
                    return;
                }

                let send_length = response
                    .truncate_to
                    .unwrap_or(response.body.len())
                    .min(response.body.len());
                let body = &response.body[..send_length];
                match response.chunk_size {
                    Some(size) => {
                        for piece in body.chunks(size.max(1)) {
                            if socket.write_all(piece).await.is_err() {
                                return;
                            }
                            let _ = socket.flush().await;
                            tokio::time::sleep(response.chunk_delay).await;
                        }
                    }
                    None => {
                        if socket.write_all(body).await.is_err() {
                            return;
                        }
                    }
                }
                let _ = socket.flush().await;
                let _ = socket.shutdown().await;
            });
        }
    });

    (format!("http://{address}"), counter)
}

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

fn unique_dir(label: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "mdm-dl-test-{label}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn build_context(
    dir: &Path,
    url: String,
    control: Arc<TaskControl>,
    total_size: u64,
    max_retries: u32,
) -> TransferContext {
    let save_path = dir.join("model.safetensors");
    let part_path = util::with_suffix(&save_path, ".part");
    let meta_path = util::with_suffix(&save_path, ".part.json");
    TransferContext {
        task_id: "test-task".to_string(),
        repo_id: "org/model".to_string(),
        remote_path: "model.safetensors".to_string(),
        client: reqwest::Client::new(),
        url,
        source: Source::Huggingface,
        auth_token: None,
        save_path,
        part_path,
        meta_path,
        total_size,
        etag: None,
        last_modified: None,
        max_retries,
        limiter: Arc::new(BandwidthLimiter::new(0)),
        control,
        on_retry: None,
        connections: 1,
        chunk_size_override: None,
    }
}

async fn run_transfer(ctx: TransferContext) -> Result<TransferOutcome, String> {
    tokio::time::timeout(Duration::from_secs(20), transfer(ctx, &NoopSink))
        .await
        .expect("传输超时")
        .map_err(String::from)
}

fn read_final(dir: &Path) -> Vec<u8> {
    std::fs::read(dir.join("model.safetensors")).expect("最终文件不存在")
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

#[tokio::test]
async fn resumes_after_mid_stream_disconnect() {
    let dir = unique_dir("resume");
    let full = content();
    let (base, counter) = spawn_mock_server(move |_index, request| {
        let full = content();
        match request.range_start {
            Some(start) => {
                let start = start as usize;
                MockResponse::new(206, "Partial Content", full[start..].to_vec()).header(
                    "Content-Range",
                    &format!("bytes {start}-{}/{TOTAL}", TOTAL - 1),
                )
            }
            None => MockResponse::ok(full).truncated(300),
        }
    })
    .await;

    let ctx = build_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        0,
        2,
    );
    let outcome = run_transfer(ctx).await.expect("应成功续传完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full, "续传后最终内容应与源一致");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        2,
        "应经历 1 次中断 + 1 次续传"
    );
    // 临时文件与断点元数据应被清理。
    assert!(!dir.join("model.safetensors.part").exists());
    assert!(!dir.join("model.safetensors.part.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn handles_modelscope_style_200_with_content_range() {
    let dir = unique_dir("ms-200-cr");
    seed_legacy_meta(&dir, 0);
    let full = content();
    // 预埋 300 字节 part，模拟上次中断。
    std::fs::write(dir.join("model.safetensors.part"), &full[..300]).unwrap();

    let (base, counter) = spawn_mock_server(move |_index, request| {
        let full = content();
        let start = request.range_start.expect("续传必须带 Range") as usize;
        assert_eq!(start, 300, "Range 起点应为已下载字节数");
        // ModelScope 实测：对 Range 请求返回 200 + Content-Range（非 206）。
        MockResponse::ok(full[start..].to_vec()).header(
            "Content-Range",
            &format!("bytes {start}-{}/{TOTAL}", TOTAL - 1),
        )
    })
    .await;

    let ctx = build_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        0,
        2,
    );
    let outcome = run_transfer(ctx)
        .await
        .expect("200+Content-Range 应视为续传成功");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(
        read_final(&dir),
        full,
        "不能因 200 而截断重写，内容必须完整"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn falls_back_to_full_download_when_server_ignores_range() {
    let dir = unique_dir("mirror-ignore-range");
    let full = content();
    // 预埋 300 字节 part（HF 镜像会忽略 Range 返回全量 200）。
    std::fs::write(dir.join("model.safetensors.part"), &full[..300]).unwrap();

    let (base, counter) = spawn_mock_server(move |_index, _request| {
        MockResponse::ok(content()) // 不带 Content-Range，忽略 Range
    })
    .await;

    let ctx = build_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        2,
    );
    let outcome = run_transfer(ctx).await.expect("应能从头重下");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full, "从头重下后内容应完整");
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn does_not_trust_416_for_legacy_full_length_part() {
    let dir = unique_dir("416");
    seed_legacy_meta(&dir, 0);
    let full = content();
    // part 已完整但任务 total 未知（列表中 size=0），因此仍会发 Range 请求。
    std::fs::write(dir.join("model.safetensors.part"), vec![0; TOTAL]).unwrap();

    let (base, counter) = spawn_mock_server(move |_index, request| {
        if request.range_start.is_none() {
            return MockResponse::ok(content());
        }
        assert_eq!(request.range_start, Some(TOTAL as u64));
        MockResponse::new(416, "Range Not Satisfiable", Vec::new())
            .header("Content-Range", &format!("bytes */{TOTAL}"))
    })
    .await;

    let ctx = build_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        0,
        0,
    );
    let outcome = run_transfer(ctx).await.expect("416 后应重取完整响应体");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full);
    assert_eq!(counter.load(Ordering::SeqCst), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn exhausts_retries_on_5xx() {
    let dir = unique_dir("5xx");
    let (base, counter) = spawn_mock_server(|_index, _request| {
        MockResponse::new(503, "Service Unavailable", Vec::new())
    })
    .await;

    let ctx = build_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        1,
    );
    let error = run_transfer(ctx).await.expect_err("5xx 重试耗尽后应失败");
    assert!(
        error.contains("已重试 1 次"),
        "错误信息应说明重试次数，实际：{error}"
    );
    assert_eq!(
        counter.load(Ordering::SeqCst),
        2,
        "maxRetries=1 → 共请求 2 次"
    );
    assert!(!dir.join("model.safetensors").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn does_not_retry_on_401() {
    let dir = unique_dir("401");
    let (base, counter) =
        spawn_mock_server(|_index, _request| MockResponse::new(401, "Unauthorized", Vec::new()))
            .await;

    let ctx = build_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        3,
    );
    let error = run_transfer(ctx).await.expect_err("401 不应重试");
    assert!(
        error.contains("授权") || error.contains("Token") || error.contains("HTTP 401"),
        "应为中文授权错误，实际：{error}"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 1, "401 只应请求一次");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn pause_keeps_part_and_resume_finishes() {
    let dir = unique_dir("pause-resume");
    let (base, _counter) = spawn_mock_server(move |_index, request| match request.range_start {
        Some(start) => {
            let start = start as usize;
            MockResponse::new(206, "Partial Content", content()[start..].to_vec()).header(
                "Content-Range",
                &format!("bytes {start}-{}/{TOTAL}", TOTAL - 1),
            )
        }
        // 首次全量：慢速分块发送，便于中途暂停。
        None => MockResponse::ok(content()).slow(50, 100),
    })
    .await;

    let url = format!("{base}/model.safetensors");
    let control = TaskControl::new();
    let ctx = build_context(&dir, url.clone(), control.clone(), TOTAL as u64, 0);
    let transfer_handle = tokio::spawn(run_transfer(ctx));

    // 等待开始写入后暂停。
    let part_path = dir.join("model.safetensors.part");
    let mut waited = 0u64;
    loop {
        let length = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        if length > 0 {
            break;
        }
        assert!(waited < 5_000, "等待下载开始超时");
        tokio::time::sleep(Duration::from_millis(20)).await;
        waited += 20;
    }
    control.set_paused(true);

    let paused = tokio::time::timeout(Duration::from_secs(10), transfer_handle)
        .await
        .expect("暂停超时")
        .expect("协程 panic")
        .expect("暂停应返回 Ok");
    let (paused_downloaded, paused_total) = match paused {
        TransferOutcome::Paused {
            downloaded,
            total_size,
            ..
        } => (downloaded, total_size),
        other => panic!("期望 Paused，实际 {other:?}"),
    };
    assert!(paused_downloaded > 0 && paused_downloaded < TOTAL as u64);
    assert_eq!(paused_total, TOTAL as u64);
    let part_length = std::fs::metadata(&part_path).unwrap().len();
    assert_eq!(
        part_length, paused_downloaded,
        "暂停后 part 长度应等于报告进度"
    );
    assert!(
        dir.join("model.safetensors.part.json").exists(),
        "断点元数据应保留"
    );

    // 恢复：新的控制标志 + 同一 url，应带 Range 续传并完成。
    let resume_control = TaskControl::new();
    let resume_ctx = build_context(&dir, url, resume_control, 0, 0);
    let outcome = run_transfer(resume_ctx).await.expect("恢复后应完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), content(), "恢复后最终内容应与源一致");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// P1-2 / P1-3 回归测试
// ---------------------------------------------------------------------------

#[tokio::test]
async fn retry_counter_reports_two_retries_then_completes() {
    use model_download_manager_lib::download::RetryCallback;
    use model_download_manager_lib::models::{DownloadTask, Settings, TaskStatus};
    use model_download_manager_lib::state::AppState;
    use std::sync::Mutex;

    let dir = unique_dir("retry-counter");
    let full = content();
    // 前两次 503，第三次 200：引擎应重试 2 次后成功。
    let (base, counter) = spawn_mock_server(move |index, _request| {
        if index < 2 {
            MockResponse::new(503, "Service Unavailable", Vec::new())
        } else {
            MockResponse::ok(content())
        }
    })
    .await;

    // 任务表 + 重试回调（与 queue 的生产实现一致：回调回写 task.retries）。
    let mut settings = Settings::default();
    settings.download_dir = dir.join("models").to_string_lossy().into_owned();
    settings.max_retries = 3;
    let state = Arc::new(AppState::new(settings, dir.join("appdata")));
    let save_path = dir.join("model.safetensors");
    state.insert_tasks(vec![DownloadTask {
        update_seq: 0,
        task_id: "t1".to_string(),
        source: Source::Huggingface,
        repo_id: "org/model".to_string(),
        remote_path: "model.safetensors".to_string(),
        file_name: "model.safetensors".to_string(),
        save_path: save_path.to_string_lossy().into_owned(),
        temp_path: format!("{}.part", save_path.display()),
        total_size: TOTAL as u64,
        downloaded: 0,
        status: TaskStatus::Active,
        speed: 0,
        error: None,
        retries: 0,
        revision: "main".to_string(),
        added_at: 1,
        completed_at: None,
        etag: None,
        last_modified: None,
        sha256: None,
        verify_status: model_download_manager_lib::models::VerifyStatus::Unavailable,
    }]);

    let seen: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let retry_state = state.clone();
    let seen_for_callback = seen.clone();
    let on_retry: RetryCallback = Arc::new(move |retries| {
        seen_for_callback.lock().unwrap().push(retries);
        retry_state.update_task("t1", |task| task.retries = retries);
    });

    let mut ctx = build_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        3,
    );
    ctx.on_retry = Some(on_retry);

    let outcome = run_transfer(ctx).await.expect("两次 5xx 后应成功");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(
        *seen.lock().unwrap(),
        vec![1, 2],
        "回调应报告累计重试次数 1、2"
    );
    assert_eq!(
        state.get_task("t1").unwrap().retries,
        2,
        "任务表应回写 retries=2"
    );
    assert_eq!(read_final(&dir), full);
    assert_eq!(counter.load(Ordering::SeqCst), 3, "总请求数应为 3");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn discards_stale_part_longer_than_total() {
    let dir = unique_dir("stale-part");
    let full = content();
    // 预埋超长 part（1200 字节垃圾，远端声明 1000 字节）。
    std::fs::write(
        dir.join("model.safetensors.part"),
        vec![0xEEu8; TOTAL + 200],
    )
    .unwrap();

    let (base, counter) = spawn_mock_server(move |_index, request| {
        // 丢弃超长 part 之后必须从头下载（不带 Range）。
        assert!(
            request.range_start.is_none(),
            "丢弃超长 part 后不应再带 Range"
        );
        MockResponse::ok(content())
    })
    .await;

    let ctx = build_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        0,
    );
    let outcome = run_transfer(ctx)
        .await
        .expect("应丢弃超长 part 后重新下载完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    let bytes = read_final(&dir);
    assert_eq!(bytes.len(), TOTAL, "最终文件应恰好等于远端 total 字节");
    assert_eq!(bytes, full, "最终内容必须与源一致");
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// v0.2.0 多连接分段下载测试辅助
// ---------------------------------------------------------------------------

fn build_auto_context(
    dir: &Path,
    url: String,
    control: Arc<TaskControl>,
    total_size: u64,
    connections: u32,
    chunk_size: Option<u64>,
    max_retries: u32,
) -> TransferContext {
    let mut ctx = build_context(dir, url, control, total_size, max_retries);
    ctx.connections = connections;
    ctx.chunk_size_override = chunk_size;
    ctx
}

async fn run_transfer_auto(ctx: TransferContext) -> Result<TransferOutcome, String> {
    tokio::time::timeout(Duration::from_secs(30), transfer_auto(ctx, &NoopSink))
        .await
        .expect("分段传输超时")
        .map_err(String::from)
}

/// 记录事件（用于观察进度与暂停时机）。
#[derive(Default)]
struct RecordingSink {
    events: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
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
    fn last_downloaded(&self) -> u64 {
        let events = self.events.lock().unwrap();
        events
            .iter()
            .rev()
            .find(|(event, _)| event == "download-progress")
            .and_then(|(_, payload)| payload.get("downloaded").and_then(|value| value.as_u64()))
            .unwrap_or(0)
    }
}

/// 支持任意 Range 的 mock 响应：`Range: bytes=a-b` → `206 + Content-Range`。
fn range_response(full: &[u8], request: &MockRequest) -> MockResponse {
    let total = full.len() as u64;
    match (request.range_start, request.range_end) {
        (Some(start), Some(end)) => {
            let end = end.min(total - 1);
            let start = start.min(end);
            MockResponse::new(
                206,
                "Partial Content",
                full[start as usize..=end as usize].to_vec(),
            )
            .header("Content-Range", &format!("bytes {start}-{end}/{total}"))
        }
        _ => MockResponse::ok(full.to_vec()),
    }
}

// ---------------------------------------------------------------------------
// v0.2.0 分段下载测试
// ---------------------------------------------------------------------------

#[tokio::test]
async fn segmented_download_completes_with_matching_content() {
    let dir = unique_dir("seg-complete");
    let full = content();
    let (base, counter) = spawn_mock_server(move |_index, request| {
        let full = content();
        range_response(&full, request)
    })
    .await;

    let ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        4,
        Some(128),
        0,
    );
    let outcome = run_transfer_auto(ctx).await.expect("多连接分段下载应完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full, "分段下载内容必须与源一致");
    assert!(!dir.join("model.safetensors.part").exists());
    assert!(!dir.join("model.safetensors.part.json").exists());
    assert!(
        counter.load(Ordering::SeqCst) > 2,
        "应包含探测 + 多个分块请求，实际 {}",
        counter.load(Ordering::SeqCst)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn segmented_pause_keeps_chunks_and_resume_finishes() {
    let dir = unique_dir("seg-pause");
    let full = content();
    let (base, _counter) = spawn_mock_server(move |_index, request| {
        let full = content();
        range_response(&full, request).slow(8, 20)
    })
    .await;

    let sink = Arc::new(RecordingSink::default());
    let control = TaskControl::new();
    let ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        control.clone(),
        TOTAL as u64,
        4,
        Some(128),
        0,
    );

    let transfer_future =
        tokio::time::timeout(Duration::from_secs(20), transfer_auto(ctx, sink.as_ref()));
    let pause_future = async {
        loop {
            if sink.last_downloaded() > 0 {
                control.set_paused(true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    let (result, ()) = tokio::join!(transfer_future, pause_future);
    let paused = result.expect("等待暂停超时").expect("暂停应返回 Ok");
    let (paused_downloaded, paused_total) = match paused {
        TransferOutcome::Paused {
            downloaded,
            total_size,
            ..
        } => (downloaded, total_size),
        other => panic!("期望 Paused，实际 {other:?}"),
    };
    assert!(paused_downloaded > 0 && paused_downloaded < TOTAL as u64);
    assert_eq!(paused_total, TOTAL as u64);
    assert_eq!(
        std::fs::metadata(dir.join("model.safetensors.part"))
            .unwrap()
            .len(),
        TOTAL as u64,
        "分段任务 .part 应预分配为 total 长度"
    );
    let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("model.safetensors.part.json")).unwrap())
            .unwrap();
    let chunks_sum: u64 = meta["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_u64().unwrap())
        .sum();
    assert_eq!(
        chunks_sum, paused_downloaded,
        "元数据 chunks 之和应等于暂停进度"
    );

    // 恢复（分段元数据存在 → 继续分段引擎）。
    let resume_ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        0,
        4,
        Some(128),
        0,
    );
    let outcome = run_transfer_auto(resume_ctx).await.expect("恢复后应完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full, "恢复后内容必须完整");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn legacy_single_stream_part_is_converted_to_segments() {
    let dir = unique_dir("seg-legacy");
    seed_legacy_meta(&dir, 0);
    let full = content();
    // 旧单流断点：连续前缀 300 字节，无分段元数据。
    std::fs::write(dir.join("model.safetensors.part"), &full[..300]).unwrap();

    let ranges: Arc<std::sync::Mutex<Vec<(u64, u64)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let ranges_for_handler = ranges.clone();
    let (base, _counter) = spawn_mock_server(move |_index, request| {
        let full = content();
        if let (Some(start), Some(end)) = (request.range_start, request.range_end) {
            if !(start == 0 && end == 0) {
                ranges_for_handler.lock().unwrap().push((start, end));
            }
        }
        range_response(&full, request)
    })
    .await;

    let ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        4,
        Some(128),
        0,
    );
    let outcome = run_transfer_auto(ctx)
        .await
        .expect("旧单流断点应无损转换并完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full, "断点转换后内容必须完整");
    let recorded = ranges.lock().unwrap().clone();
    assert!(!recorded.is_empty());
    assert!(
        recorded.iter().all(|(start, _)| *start >= 300),
        "已完成的 300 字节前缀不应被重新下载，实际请求 {recorded:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn segmented_falls_back_to_single_stream_when_range_unsupported() {
    let dir = unique_dir("seg-fallback");
    let full = content();
    let (base, counter) =
        spawn_mock_server(move |_index, _request| MockResponse::ok(content())).await;

    let ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        4,
        Some(128),
        0,
    );
    let outcome = run_transfer_auto(ctx)
        .await
        .expect("不支持 Range 应回退单流完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        2,
        "应仅探测 1 次 + 单流下载 1 次"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn segmented_retries_failed_chunk() {
    let dir = unique_dir("seg-retry");
    let full = content();
    let (base, counter) = spawn_mock_server(move |index, request| {
        let full = content();
        // index 0 = 探测；随后前两个分块请求返回 503，触发按块重试。
        if index > 0 && index <= 2 {
            return MockResponse::new(503, "Service Unavailable", Vec::new());
        }
        range_response(&full, request)
    })
    .await;

    let seen: Arc<std::sync::Mutex<Vec<u32>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen_for_callback = seen.clone();
    let mut ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        2,
        Some(250),
        2,
    );
    ctx.on_retry = Some(Arc::new(move |retries| {
        seen_for_callback.lock().unwrap().push(retries);
    }));

    let outcome = run_transfer_auto(ctx).await.expect("分块 5xx 重试后应完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full);
    assert!(!seen.lock().unwrap().is_empty(), "应触发分块重试回调");
    assert!(
        counter.load(Ordering::SeqCst) > 5,
        "应包含重试请求，实际 {}",
        counter.load(Ordering::SeqCst)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn connections_one_uses_single_stream_engine() {
    let dir = unique_dir("seg-conn1");
    let full = content();
    let (base, counter) = spawn_mock_server(move |_index, request| {
        if request.range_start.is_some() {
            let full = content();
            return range_response(&full, request);
        }
        MockResponse::ok(content())
    })
    .await;

    let ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        1,
        Some(128),
        0,
    );
    let outcome = run_transfer_auto(ctx)
        .await
        .expect("connections=1 应走单流完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "单流引擎应只发起 1 次请求"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn unknown_total_falls_back_to_single_stream() {
    let dir = unique_dir("seg-unknown-total");
    let full = content();
    let (base, counter) =
        spawn_mock_server(move |_index, _request| MockResponse::ok(content())).await;

    let ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        0,
        4,
        Some(128),
        0,
    );
    let outcome = run_transfer_auto(ctx)
        .await
        .expect("total 未知应回退单流完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full);
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn legacy_single_stream_part_restarts_when_etag_mismatches() {
    let dir = unique_dir("seg-legacy-etag");
    let full = content();
    // 旧版单流断点：连续前缀 300 字节 + 旧格式元数据（stale etag）。
    std::fs::write(dir.join("model.safetensors.part"), &full[..300]).unwrap();
    let old_meta = serde_json::json!({
        "etag": "\"stale-etag\"",
        "lastModified": "Wed, 21 Oct 2015 07:28:00 GMT",
        "total": TOTAL as u64,
        "repoId": "org/model",
        "remotePath": "model.safetensors"
    });
    std::fs::write(
        dir.join("model.safetensors.part.json"),
        serde_json::to_vec(&old_meta).unwrap(),
    )
    .unwrap();

    let ranges: Arc<std::sync::Mutex<Vec<(u64, u64)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let ranges_for_handler = ranges.clone();
    let (base, _counter) = spawn_mock_server(move |_index, request| {
        let full = content();
        if let (Some(start), Some(end)) = (request.range_start, request.range_end) {
            if !(start == 0 && end == 0) {
                ranges_for_handler.lock().unwrap().push((start, end));
            }
        }
        range_response(&full, request).header("ETag", "\"server-etag\"")
    })
    .await;

    let ctx = build_auto_context(
        &dir,
        format!("{base}/model.safetensors"),
        TaskControl::new(),
        TOTAL as u64,
        4,
        Some(128),
        0,
    );
    let outcome = run_transfer_auto(ctx)
        .await
        .expect("旧断点版本变化时应重下并完成");
    assert!(matches!(
        outcome,
        TransferOutcome::Completed { downloaded, .. } if downloaded == TOTAL as u64
    ));
    assert_eq!(read_final(&dir), full, "保留旧断点后内容必须完整");
    let recorded = ranges.lock().unwrap().clone();
    assert!(
        recorded.iter().any(|(start, _)| *start == 0),
        "远端版本变化后必须重下首块，实际请求 {recorded:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

fn seed_legacy_meta(dir: &Path, total: u64) {
    let meta = serde_json::json!({ "repoId": "org/model", "remotePath": "model.safetensors", "total": total });
    util::atomic_write_json(&dir.join("model.safetensors.part.json"), &meta).unwrap();
}

#[tokio::test]
async fn audit_limiter_can_consume_more_than_one_second_of_budget() {
    let limiter = BandwidthLimiter::new(1024);
    let result = tokio::time::timeout(Duration::from_millis(3500), limiter.acquire(2048)).await;
    assert!(result.is_ok(), "2048 bytes at 1024 B/s should finish in about 2 s; it never can exceed the 1024-token capacity");
}

async fn audit_stalled_pause(connections: u32) {
    let (url, _) = spawn_mock_server(move |_, request| {
        let start = request.range_start.unwrap_or(0) as usize;
        let end = request.range_end.unwrap_or((TOTAL - 1) as u64) as usize;
        let body = content()[start..=end].to_vec();
        let response = if request.range_start.is_some() {
            MockResponse::new(206, "Partial Content", body)
                .header("Content-Range", &format!("bytes {start}-{end}/{TOTAL}"))
        } else {
            MockResponse::ok(body)
        };
        // A valid response which sends its first byte and then stalls.
        response.slow(1, 60_000)
    })
    .await;
    let dir = unique_dir("audit-stalled");
    let control = TaskControl::new();
    let mut ctx = build_context(&dir, url, control.clone(), TOTAL as u64, 0);
    ctx.connections = connections;
    ctx.chunk_size_override = Some(250);
    let part = ctx.part_path.clone();
    let pause = async {
        for _ in 0..100 {
            if part.exists() && std::fs::metadata(&part).unwrap().len() > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        control.set_paused(true);
    };
    let transfer =
        async { tokio::time::timeout(Duration::from_secs(2), transfer_auto(ctx, &NoopSink)).await };
    let (result, _) = tokio::join!(transfer, pause);
    assert!(
        matches!(result, Ok(Ok(TransferOutcome::Paused { .. }))),
        "pause was not observed while awaiting the response body: {result:?}"
    );
}

#[tokio::test]
async fn audit_single_stream_pause_during_stalled_body() {
    audit_stalled_pause(1).await;
}

#[tokio::test]
async fn audit_segmented_pause_during_stalled_body() {
    audit_stalled_pause(4).await;
}

#[tokio::test]
async fn audit_segmented_rejects_changed_etag_between_ranges() {
    let (url, _) = spawn_mock_server(|_, request| {
        let start = request.range_start.unwrap() as usize;
        let end = request.range_end.unwrap() as usize;
        let (byte, etag) = if start == 0 {
            (17, "\"v1\"")
        } else {
            (34, "\"v2\"")
        };
        MockResponse::new(206, "Partial Content", vec![byte; end - start + 1])
            .header("Content-Range", &format!("bytes {start}-{end}/{TOTAL}"))
            .header("ETag", etag)
    })
    .await;
    let dir = unique_dir("audit-mixed-revisions");
    let mut ctx = build_context(&dir, url, TaskControl::new(), TOTAL as u64, 0);
    ctx.connections = 4;
    ctx.chunk_size_override = Some(250);
    let save = ctx.save_path.clone();
    let result = transfer_auto(ctx, &NoopSink).await;
    let mixed = save.exists() && {
        let bytes = std::fs::read(&save).unwrap();
        bytes.contains(&17) && bytes.contains(&34)
    };
    assert!(
        result.is_err(),
        "a changed ETag must stop segmented transfer: {result:?}"
    );
    assert!(
        !mixed && !save.exists(),
        "a mixed-version final file must never be published"
    );
}

#[tokio::test]
async fn audit_preallocated_part_without_metadata_is_not_completed() {
    let (url, requests) = spawn_mock_server(|_, request| {
        let start = request.range_start.unwrap_or(0) as usize;
        let end = request.range_end.unwrap_or((TOTAL - 1) as u64) as usize;
        MockResponse::new(206, "Partial Content", content()[start..=end].to_vec())
            .header("Content-Range", &format!("bytes {start}-{end}/{TOTAL}"))
    })
    .await;
    let dir = unique_dir("audit-preallocation-crash");
    let mut ctx = build_context(&dir, url, TaskControl::new(), TOTAL as u64, 0);
    ctx.connections = 4;
    ctx.chunk_size_override = Some(250);
    // State produced by segmented::attempt after set_len and before save_segmented_meta.
    let file = std::fs::File::create(&ctx.part_path).unwrap();
    file.set_len(TOTAL as u64).unwrap();
    drop(file);
    let save = ctx.save_path.clone();
    let result = transfer_auto(ctx, &NoopSink).await.unwrap();
    assert!(matches!(result, TransferOutcome::Completed { .. }));
    assert!(
        std::fs::read(save).unwrap() == content(),
        "preallocated zeros were accepted after only {} probe request(s)",
        requests.load(Ordering::SeqCst)
    );
}

#[test]
fn audit_distinct_sources_do_not_share_writable_output() {
    use model_download_manager_lib::{
        models::{DownloadRequest, Settings},
        queue,
        state::AppState,
    };
    let dir = unique_dir("audit-source-collision");
    let mut settings = Settings::default();
    settings.download_dir = dir.join("models").to_string_lossy().into_owned();
    let state = Arc::new(AppState::new(settings.clone(), dir.join("data")));
    let request = |source| DownloadRequest {
        source,
        repo_id: "org/model".into(),
        remote_path: "model.bin".into(),
        size: 1000,
        save_dir: settings.download_dir.clone(),
        revision: None,
        sha256: None,
    };
    let tasks = queue::start_downloads(
        &state,
        vec![request(Source::Huggingface), request(Source::Modelscope)],
        &NoopSink,
    )
    .unwrap();
    assert!(
        !(tasks.len() == 2 && tasks[0].temp_path == tasks[1].temp_path),
        "two runnable tasks share the exact same .part and .part.json: {:?}",
        tasks
            .iter()
            .map(|t| (&t.source, &t.temp_path))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn audit_slash_revision_reaches_detail_api() {
    use model_download_manager_lib::{models::Settings, sources};
    let (url, _) = spawn_mock_server(|_, request| {
        let body = if request.path.contains("/tree/") {
            assert!(
                request.path.contains("/tree/refs%2Fpr%2F3?"),
                "{}",
                request.path
            );
            "[]"
        } else {
            "{}"
        };
        MockResponse::ok(body.as_bytes().to_vec()).header("Content-Type", "application/json")
    })
    .await;
    let mut settings = Settings::default();
    settings.hf_endpoint = url;
    let detail = sources::get_repo_detail(
        &reqwest::Client::new(),
        &settings,
        Source::Huggingface,
        "org/model",
        Some("refs/pr/3"),
    )
    .await
    .unwrap();
    assert_eq!(detail.revision, "refs/pr/3");
    let url = sources::download_url(
        &settings,
        Source::Huggingface,
        "org/model",
        "refs/pr/3",
        "file.bin",
    );
    assert!(url.ends_with("/resolve/refs%2Fpr%2F3/file.bin"));
}

#[tokio::test]
async fn audit_socks_proxy_is_usable() {
    use model_download_manager_lib::models::Settings;
    let mut settings = Settings::default();
    settings.proxy = "socks5://127.0.0.1:9".into();
    let validated = model_download_manager_lib::settings::validate_proxy(&settings.proxy);
    assert!(
        validated.is_ok(),
        "UI accepts SOCKS but backend rejects it: {validated:?}"
    );
    assert!(util::build_http_client(&settings).is_ok());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    settings.proxy = format!("socks5h://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 2];
        socket.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting[0], 5);
        let mut methods = vec![0; greeting[1] as usize];
        socket.read_exact(&mut methods).await.unwrap();
        socket.write_all(&[5, 0]).await.unwrap();
        let mut connect = [0; 4];
        socket.read_exact(&mut connect).await.unwrap();
        assert_eq!(connect, [5, 1, 0, 3]);
        let length = socket.read_u8().await.unwrap() as usize;
        let mut destination = vec![0; length + 2];
        socket.read_exact(&mut destination).await.unwrap();
        assert_eq!(&destination[..length], b"model.invalid");
        socket
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
            .await
            .unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });
    let client = util::build_http_client(&settings).unwrap();
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        client.get("http://model.invalid/model").send(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.text().await.unwrap(), "ok");
    server.await.unwrap();
}

#[tokio::test]
async fn audit_metadata_failure_stops_before_preallocation() {
    let (url, _) = spawn_mock_server(|_, request| range_response(&content(), request)).await;
    let dir = unique_dir("audit-meta-failure");
    let mut ctx = build_context(&dir, url, TaskControl::new(), TOTAL as u64, 0);
    ctx.connections = 4;
    ctx.chunk_size_override = Some(250);
    std::fs::create_dir(&ctx.meta_path).unwrap();
    let part = ctx.part_path.clone();
    let result = transfer_auto(ctx, &NoopSink).await;
    assert!(result.is_err());
    assert!(
        !part.exists(),
        "preallocation must not happen when sidecar commit fails"
    );
}

#[tokio::test]
async fn audit_cancel_interrupts_limiter_and_http_headers() {
    let dir = unique_dir("audit-cancel-limiter");
    let (url, _) = spawn_mock_server(|_, _| MockResponse::ok(content())).await;
    let control = TaskControl::new();
    let mut ctx = build_context(&dir, url, control.clone(), TOTAL as u64, 0);
    ctx.limiter = Arc::new(BandwidthLimiter::new(1));
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        control.cancel(false);
    };
    let download = tokio::time::timeout(Duration::from_secs(3), transfer(ctx, &NoopSink));
    let (result, _) = tokio::join!(download, cancel);
    assert!(matches!(result, Ok(Ok(TransferOutcome::Cancelled { .. }))));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/file", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let control = TaskControl::new();
    let ctx = build_context(&dir, url, control.clone(), TOTAL as u64, 0);
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        control.cancel(false);
    };
    let (result, _) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(3), transfer(ctx, &NoopSink)),
        cancel
    );
    server.abort();
    assert!(matches!(result, Ok(Ok(TransferOutcome::Cancelled { .. }))));
}

#[tokio::test]
async fn audit_single_stream_rejects_changed_etag_after_disconnect() {
    let (url, _) = spawn_mock_server(|index, request| {
        if index == 0 {
            MockResponse::ok(vec![17; TOTAL])
                .header("ETag", "\"v1\"")
                .truncated(250)
                .slow(125, 10)
        } else if let Some(start) = request.range_start {
            let start = start as usize;
            MockResponse::new(206, "Partial Content", vec![34; TOTAL - start])
                .header(
                    "Content-Range",
                    &format!("bytes {start}-{}/{TOTAL}", TOTAL - 1),
                )
                .header("ETag", "\"v2\"")
        } else {
            MockResponse::ok(vec![34; TOTAL]).header("ETag", "\"v2\"")
        }
    })
    .await;
    let dir = unique_dir("audit-single-mixed");
    let ctx = build_context(&dir, url, TaskControl::new(), TOTAL as u64, 1);
    let save = ctx.save_path.clone();
    let result = transfer(ctx, &NoopSink).await;
    let mixed = save.exists() && {
        let bytes = std::fs::read(&save).unwrap();
        bytes.contains(&17) && bytes.contains(&34)
    };
    assert!(
        matches!(result, Ok(TransferOutcome::Completed { .. })),
        "{result:?}"
    );
    assert!(!mixed);
    assert_eq!(std::fs::read(save).unwrap(), vec![34; TOTAL]);
}

#[test]
fn audit_revision_layout_does_not_collide_with_repo_subdirectory() {
    let dir = unique_dir("audit-revision-paths");
    let root = dir.to_string_lossy();
    let main = util::build_task_paths_revision(&root, "org/model", "dev/model.bin", "main", "main")
        .unwrap();
    let dev =
        util::build_task_paths_revision(&root, "org/model", "model.bin", "dev", "main").unwrap();
    assert_ne!(
        main.final_path, dev.final_path,
        "main:dev/model.bin and dev:model.bin resolve to one file"
    );
}

#[tokio::test]
async fn legacy_sidecar_does_not_certify_preallocated_full_length_data() {
    for connections in [1, 4] {
        let (url, _) = spawn_mock_server(|_, request| range_response(&content(), request)).await;
        let dir = unique_dir("legacy-preallocated-sidecar");
        seed_legacy_meta(&dir, TOTAL as u64);
        let mut damaged = vec![0; TOTAL];
        damaged[..250].copy_from_slice(&content()[..250]);
        std::fs::write(dir.join("model.safetensors.part"), damaged).unwrap();
        let ctx = build_auto_context(
            &dir,
            url,
            TaskControl::new(),
            TOTAL as u64,
            connections,
            Some(250),
            0,
        );
        let result = transfer_auto(ctx, &NoopSink).await.unwrap();
        assert!(matches!(result, TransferOutcome::Completed { .. }));
        assert_eq!(
            read_final(&dir),
            content(),
            "connections={connections}: full length alone must never certify data"
        );
    }
}

#[tokio::test]
async fn oversized_partial_response_is_never_published() {
    let (url, _) = spawn_mock_server(|_, _| {
        MockResponse::new(206, "Partial Content", vec![1; TOTAL + 10])
            .header("Content-Range", &format!("bytes 0-{}/{TOTAL}", TOTAL - 1))
    })
    .await;
    let dir = unique_dir("oversized-response");
    let ctx = build_context(&dir, url, TaskControl::new(), TOTAL as u64, 0);
    let save = ctx.save_path.clone();
    assert!(transfer(ctx, &NoopSink).await.is_err());
    assert!(!save.exists());
}
