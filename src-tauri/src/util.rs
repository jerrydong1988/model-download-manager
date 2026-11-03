//! 无状态工具：路径净化、原子写、事件抽象、资源管理器、全局令牌桶。

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::models::{DownloadTask, FileKind, Settings};

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/// 当前 Unix 毫秒时间戳。
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 文件分类
// ---------------------------------------------------------------------------

/// 文件名按 `.`/`-`/`_`/空格 切分出的词元（用于 mmproj/clip/imatrix 名称判定）。
fn name_tokens(name: &str) -> impl Iterator<Item = &str> {
    name.split(['.', '-', '_', ' '])
        .filter(|token| !token.is_empty())
}

/// 按扩展名与文件名分类仓库文件（契约 §2 分类规则，v0.1.2）。
///
/// 判定顺序：
/// 1. basename 小写取最后一段扩展名；
/// 2. `.safetensors.index.json` / `.bin.index.json` 先判 `weight`；
/// 3. 仅当扩展名属于权重类时，按词元判定 `mmproj`（含 mmproj/clip）与 `imatrix`；
/// 4. 权重类扩展名 → `weight`；
/// 5. 配置类扩展名 → `config`；其余 → `other`。
///
/// 配置类/文档类扩展名**不参与**名称判定，避免 `mmproj_config.json`、
/// `convert_mmproj_to_gguf.py` 被误判为投影器。
pub fn classify_file(path: &str) -> FileKind {
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();

    // 分片索引虽以 `.json` 结尾，但属于权重（先于配置判定）。
    if name.ends_with(".safetensors.index.json") || name.ends_with(".bin.index.json") {
        return FileKind::Weight;
    }

    let ext = match name.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => ext,
        _ => return FileKind::Other,
    };

    /// 权重类扩展名（契约 §2 v0.1.2）。
    const WEIGHT: &[&str] = &[
        "safetensors",
        "bin",
        "pt",
        "pth",
        "gguf",
        "gguf_file",
        "hgn",
        "onnx",
        "onnx_data",
        "ckpt",
        "h5",
        "msgpack",
        "npy",
        "npz",
        "engine",
        "tflite",
        "mlmodel",
        "ot",
        "pkl",
        "pickle",
        "joblib",
        "keras",
        "nemo",
        "sft",
        "mindir",
        "om",
        "plan",
        "dat",
    ];
    /// 配置类扩展名（契约 §2 v0.1.2）。
    const CONFIG: &[&str] = &[
        "json", "yaml", "yml", "txt", "md", "model", "tiktoken", "py", "jinja", "cfg", "ini",
        "toml", "spm", "vocab",
    ];

    if WEIGHT.contains(&ext) {
        // 名称规则只在权重类扩展名上生效。
        let mut has_mmproj = false;
        let mut has_imatrix = false;
        for token in name_tokens(&name) {
            match token {
                "mmproj" | "clip" => has_mmproj = true,
                "imatrix" => has_imatrix = true,
                _ => {}
            }
        }
        if has_mmproj {
            return FileKind::Mmproj;
        }
        if has_imatrix {
            return FileKind::Imatrix;
        }
        return FileKind::Weight;
    }

    if CONFIG.contains(&ext) {
        FileKind::Config
    } else {
        FileKind::Other
    }
}

// ---------------------------------------------------------------------------
// 路径净化
// ---------------------------------------------------------------------------

/// Windows 保留设备名（不区分大小写，且带扩展名同样被保留）。
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 校验单个路径段：拒绝空段、`.`/`..`、非法字符、Windows 保留名。
pub fn sanitize_segment(segment: &str) -> Result<String, String> {
    if segment.is_empty() {
        return Err("路径包含空段".to_string());
    }
    if segment == "." || segment == ".." {
        return Err(format!("路径包含非法段：{segment}"));
    }
    if segment
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || c == '\\' || c == '/')
    {
        return Err(format!("路径包含非法字符：{segment}"));
    }
    if segment.chars().any(char::is_control) {
        return Err(format!("路径包含控制字符：{}", segment.escape_debug()));
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Err(format!("路径段不能以点或空格结尾：{segment}"));
    }
    let stem = segment.split('.').next().unwrap_or(segment).to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(format!("路径使用了系统保留名：{segment}"));
    }
    Ok(segment.to_string())
}

