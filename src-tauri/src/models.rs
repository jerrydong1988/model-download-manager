//! IPC 契约类型镜像（唯一事实来源：`docs/IPC-CONTRACT.md`）。
//!
//! 所有结构体按契约以 camelCase 序列化；时间戳为 Unix 毫秒，大小为字节。

use serde::{Deserialize, Serialize};

/// 应用版本号（来自 Cargo.toml）。
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 数据来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Huggingface,
    Modelscope,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Huggingface => "huggingface",
            Source::Modelscope => "modelscope",
        }
    }

    /// 用户可见的来源名称。
    pub fn label(self) -> &'static str {
        match self {
            Source::Huggingface => "HuggingFace",
            Source::Modelscope => "ModelScope",
        }
    }

    /// 默认 revision：HF 为 `main`，ModelScope 为 `master`。
    pub fn default_revision(self) -> &'static str {
        match self {
            Source::Huggingface => "main",
            Source::Modelscope => "master",
        }
    }
}

impl std::fmt::Display for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label())
    }
}

/// 仓库文件分类（v0.1.2 契约 §2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    /// 模型主权重（含 `.hgn` 等特殊格式、分片索引）。
    Weight,
    /// 多模态投影文件（文件名含 `mmproj`/`clip` 词元且为权重类扩展名，如 `mmproj-*.gguf`）。
    Mmproj,
    /// 量化重要性矩阵（文件名含 `imatrix` 词元，如 `imatrix_*.dat`）。
    Imatrix,
    /// 配置、分词器、脚本、文档等文本资产。
    Config,
    /// 图片/音频等杂项。
    Other,
}

impl FileKind {
    /// 中文展示名（与契约 §2 表格一致）。
    pub fn label(self) -> &'static str {
        match self {
            FileKind::Weight => "权重",
            FileKind::Mmproj => "投影器",
            FileKind::Imatrix => "权重矩阵",
            FileKind::Config => "配置",
            FileKind::Other => "其他",
        }
    }
}

/// 下载任务状态机。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Active,
    Pausing,
    Paused,
    Completed,
    Error,
    Cancelled,
}

impl TaskStatus {
    /// 终态：completed / error / cancelled。
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TaskStatus::Completed | TaskStatus::Error | TaskStatus::Cancelled
        )
    }

    /// 计入并发槽的状态（active / pausing）。
    pub fn is_running(self) -> bool {
        matches!(self, TaskStatus::Active | TaskStatus::Pausing)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Queued => "queued",
            TaskStatus::Active => "active",
            TaskStatus::Pausing => "pausing",
            TaskStatus::Paused => "paused",
            TaskStatus::Completed => "completed",
            TaskStatus::Error => "error",
            TaskStatus::Cancelled => "cancelled",
        }
    }
}

/// 应用设置（命令 13-14 / 事件 `settings-updated`）。
///
/// `Default` 实现位于 `settings.rs`（需要计算默认下载目录）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// 绝对路径；默认 `%USERPROFILE%\Documents\Models`
    pub download_dir: String,
    /// 可空；HuggingFace User Access Token
    pub hf_token: String,
    /// 可空；ModelScope SDK Token
    pub ms_token: String,
    /// 默认 `https://hf-mirror.com`（本机实测官方站不可达）；可切回 `https://huggingface.co`
    pub hf_endpoint: String,
    /// 默认 `https://www.modelscope.cn`
    pub ms_endpoint: String,
    /// 例如 `http://127.0.0.1:7890`；空 = 走系统环境变量
    pub proxy: String,
    /// 1..=8，默认 3
    pub concurrency: u32,
    /// 字节/秒，0 = 不限速，默认 0
    pub bandwidth_limit: u64,
    /// 0..=10，默认 3
    pub max_retries: u32,
    /// 启动时自动继续未完成任务，默认 true
    pub auto_resume: bool,
    /// v0.1.3：界面主题，`"light" | "dark" | "system"`，默认 "system"
    pub theme: String,
    /// v0.1.3：关闭窗口时隐藏到托盘继续后台下载，默认 true
    pub close_to_tray: bool,
    /// v0.1.3：下载完成/失败时发送系统通知，默认 true
    pub notifications_enabled: bool,
    /// v0.2.0：单文件下载连接数（HTTP Range 分段并行），1..=8，默认 4
    pub connections_per_file: u32,
    /// v0.2.0：本地库附加扫描根目录（绝对路径）；空 = 仅扫描 downloadDir
    pub library_roots: Vec<String>,
}

/// 搜索结果条目（命令 2）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub id: String,
    pub source: Source,
    pub downloads: u64,
    pub likes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gated: Option<bool>,
}

