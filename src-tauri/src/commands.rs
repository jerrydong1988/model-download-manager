//! Tauri 命令层（契约 §3，共 21 个命令）。
//!
//! 只做参数校验、状态调用与错误映射；具体逻辑在 `queue` / `sources` / `library`。
//! 所有参数经 `#[tauri::command(rename_all = "camelCase")]` 与前端 camelCase 对齐。

use std::path::PathBuf;
use std::sync::Arc;

use crate::models::{
    AppSnapshot, DownloadRequest, DownloadTask, LocalFile, RepoDetail, RepoSearchPage,
    RevisionList, SearchQuery, Settings, Source,
};
use crate::queue;
use crate::sources;
use crate::state::AppState;
use crate::util::{self, AppHandleSink, EventSink};

// ---------------------------------------------------------------------------
// 1. get_snapshot
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn get_snapshot(state: tauri::State<'_, Arc<AppState>>) -> Result<AppSnapshot, String> {
    let state = state.inner();
    Ok(AppSnapshot {
        tasks: state.tasks_snapshot(),
        settings: state.current_settings(),
        app_version: crate::models::APP_VERSION.to_string(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        default_download_dir: crate::settings::default_download_dir(),
    })
}

// ---------------------------------------------------------------------------
// 2. search_repos
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub async fn search_repos(
    state: tauri::State<'_, Arc<AppState>>,
    source: Source,
    query: String,
    page: u32,
    limit: u32,
    cursor: Option<String>,
) -> Result<RepoSearchPage, String> {
    let state = state.inner().clone();
    let query = SearchQuery {
        source,
        query: query.trim().to_string(),
        page: page.max(1),
        limit: limit.clamp(1, 50),
        cursor: cursor.filter(|cursor| !cursor.trim().is_empty()),
    };
    let client = state.current_client();
    let settings = state.current_settings();
    sources::search(&client, &settings, &query).await
}

// ---------------------------------------------------------------------------
// 3. get_repo_detail
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub async fn get_repo_detail(
    state: tauri::State<'_, Arc<AppState>>,
    source: Source,
    repo_id: String,
    revision: Option<String>,
) -> Result<RepoDetail, String> {
    let state = state.inner().clone();
    let client = state.current_client();
    let settings = state.current_settings();
    sources::get_repo_detail(
        &client,
        &settings,
        source,
        &repo_id,
        revision.as_deref(),
    )
    .await
}

// ---------------------------------------------------------------------------
// 4. start_downloads
// ---------------------------------------------------------------------------

/// 命令 4：批量新建下载任务。
///
/// 注意：自 P2a 起本命令**逐条校验、非法项被跳过**（仅当整批全部非法时返回首个中文
/// 错误，前端 toast 可提示）；返回值仍为契约规定的「实际新建的任务列表」。
#[tauri::command(rename_all = "camelCase")]
pub fn start_downloads(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    requests: Vec<DownloadRequest>,
) -> Result<Vec<DownloadTask>, String> {
    let sink = AppHandleSink::new(app);
    queue::start_downloads(state.inner(), requests, &sink)
}

// ---------------------------------------------------------------------------
// 5-10. 单任务操作
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn pause_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    queue::pause_task(state.inner(), &sink, &task_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn resume_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    queue::resume_task(state.inner(), &sink, &task_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn pause_all(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    queue::pause_all(state.inner(), &sink);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn resume_all(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    queue::resume_all(state.inner(), &sink);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
    delete_partial: bool,
) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    queue::cancel_task(state.inner(), &sink, &task_id, delete_partial)
}

#[tauri::command(rename_all = "camelCase")]
pub fn retry_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    queue::retry_task(state.inner(), &sink, &task_id)
}

// ---------------------------------------------------------------------------
// 11-12. 任务记录清理
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn remove_tasks(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    task_ids: Vec<String>,
) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    queue::remove_tasks(state.inner(), &sink, &task_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn clear_finished(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    queue::clear_finished(state.inner(), &sink)
}

// ---------------------------------------------------------------------------
// 13-14. 设置
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn get_settings(state: tauri::State<'_, Arc<AppState>>) -> Result<Settings, String> {
    Ok(state.inner().current_settings())
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    settings: Settings,
) -> Result<Settings, String> {
    let effective = state.inner().save_settings(settings)?;
    let sink = AppHandleSink::new(app);
    util::emit_settings_updated(&sink, &effective);
    Ok(effective)
}

// ---------------------------------------------------------------------------
// 15. scan_library
// ---------------------------------------------------------------------------

/// 扫描根列表（v0.2.0）：downloadDir 始终在首位，其后为已规范化的 libraryRoots。
fn library_scan_roots(settings: &Settings) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from(settings.download_dir.trim())];
    for root in &settings.library_roots {
        let path = PathBuf::from(root);
        if !roots.iter().any(|existing| existing == &path) {
            roots.push(path);
        }
    }
    roots
}

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_library(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<LocalFile>, String> {
    let state = state.inner().clone();
    let settings = state.current_settings();
    let tasks = state.tasks_snapshot();
    let roots = library_scan_roots(&settings);
    // 扫描是同步 IO，放到阻塞线程池，避免卡住异步运行时。
    tokio::task::spawn_blocking(move || crate::library::scan_library(&roots, &tasks))
        .await
        .map_err(|err| format!("扫描本地模型库失败：{err}"))
}

// ---------------------------------------------------------------------------
// 16. open_path
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn open_path(path: String, reveal: bool) -> Result<(), String> {
    util::open_in_explorer(std::path::Path::new(&path), reveal)
}

// ---------------------------------------------------------------------------
// 17. delete_local_file
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn delete_local_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    remove_task: bool,
) -> Result<(), String> {
    let sink = AppHandleSink::new(app);
    delete_local_file_impl(state.inner(), &sink, &path, remove_task)
}

fn delete_local_file_impl(
    state: &Arc<AppState>,
    sink: &dyn EventSink,
    path: &str,
    remove_task: bool,
) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() {
            return Err("拒绝删除符号链接文件".to_string());
        }
    }

    // 只允许删除已配置扫描根（downloadDir ∪ libraryRoots）内的文件，防止前端误删任意路径。
    let settings = state.current_settings();
    let target_canon = target
        .canonicalize()
        .map_err(|err| format!("无法解析文件路径：{err}"))?;
    let allowed = library_scan_roots(&settings).iter().any(|root| {
        root.canonicalize()
            .map(|root_canon| target_canon.starts_with(&root_canon))
            .unwrap_or(false)
    });
    if !allowed {
        return Err("只能删除已配置扫描根目录内的文件".to_string());
    }

    let matched: Vec<DownloadTask> = state
        .tasks_snapshot()
        .into_iter()
        .filter(|task| task.save_path == path)
        .collect();
    if let Some(task) = matched.iter().find(|task| !task.status.is_terminal()) {
        return Err(format!("任务「{}」尚未结束，请先取消下载", task.file_name));
    }

    std::fs::remove_file(&target).map_err(|err| format!("删除文件失败：{err}"))?;
    // 同时清理可能残留的临时文件。
    let _ = std::fs::remove_file(util::with_suffix(&target, ".part"));
    let _ = std::fs::remove_file(util::with_suffix(&target, ".part.json"));

    if remove_task {
        let task_ids: Vec<String> = matched.iter().map(|task| task.task_id.clone()).collect();
        let removed = state.remove_tasks(&task_ids);
        if !removed.is_empty() {
            for task_id in &removed {
                state.remove_control(task_id);
            }
            util::emit_tasks_removed(sink, &removed);
            state.mark_dirty(true);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 18. test_connection
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub async fn test_connection(
    state: tauri::State<'_, Arc<AppState>>,
    source: Source,
) -> Result<String, String> {
    let state = state.inner().clone();
    let client = state.current_client();
    let settings = state.current_settings();
    sources::test_connection(&client, &settings, source).await
}

// ---------------------------------------------------------------------------
// 21. list_revisions（v0.2.0）
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub async fn list_revisions(
    state: tauri::State<'_, Arc<AppState>>,
    source: Source,
    repo_id: String,
) -> Result<RevisionList, String> {
    let state = state.inner().clone();
    let client = state.current_client();
    let settings = state.current_settings();
    sources::list_revisions(&client, &settings, source, &repo_id).await
}

// ---------------------------------------------------------------------------
// 19-20. 目录
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn get_default_download_dir() -> Result<String, String> {
    Ok(crate::settings::default_download_dir())
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_data_dir(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    util::open_in_explorer(&state.inner().data_dir, false)
}

// ---------------------------------------------------------------------------
// 22. disk_space
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn disk_space(path: String) -> Result<crate::models::DiskSpace, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请选择下载目录后再检查磁盘空间".to_string());
    }
    util::disk_space(std::path::Path::new(trimmed))
}