/// 净化仓库 ID（`org/model` 或 `model`），保留 `/` 作为目录分隔。
pub fn sanitize_repo_id(repo_id: &str) -> Result<String, String> {
    let trimmed = repo_id.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Err("仓库 ID 为空".to_string());
    }
    if trimmed.starts_with('/') || trimmed.contains('\\') {
        return Err(format!("仓库 ID 格式无效：{repo_id}"));
    }
    let segments: Vec<&str> = trimmed.split('/').collect();
    if segments.len() > 2 {
        return Err(format!("仓库 ID 格式无效（应为 org/model）：{repo_id}"));
    }
    let mut out = String::new();
    for segment in segments {
        let safe = sanitize_segment(segment)?;
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(&safe);
    }
    Ok(out)
}

/// 净化仓库内相对路径：拒绝绝对路径、`..`、盘符、UNC、反斜杠。
pub fn sanitize_remote_path(remote_path: &str) -> Result<String, String> {
    let trimmed = remote_path.trim();
    if trimmed.is_empty() {
        return Err("远端路径为空".to_string());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err(format!("远端路径不能是绝对路径：{remote_path}"));
    }
    if trimmed.contains('\\') {
        return Err(format!("远端路径包含非法分隔符：{remote_path}"));
    }
    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        segments.push(sanitize_segment(segment)?);
    }
    Ok(segments.join("/"))
}

/// 净化 revision 作为路径段（v0.2.0）：
///
/// - 按 `/` 分段，每段用 [`sanitize_segment`] 校验（支持 `refs/pr/3`、`feature/x` 等分支名）；
/// - 拒绝 `..`、绝对路径、盘符、反斜杠、保留名等。
pub fn sanitize_revision(revision: &str) -> Result<String, String> {
    let trimmed = revision.trim();
    if trimmed.is_empty() {
        return Err("revision 不能为空".to_string());
    }
    if trimmed.contains('\\') || trimmed.starts_with('/') {
        return Err(format!("revision 格式无效：{revision}"));
    }
    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        segments.push(sanitize_segment(segment)?);
    }
    Ok(segments.join("/"))
}

/// 校验下载目录必须为绝对路径（Windows 下 `/foo`、`C:foo` 均会被拒绝）。
pub fn ensure_absolute_dir(dir: &str) -> Result<(), String> {
    let path = Path::new(dir);
    if !path.is_absolute() {
        return Err(format!("目录必须是绝对路径：{dir}"));
    }
    Ok(())
}

/// 下载任务的三个路径（最终文件 / `.part` / `.part.json`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskPaths {
    pub final_path: PathBuf,
    pub part_path: PathBuf,
    pub meta_path: PathBuf,
}

/// 由 `saveDir + repoId + remotePath` 计算任务路径（不做 IO，默认 revision 布局）。
pub fn build_task_paths(
    save_dir: &str,
    repo_id: &str,
    remote_path: &str,
) -> Result<TaskPaths, String> {
    build_task_paths_inner(save_dir, repo_id, remote_path, None)
}

/// v0.2.0：由 `saveDir + repoId + revision + remotePath` 计算任务路径。
///
/// - 默认 revision（HF `main` / MS `master`）→ 与旧版完全一致：
///   `{saveDir}/{repoId}/{remotePath}`（历史任务/本地库路径不变）；
/// - 非默认 revision → 增加 revision 段：
///   `{saveDir}/{repoId}/{revision 的安全形式}/{remotePath}`，避免不同分支同名文件互相覆盖。
pub fn build_task_paths_revision(
    save_dir: &str,
    repo_id: &str,
    remote_path: &str,
    revision: &str,
    default_revision: &str,
) -> Result<TaskPaths, String> {
    let extra_revision = if revision.trim() == default_revision.trim() {
        None
    } else {
        Some(sanitize_revision(revision)?)
    };
    build_task_paths_inner(save_dir, repo_id, remote_path, extra_revision.as_deref())
}