/// 搜索分页（命令 2）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSearchPage {
    pub items: Vec<RepoSummary>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// 仓库文件（命令 3 的 `RepoDetail.files` 元素）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFile {
    /// 仓库内相对路径，如 `model-00001-of-00004.safetensors`
    pub path: String,
    /// 文件名（`path` 的最后一段）
    pub name: String,
    /// 字节；未知为 0
    pub size: u64,
    pub kind: FileKind,
    /// 内容 sha256（小写十六进制）。HF 来自 LFS oid，ModelScope 来自 `Sha256`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// 仓库详情（命令 3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetail {
    pub id: String,
    pub source: Source,
    /// HF 默认 `main`，ModelScope 默认 `master`
    pub revision: String,
    pub files: Vec<RepoFile>,
    /// 所有文件 size 之和
    pub total_size: u64,
    pub downloads: u64,
    pub likes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

/// 下载完成后的内容校验。旧任务缺省为 `unavailable`（无校验和）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum VerifyStatus {
    #[default]
    Unavailable,
    Pending,
    Verified,
    Mismatch,
}

/// 下载任务（命令 4-12 / `task-updated` 事件 payload 的 `task`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    /// Per-process mutation sequence; persisted values reset at startup.
    #[serde(default)]
    pub update_seq: u64,
    pub task_id: String,
    pub source: Source,
    pub repo_id: String,
    /// 仓库内相对路径
    pub remote_path: String,
    pub file_name: String,
    /// 最终文件绝对路径
    pub save_path: String,
    /// 未完成临时文件绝对路径（`<savePath>.part`）
    pub temp_path: String,
    /// 远端大小（来自列表/响应头），未知为 0
    pub total_size: u64,
    /// 已下载字节（含续传历史）
    pub downloaded: u64,
    pub status: TaskStatus,
    /// 当前速度 字节/秒（仅 active 有意义，其他为 0）
    pub speed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 已重试次数
    pub retries: u32,
    /// v0.2.0：下载使用的仓库 revision（HF 默认 `main` / MS 默认 `master`）；
    /// 旧 `tasks.json` 缺失时为空，启动恢复时按来源默认值补齐。
    #[serde(default)]
    pub revision: String,
    /// Unix 毫秒
    pub added_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    /// 期望的内容 sha256。没有远端校验和时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// 完成后的校验结果。校验在改名之后异步进行，不占用下载并发槽。
    #[serde(default)]
    pub verify_status: VerifyStatus,
}

impl DownloadTask {
    /// 任务是否处于终态。
    pub fn is_terminal(&self) -> bool {
        self.status.is_terminal()
    }
}

/// 下载请求（命令 4 的入参元素）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub source: Source,
    pub repo_id: String,
    pub remote_path: String,
    /// 仓库列表中的大小；0 表示未知
    #[serde(default)]
    pub size: u64,
    /// 本次下载的根目录（`Settings.downloadDir` 或用户临时指定）
    pub save_dir: String,
    /// v0.2.0：可空；缺省用来源默认 revision（HF `main` / MS `master`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// 可空；仓库列表中的 sha256
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// 目标目录所在卷的可用空间（命令 22）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    /// 调用方可用字节
    pub free_bytes: u64,
    pub total_bytes: u64,
    /// 盘符或 UNC 共享，如 `D:`、`\\server\share`
    pub volume: String,
}

/// 本地模型库文件（命令 15）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    /// 绝对路径
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Unix 毫秒
    pub modified_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    pub kind: FileKind,
    /// v0.2.0：该文件所属扫描根目录（绝对路径）
    #[serde(default)]
    pub root_dir: String,
}

/// 仓库可下载 revision 列表（命令 21，v0.2.0）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionList {
    pub source: Source,
    pub repo_id: String,
    /// HF 为 `main`，ModelScope 为 `master`
    pub default_revision: String,
    /// 分支名
    pub branches: Vec<String>,
    /// 标签名
    pub tags: Vec<String>,
}

/// 启动快照（命令 1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub tasks: Vec<DownloadTask>,
    pub settings: Settings,
    /// `env!("CARGO_PKG_VERSION")`
    pub app_version: String,
    /// 应用数据目录（持久化文件所在）
    pub data_dir: String,
    pub default_download_dir: String,
}

/// 搜索入参（`sources` 模块内部使用，不直接暴露给前端）。
#[derive(Debug, Clone)]
pub struct SearchQuery {
    pub source: Source,
    pub query: String,
    /// 从 1 起
    pub page: u32,
    /// 1..=50
    pub limit: u32,
    /// 不透明分页游标（仅 HF 使用）
    pub cursor: Option<String>,
}
