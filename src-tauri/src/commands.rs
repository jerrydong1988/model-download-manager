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
// 3c. inspect_repo_files
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_repo_files(
    state: tauri::State<'_, Arc<AppState>>,
    source: Source,
    repo_id: String,
    revision: String,
    save_dir: String,
    files: Vec<crate::models::RepoFile>,
    verify: bool,
) -> Result<Vec<crate::local_files::LocalMatch>, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        crate::local_files::inspect(&state, source, &repo_id, &revision, &save_dir, &files, verify)
    })
    .await
    .map_err(|e| format!("检查本地文件失败：{e}"))
}

/// 命令 4：批量新建下载任务。
///
/// 注意：自 P2a 起本命令**逐条校验、非法项被跳过**（仅当整批全部非法时返回首个中文
/// 错误，前端 toast 可提示）；返回值仍为契约规定的「实际新建的任务列表」。
#[tauri::command(rename_all = "camelCase")]
pub async fn start_downloads(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    requests: Vec<DownloadRequest>,
) -> Result<Vec<DownloadTask>, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || queue::start_downloads(&state, requests, &AppHandleSink::new(app)))
        .await
        .map_err(|e| format!("创建下载任务失败：{e}"))?
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

/// 列出扫描根里残留的 `.part` 临时文件。
#[tauri::command(rename_all = "camelCase")]
pub async fn list_partials(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<LocalFile>, String> {
    let state = state.inner().clone();
    let settings = state.current_settings();
    let tasks = state.tasks_snapshot();
    let roots = library_scan_roots(&settings);
    tokio::task::spawn_blocking(move || crate::library::scan_partials(&roots, &tasks))
        .await
        .map_err(|err| format!("扫描临时文件失败：{err}"))
}

// ---------------------------------------------------------------------------
// 16. open_path
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn open_path(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    reveal: bool,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    ensure_within_scan_roots(state.inner(), &target)?;
    util::open_in_explorer(&target, reveal)
}

/// 确认路径（解析符号链接后）位于已配置扫描根（downloadDir ∪ libraryRoots）之内。
/// 供 `open_path` 使用，防止前端把任意路径交给系统打开器。
fn ensure_within_scan_roots(state: &Arc<AppState>, target: &std::path::Path) -> Result<(), String> {
    let target_canon = target
        .canonicalize()
        .map_err(|err| format!("无法解析路径：{err}"))?;
    let settings = state.current_settings();
    if !path_is_within_roots(&target_canon, &library_scan_roots(&settings)) {
        return Err("只能打开已配置扫描根目录内的路径".to_string());
    }
    Ok(())
}

/// 纯函数：`target`（已规范化）是否位于任一根目录之下。根目录无法解析时跳过该根。
fn path_is_within_roots(target_canon: &std::path::Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        root.canonicalize()
            .map(|root_canon| target_canon.starts_with(&root_canon))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod open_path_scope_tests {
    use super::path_is_within_roots;
    use std::path::PathBuf;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdm-scope-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn allows_paths_inside_a_configured_root() {
        let root = temp_root("in");
        let inside = root.join("model.bin");
        std::fs::write(&inside, b"x").unwrap();
        let inside_canon = inside.canonicalize().unwrap();
        assert!(path_is_within_roots(&inside_canon, std::slice::from_ref(&root)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_paths_outside_all_roots() {
        let root = temp_root("root");
        let other = temp_root("other");
        let outside = other.join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        let outside_canon = outside.canonicalize().unwrap();
        assert!(!path_is_within_roots(&outside_canon, std::slice::from_ref(&root)));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn rejects_sibling_directory_sharing_a_name_prefix() {
        // `root` 与 `root-evil` 字符串前缀相同，但不是父子关系，必须拒绝。
        let root = temp_root("pfx");
        let evil = PathBuf::from(format!("{}-evil", root.display()));
        std::fs::create_dir_all(&evil).unwrap();
        let file = evil.join("x.bin");
        std::fs::write(&file, b"x").unwrap();
        let file_canon = file.canonicalize().unwrap();
        assert!(!path_is_within_roots(&file_canon, std::slice::from_ref(&root)));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&evil);
    }

    #[test]
    fn unresolvable_root_is_skipped_not_trusted() {
        let root = temp_root("ok");
        let file = root.join("a.bin");
        std::fs::write(&file, b"x").unwrap();
        let file_canon = file.canonicalize().unwrap();
        let missing = PathBuf::from("Z:/definitely/not/here/mdm");
        assert!(path_is_within_roots(&file_canon, &[missing.clone(), root.clone()]));
        assert!(!path_is_within_roots(&file_canon, std::slice::from_ref(&missing)));
        let _ = std::fs::remove_dir_all(&root);
    }
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
    ensure_within_scan_roots(state, &target)
        .map_err(|_| "只能删除已配置扫描根目录内的文件".to_string())?;

    let matched: Vec<DownloadTask> = state
        .tasks_snapshot()
        .into_iter()
        .filter(|task| task.save_path == path)
        .collect();
    let tasks = state.tasks_snapshot();
    if let Some(task) = tasks.iter().find(|task| {
        !task.status.is_terminal() && (task.save_path == path || task.temp_path == path)
    }) {
        return Err(format!("任务「{}」尚未结束，请先取消下载", task.file_name));
    }

    std::fs::remove_file(&target).map_err(|err| format!("删除文件失败：{err}"))?;
    // 同时清理可能残留的临时文件。删除 `.part` 时，旁路元数据是同名 `.part.json`。
    let _ = std::fs::remove_file(util::with_suffix(&target, ".part"));
    let _ = std::fs::remove_file(util::with_suffix(&target, ".part.json"));
    if path.ends_with(".part") {
        let _ = std::fs::remove_file(util::with_suffix(&target, ".json"));
    }

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