fn build_task_paths_inner(
    save_dir: &str,
    repo_id: &str,
    remote_path: &str,
    revision: Option<&str>,
) -> Result<TaskPaths, String> {
    ensure_absolute_dir(save_dir)?;
    let repo_id = sanitize_repo_id(repo_id)?;
    let remote_path = sanitize_remote_path(remote_path)?;

    let mut final_path = PathBuf::from(save_dir.trim());
    for segment in repo_id.split('/') {
        final_path.push(segment);
    }
    if let Some(revision) = revision {
        for segment in revision.split('/') {
            final_path.push(segment);
        }
    }
    for segment in remote_path.split('/') {
        final_path.push(segment);
    }

    let part_path = with_suffix(&final_path, ".part");
    let meta_path = with_suffix(&final_path, ".part.json");
    Ok(TaskPaths {
        final_path,
        part_path,
        meta_path,
    })
}

/// 在路径末尾追加后缀（如 `.part` / `.part.json`），不改变扩展名语义。
pub fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

/// 下载前准备：校验 saveDir、创建下载目录与各父目录、拒绝符号链接/junction/越界路径。
///
/// 返回可安全写入的三个路径。同步 IO，调用方应避免在长时间持锁时调用。
pub fn prepare_download(
    save_dir: &str,
    repo_id: &str,
    remote_path: &str,
) -> Result<TaskPaths, String> {
    let paths = build_task_paths(save_dir, repo_id, remote_path)?;
    prepare_download_paths(paths, save_dir)
}

/// v0.2.0：按 revision 规则计算路径并完成下载前准备（默认 revision 布局与旧版一致）。
pub fn prepare_download_revision(
    save_dir: &str,
    repo_id: &str,
    remote_path: &str,
    revision: &str,
    default_revision: &str,
) -> Result<TaskPaths, String> {
    let paths =
        build_task_paths_revision(save_dir, repo_id, remote_path, revision, default_revision)?;
    prepare_download_paths(paths, save_dir)
}

fn prepare_download_paths(paths: TaskPaths, save_dir: &str) -> Result<TaskPaths, String> {
    let root = PathBuf::from(save_dir.trim());
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("无法创建下载目录 {}：{e}", root.display()))?;
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("无法解析下载目录 {}：{e}", root.display()))?;
    let relative = paths
        .final_path
        .strip_prefix(&root)
        .map_err(|_| "下载路径越界，已拒绝".to_string())?;
    ensure_safe_relative(&root_canon, relative)?;
    Ok(paths)
}

/// 从 `root_canon` 起逐段检查 `relative` 路径：父目录自动创建；拒绝符号链接/junction
/// （通过 canonicalize 前缀校验）与同名文件冲突；目标文件若已存在则必须是普通文件。
pub fn ensure_safe_relative(root_canon: &Path, relative: &Path) -> Result<(), String> {
    let components: Vec<&std::ffi::OsStr> = relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name),
            _ => Err("路径包含非法片段，已拒绝".to_string()),
        })
        .collect::<Result<_, String>>()?;

    if components.is_empty() {
        return Err("下载路径为空，已拒绝".to_string());
    }

    let mut current = root_canon.to_path_buf();
    for (index, name) in components.iter().enumerate() {
        current.push(name);
        let is_target = index + 1 == components.len();
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                let file_type = metadata.file_type();
                if file_type.is_symlink() {
                    return Err(format!(
                        "路径包含符号链接（可能是 junction），已拒绝下载：{}",
                        current.display()
                    ));
                }
                if is_target {
                    if file_type.is_dir() {
                        return Err(format!(
                            "目标路径是目录而不是文件：{}",
                            current.display()
                        ));
                    }
                } else {
                    if !file_type.is_dir() {
                        return Err(format!(
                            "父路径不是目录：{}",
                            current.display()
                        ));
                    }
                    verify_within_root(root_canon, &current)?;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if is_target {
                    // 目标文件尚不存在：父目录都已校验，安全。
                    break;
                }
                std::fs::create_dir(&current)
                    .map_err(|e| format!("无法创建目录 {}：{e}", current.display()))?;
                verify_within_root(root_canon, &current)?;
            }
            Err(err) => {
                return Err(format!("无法检查路径 {}：{err}", current.display()));
            }
        }
    }
    Ok(())
}

fn verify_within_root(root_canon: &Path, path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("无法解析路径 {}：{e}", path.display()))?;
    if !canonical.starts_with(root_canon) {
        return Err(format!("路径越界，已拒绝：{}", path.display()));
    }
    Ok(())
}

/// 删除文件，不存在时视为成功。
pub fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("删除文件失败 {}：{err}", path.display())),
    }
}

/// 删除下载临时文件（`.part` 与 `.part.json`），忽略错误。
pub fn remove_task_temp_files(paths: &TaskPaths) {
    let _ = remove_file_if_exists(&paths.part_path);
    let _ = remove_file_if_exists(&paths.meta_path);
}

// ---------------------------------------------------------------------------
// 原子写 / JSON
// ---------------------------------------------------------------------------

/// 临时文件 + rename 的原子写。
pub fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let parent = path
        .parent()
        .ok_or_else(|| "目标文件路径无效".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建目录 {}：{e}", parent.display()))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let temp_path = parent.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let write_result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("写入临时文件失败：{err}"));
    }
    if let Err(err) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("原子写入失败：{err}"));
    }
    Ok(())
}

/// JSON 原子写。
pub fn atomic_write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("序列化 JSON 失败：{e}"))?;
    atomic_write_bytes(path, &bytes)
}

/// 读取 JSON 文件（失败返回中文错误）。
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("读取文件失败 {}：{e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("解析 JSON 失败 {}：{e}", path.display()))
}

/// 读取 JSON 文件，缺失或损坏返回 `None`。
pub fn read_json_opt<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ---------------------------------------------------------------------------
// 事件抽象
// ---------------------------------------------------------------------------

/// 事件发送抽象。`download` / `queue` 等模块通过它发事件，测试可注入记录器。
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);

    /// 可选：返回 `AppHandle` 以使用系统通知等平台能力（测试 sink 返回 `None`）。
    ///
    /// 单元测试构建不编译平台相关实现（见 `lib.rs` 中 cfg 说明）。
    #[cfg(not(test))]
    fn app_handle(&self) -> Option<&tauri::AppHandle> {
        None
    }
}

/// 什么都不做的 sink（单元测试 / 无窗口场景）。
pub struct NoopSink;

impl EventSink for NoopSink {
    fn emit(&self, _event: &str, _payload: Value) {}
}

/// 基于 Tauri `AppHandle` 的 sink（仅非单元测试构建编译）。
#[cfg(not(test))]
pub struct AppHandleSink {
    app: tauri::AppHandle,
}

#[cfg(not(test))]
impl AppHandleSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(not(test))]
impl EventSink for AppHandleSink {
    fn emit(&self, event: &str, payload: Value) {
        use tauri::Emitter;
        if let Err(err) = self.app.emit(event, payload) {
            eprintln!("发送事件 {event} 失败：{err}");
        }
    }

    fn app_handle(&self) -> Option<&tauri::AppHandle> {
        Some(&self.app)
    }
}

/// 发送 `task-updated { task }`。
pub fn emit_task_updated(sink: &dyn EventSink, task: &DownloadTask) {
    match serde_json::to_value(task) {
        Ok(task) => sink.emit("task-updated", serde_json::json!({ "task": task })),
        Err(err) => eprintln!("序列化任务失败：{err}"),
    }
}

/// 发送 `download-progress { taskId, downloaded, totalSize, speed }`。
pub fn emit_progress(
    sink: &dyn EventSink,
    task_id: &str,
    downloaded: u64,
    total_size: u64,
    speed: u64,
) {
    sink.emit(
        "download-progress",
        serde_json::json!({
            "taskId": task_id,
            "downloaded": downloaded,
            "totalSize": total_size,
            "speed": speed,
        }),
    );
}

/// 发送 `tasks-removed { taskIds }`。
pub fn emit_tasks_removed(sink: &dyn EventSink, task_ids: &[String]) {
    sink.emit(
        "tasks-removed",
        serde_json::json!({ "taskIds": task_ids }),
    );
}

/// 发送 `settings-updated { settings }`。
pub fn emit_settings_updated(sink: &dyn EventSink, settings: &Settings) {
    match serde_json::to_value(settings) {
        Ok(settings) => sink.emit("settings-updated", serde_json::json!({ "settings": settings })),
        Err(err) => eprintln!("序列化设置失败：{err}"),
    }
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------

/// 构建全局 reqwest client：连接超时 30s、无整体请求超时（大文件可能数小时）。
pub fn build_http_client(settings: &Settings) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("ModelDownloadManager/0.1 (+https://github.com/)")
        .connect_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(10));
    let proxy = settings.proxy.trim();
    if !proxy.is_empty() {
        let proxy = reqwest::Proxy::all(proxy).map_err(|e| format!("代理地址无效：{e}"))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))
}

// ---------------------------------------------------------------------------
// 资源管理器
// ---------------------------------------------------------------------------

/// 在资源管理器中打开目录/文件；`reveal = true` 且路径为文件时选中该文件。
pub fn open_in_explorer(path: &Path, reveal: bool) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("路径不存在：{}", path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");
        if reveal && path.is_file() {
            command.arg(format!("/select,{}", path.display()));
        } else {
            command.arg(path.as_os_str());
        }
        command
            .spawn()
            .map_err(|e| format!("无法打开资源管理器：{e}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = reveal;
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(opener)
            .arg(path)
            .spawn()
            .map_err(|e| format!("无法打开文件管理器：{e}"))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 全局令牌桶限速
// ---------------------------------------------------------------------------

struct Bucket {
    tokens: f64,
    last: Instant,
}

/// 全局字节级令牌桶：`bandwidthLimit == 0` 时不限速；按 50ms 粒度补充。
pub struct BandwidthLimiter {
    rate: AtomicU64,
    bucket: tokio::sync::Mutex<Bucket>,
}

impl BandwidthLimiter {
    pub fn new(bytes_per_second: u64) -> Self {
        Self {
            rate: AtomicU64::new(bytes_per_second),
            bucket: tokio::sync::Mutex::new(Bucket {
                tokens: 0.0,
                last: Instant::now(),
            }),
        }
    }

    /// 更新限速（0 = 不限速），立即生效。
    pub fn set_rate(&self, bytes_per_second: u64) {
        self.rate.store(bytes_per_second, Ordering::Relaxed);
    }

    pub fn rate(&self) -> u64 {
        self.rate.load(Ordering::Relaxed)
    }

    /// 消耗 `bytes` 字节预算；预算不足时按 50ms 粒度等待。
    pub async fn acquire(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        loop {
            let rate = self.rate();
            if rate == 0 {
                return;
            }
            let wait_secs = {
                let mut bucket = self.bucket.lock().await;
                let now = Instant::now();
                let elapsed = now.duration_since(bucket.last).as_secs_f64();
                bucket.last = now;
                // 允许最多 1 秒的突发额度，避免短时抖动。
                bucket.tokens = (bucket.tokens + elapsed * rate as f64).min(rate as f64);
                if bucket.tokens >= bytes as f64 {
                    bucket.tokens -= bytes as f64;
                    return;
                }
                (bytes as f64 - bucket.tokens) / rate as f64
            };
            let sleep = Duration::from_secs_f64(wait_secs.clamp(0.001, 0.05));
            tokio::time::sleep(sleep).await;
        }
    }

    /// 阻塞式消耗（测试与同步上下文使用）。
    pub fn try_consume(&self, bytes: u64) -> bool {
        if self.rate() == 0 || bytes == 0 {
            return true;
        }
        let mut bucket = match self.bucket.try_lock() {
            Ok(bucket) => bucket,
            Err(_) => return false,
        };
        let now = Instant::now();
        let elapsed = now.duration_since(bucket.last).as_secs_f64();
        bucket.last = now;
        bucket.tokens = (bucket.tokens + elapsed * self.rate() as f64).min(self.rate() as f64);
        if bucket.tokens >= bytes as f64 {
            bucket.tokens -= bytes as f64;
            true
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// 简单取消/暂停标志组合
// ---------------------------------------------------------------------------

/// 取消标记（供纯函数使用，实际任务控制见 `state::TaskControl`）。
#[derive(Debug, Default)]
pub struct CancelFlag(pub AtomicBool);

impl CancelFlag {
    pub fn set(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------------------
// 错误文案 URL 脱敏
// ---------------------------------------------------------------------------

/// 脱敏错误文案中的 URL：只保留 `scheme + host + path`，丢弃 query/fragment。
///
/// 用于确保 HF/CDN 预签名链接（`?token=`、`?X-Amz-*`、`auth_key` 等）不会出现在
/// 用户可见的错误信息或日志里。
pub fn redact_urls(text: &str) -> String {
    fn find_url_start(text: &str) -> Option<(usize, usize)> {
        let https = text
            .find("https://")
            .map(|index| (index, "https://".len()));
        let http = text.find("http://").map(|index| (index, "http://".len()));
        match (https, http) {
            (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
            (a, b) => a.or(b),
        }
    }

    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let Some((index, _scheme_len)) = find_url_start(rest) else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..index]);
        let tail = &rest[index..];
        let end = tail
            .find(|character: char| {
                character.is_whitespace()
                    || matches!(character, ')' | ']' | '}' | '"' | '\'' | ',' | ';' | '>')
            })
            .unwrap_or(tail.len());
        let url = &tail[..end];
        let cut = url
            .find(|character| character == '?' || character == '#')
            .unwrap_or(url.len());
        output.push_str(&url[..cut]);
        rest = &tail[end..];
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_url_query_and_fragment() {
        let text = "网络请求失败：error sending request for url \
                    (https://cdn-lfs.example.com/repo/file.bin?token=secret&X-Amz-Signature=abc#frag)";
        let redacted = redact_urls(text);
        assert!(redacted.contains("https://cdn-lfs.example.com/repo/file.bin"));
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("X-Amz-Signature"));
        assert!(!redacted.contains("#frag"));
        // 多个 URL 与无 URL 文本都要正确处理。
        let many = redact_urls("a http://x.test/p?auth_key=1 b https://y.test/q?z=2 c");
        assert_eq!(many, "a http://x.test/p b https://y.test/q c");
        assert_eq!(redact_urls("没有链接的中文错误"), "没有链接的中文错误");
    }

    #[test]
    fn classifies_files_per_contract() {
        assert_eq!(classify_file("model.safetensors"), FileKind::Weight);
        assert_eq!(classify_file("model-00001-of-00004.bin"), FileKind::Weight);
        assert_eq!(classify_file("model.safetensors.index.json"), FileKind::Weight);
        assert_eq!(classify_file("pytorch_model.bin.index.json"), FileKind::Weight);
        assert_eq!(classify_file("pytorch_model.bin"), FileKind::Weight);
        assert_eq!(classify_file("model.onnx"), FileKind::Weight);
        assert_eq!(classify_file("weights.pkl"), FileKind::Weight);
        // v0.1.2 新增权重类扩展名。
        assert_eq!(classify_file("qwen38-flash-next-mtp.hgn"), FileKind::Weight);
        assert_eq!(classify_file("model.gguf_file"), FileKind::Weight);
        assert_eq!(classify_file("embeddings.npy"), FileKind::Weight);
        assert_eq!(classify_file("weights.pickle"), FileKind::Weight);
        assert_eq!(classify_file("model.joblib"), FileKind::Weight);
        assert_eq!(classify_file("model.keras"), FileKind::Weight);
        assert_eq!(classify_file("model.nemo"), FileKind::Weight);
        assert_eq!(classify_file("model.sft"), FileKind::Weight);
        assert_eq!(classify_file("model.mindir"), FileKind::Weight);
        assert_eq!(classify_file("model.om"), FileKind::Weight);
        assert_eq!(classify_file("model.plan"), FileKind::Weight);
        assert_eq!(classify_file("model.onnx_data"), FileKind::Weight);
        assert_eq!(classify_file("model.dat"), FileKind::Weight);
        assert_eq!(classify_file("config.json"), FileKind::Config);
        assert_eq!(classify_file("tokenizer.model"), FileKind::Config);
        assert_eq!(classify_file("README.md"), FileKind::Config);
        assert_eq!(classify_file("vocab.txt"), FileKind::Config);
        assert_eq!(classify_file("tokenizer.spm"), FileKind::Config);
        assert_eq!(classify_file("image.png"), FileKind::Other);
        assert_eq!(classify_file("noext"), FileKind::Other);
    }

    #[test]
    fn classifies_mmproj_per_contract() {
        // 多模态投影器：仅权重类扩展名 + mmproj/clip 词元。
        assert_eq!(
            classify_file("mmproj-Qwen3.8-Flash-Next-f16.gguf"),
            FileKind::Mmproj
        );
        assert_eq!(
            classify_file("mmproj-Qwen3.8-Flash-Next-f16.gguf_file"),
            FileKind::Mmproj
        );
        assert_eq!(
            classify_file("clip_vision_model.safetensors"),
            FileKind::Mmproj
        );
        // 路径形式取 basename 后同样生效。
        assert_eq!(
            classify_file("org/model/mmproj-model-f16.gguf"),
            FileKind::Mmproj
        );
        // 普通权重不能被误判。
        assert_eq!(classify_file("model.gguf"), FileKind::Weight);
        assert_eq!(classify_file("qwen38-flash-next-mtp.hgn"), FileKind::Weight);
    }

    #[test]
    fn classifies_imatrix_per_contract() {
        // 重要性矩阵：权重类扩展名 + imatrix 词元。
        assert_eq!(classify_file("imatrix_unsloth.gguf_file"), FileKind::Imatrix);
        assert_eq!(classify_file("imatrix.gguf"), FileKind::Imatrix);
        assert_eq!(classify_file("imatrix.dat"), FileKind::Imatrix);
        assert_eq!(classify_file("org/model/imatrix.gguf"), FileKind::Imatrix);
        // 无 imatrix 词元的普通权重保持 weight。
        assert_eq!(classify_file("model.dat"), FileKind::Weight);
    }

    #[test]
    fn classifies_config_names_not_misled_by_projection_tokens() {
        // 配置类/脚本扩展名不参与 mmproj/imatrix 名称判定。
        assert_eq!(classify_file("mmproj_config.json"), FileKind::Config);
        assert_eq!(classify_file("convert_mmproj_to_gguf.py"), FileKind::Config);
        assert_eq!(classify_file("imatrix_README.md"), FileKind::Config);
        assert_eq!(classify_file("README.md"), FileKind::Config);
        assert_eq!(classify_file("image.png"), FileKind::Other);
        assert_eq!(classify_file("noext"), FileKind::Other);
    }

    #[test]
    fn file_kind_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&FileKind::Mmproj).unwrap(),
            "\"mmproj\""
        );
        assert_eq!(
            serde_json::to_string(&FileKind::Imatrix).unwrap(),
            "\"imatrix\""
        );
        assert_eq!(
            serde_json::to_string(&FileKind::Weight).unwrap(),
            "\"weight\""
        );
        assert_eq!(FileKind::Mmproj.label(), "投影器");
        assert_eq!(FileKind::Imatrix.label(), "权重矩阵");
    }

    #[test]
    fn rejects_dangerous_remote_paths() {
        for bad in [
            "../etc/passwd",
            "a/../../b",
            "/absolute/path",
            "\\server\\share\\file",
            "C:/windows/system32",
            "C:\\windows",
            "dir//file",
            "file.",
            "CON",
            "a/aux.bin",
        ] {
            assert!(
                sanitize_remote_path(bad).is_err(),
                "应拒绝非法路径: {bad}"
            );
        }
        assert_eq!(
            sanitize_remote_path("sub dir/model-00001-of-00004.safetensors").unwrap(),
            "sub dir/model-00001-of-00004.safetensors"
        );
    }

    #[test]
    fn sanitizes_repo_ids() {
        assert_eq!(
            sanitize_repo_id("Qwen/Qwen2.5-7B-Instruct").unwrap(),
            "Qwen/Qwen2.5-7B-Instruct"
        );
        assert_eq!(sanitize_repo_id("gpt2").unwrap(), "gpt2");
        assert!(sanitize_repo_id("../evil").is_err());
        assert!(sanitize_repo_id("a/b/c").is_err());
        assert!(sanitize_repo_id("").is_err());
    }

    #[test]
    fn builds_paths_under_save_dir() {
        let paths =
            build_task_paths("C:\\Models", "org/model", "sub/model.safetensors").unwrap();
        assert_eq!(
            paths.final_path,
            PathBuf::from("C:\\Models\\org\\model\\sub\\model.safetensors")
        );
        assert_eq!(
            paths.part_path,
            PathBuf::from("C:\\Models\\org\\model\\sub\\model.safetensors.part")
        );
        assert_eq!(
            paths.meta_path,
            PathBuf::from("C:\\Models\\org\\model\\sub\\model.safetensors.part.json")
        );
        assert!(build_task_paths("relative", "a/b", "c.bin").is_err());
    }

    #[test]
    fn revision_affects_path_only_when_non_default() {
        let legacy = build_task_paths("C:\\Models", "org/model", "sub/model.safetensors").unwrap();

        // 默认 revision（HF main / MS master）→ 路径与 v0.1.x 完全一致。
        let hf_default = build_task_paths_revision(
            "C:\\Models",
            "org/model",
            "sub/model.safetensors",
            "main",
            "main",
        )
        .unwrap();
        assert_eq!(hf_default, legacy, "HF 默认 revision 路径必须保持不变");
        let ms_default = build_task_paths_revision(
            "C:\\Models",
            "org/model",
            "sub/model.safetensors",
            "master",
            "master",
        )
        .unwrap();
        assert_eq!(ms_default, legacy, "ModelScope 默认 revision 路径必须保持不变");

        // 非默认 revision → 增加 revision 段。
        let tagged = build_task_paths_revision(
            "C:\\Models",
            "org/model",
            "sub/model.safetensors",
            "v1.0",
            "main",
        )
        .unwrap();
        assert_eq!(
            tagged.final_path,
            PathBuf::from("C:\\Models\\org\\model\\v1.0\\sub\\model.safetensors")
        );
        assert_eq!(
            tagged.part_path,
            PathBuf::from("C:\\Models\\org\\model\\v1.0\\sub\\model.safetensors.part")
        );
        assert_ne!(
            tagged.final_path, legacy.final_path,
            "同名文件不同 revision 的 savePath 必须不同"
        );

        // 多级 revision（分支名含 `/`）逐段净化。
        let branch = build_task_paths_revision(
            "C:\\Models",
            "org/model",
            "config.json",
            "refs/pr/3",
            "main",
        )
        .unwrap();
        assert_eq!(
            branch.final_path,
            PathBuf::from("C:\\Models\\org\\model\\refs\\pr\\3\\config.json")
        );

        // 非法 revision 拒绝（`..`、盘符、反斜杠、绝对路径、空）。
        for bad in ["..", "../x", "C:/windows", "a\\b", "/abs", "", "  "] {
            assert!(
                build_task_paths_revision("C:\\Models", "org/model", "f.bin", bad, "main").is_err(),
                "应拒绝非法 revision：{bad:?}"
            );
        }
    }

    #[test]
    fn prepare_download_revision_creates_revision_dir() {
        let root = std::env::temp_dir().join(format!("mdm-prep-rev-{}", now_millis()));
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_string_lossy().into_owned();
        let paths =
            prepare_download_revision(&root_str, "org/model", "dir/weights.bin", "dev", "main")
                .unwrap();
        assert!(paths.final_path.parent().unwrap().is_dir());
        assert!(paths
            .final_path
            .parent()
            .unwrap()
            .to_string_lossy()
            .contains("dev"));
        // 默认 revision 不增加额外目录。
        let default_paths =
            prepare_download_revision(&root_str, "org/model", "dir/weights.bin", "main", "main")
                .unwrap();
        assert!(!default_paths
            .final_path
            .parent()
            .unwrap()
            .to_string_lossy()
            .contains("main"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_write_and_read_json_roundtrip() {
        let dir = std::env::temp_dir().join(format!("mdm-util-test-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.json");
        let value = serde_json::json!({ "a": 1, "b": "中文" });
        atomic_write_json(&path, &value).unwrap();
        let read: serde_json::Value = read_json(&path).unwrap();
        assert_eq!(read, value);
        // 原子写后目录中不应残留临时文件。
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prepare_download_rejects_symlinks_and_creates_dirs() {
        let root = std::env::temp_dir().join(format!("mdm-prep-{}", now_millis()));
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_string_lossy().into_owned();
        let paths = prepare_download(&root_str, "org/model", "dir/weights.bin").unwrap();
        assert!(paths.final_path.parent().unwrap().is_dir());

        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_dir;
            let target = root.join("outside");
            std::fs::create_dir_all(&target).unwrap();
            let link = root.join("org").join("link");
            if symlink_dir(&target, &link).is_ok() {
                assert!(prepare_download(&root_str, "org/link", "x.bin").is_err());
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn token_bucket_unlimited_returns_immediately() {
        let limiter = BandwidthLimiter::new(0);
        let start = Instant::now();
        limiter.acquire(10 * 1024 * 1024).await;
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    #[tokio::test]
    async fn token_bucket_waits_when_budget_insufficient() {
        let limiter = BandwidthLimiter::new(10_000); // 10 KB/s
        let start = Instant::now();
        limiter.acquire(1_000).await;
        assert!(start.elapsed() < Duration::from_millis(500));
        // 超出当前预算，必须等待补充。
        let second = Instant::now();
        limiter.acquire(2_000).await;
        assert!(second.elapsed() >= Duration::from_millis(20));
    }
}
