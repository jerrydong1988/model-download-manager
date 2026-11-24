//! 只检查当前仓库在所选保存目录的目标。浏览不创建目录，也不改变原任务的来源。

use std::collections::HashMap;
use std::fs::Metadata;
use std::path::Path;

use serde::Serialize;

use crate::integrity::{normalize_sha256, DigestCache};
use crate::models::{DownloadRequest, DownloadTask, RepoFile, Source, TaskStatus, VerifyStatus};
use crate::{state::AppState, util};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalStatus {
    Verified,
    NeedsHash,
    Present,
    Different,
    Occupied,
    Missing,
    Unreadable,
}

#[derive(Serialize)]
pub struct LocalMatch {
    pub path: String,
    pub status: LocalStatus,
    pub source: Option<Source>,
}

pub(crate) fn compare_content(
    cache: &DigestCache,
    path: &Path,
    metadata: &Metadata,
    size: u64,
    sha256: Option<&str>,
    verify: bool,
) -> LocalStatus {
    if size > 0 && size != metadata.len() {
        return LocalStatus::Different;
    }
    let Some(expected) = sha256.and_then(normalize_sha256) else {
        return LocalStatus::Present;
    };
    let actual = match cache.lookup(path) {
        Some(hash) => hash,
        None if !verify => return LocalStatus::NeedsHash,
        None => match cache.digest(path) {
            Ok(hash) => hash,
            Err(_) => return LocalStatus::Unreadable,
        },
    };
    if actual == expected {
        LocalStatus::Verified
    } else {
        LocalStatus::Different
    }
}

/// 共享所有权只允许复用已完成的最终文件。临时文件和仍在处理的任务始终独占路径。
pub(crate) fn reusable_owner(task: &DownloadTask) -> bool {
    task.status == TaskStatus::Completed
        && matches!(
            task.verify_status,
            VerifyStatus::Verified | VerifyStatus::Unavailable
        )
}

fn inspect_disk(
    cache: &DigestCache,
    root: Option<&Path>,
    path: &Path,
    size: u64,
    sha256: Option<&str>,
    verify: bool,
) -> LocalStatus {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LocalStatus::Missing,
        Ok(meta) if meta.is_file() => match (root, path.canonicalize()) {
            (Some(root), Ok(target)) if target.starts_with(root) => {
                compare_content(cache, &target, &meta, size, sha256, verify)
            }
            _ => LocalStatus::Unreadable,
        },
        _ => LocalStatus::Unreadable,
    }
}

/// 直接通过 IPC 入队也能识别旧版记录。可能耗时的首次读取放在入队锁之外。
pub(crate) fn verify_mirror_requests(state: &AppState, requests: &[DownloadRequest]) {
    let tasks = state.tasks_snapshot();
    let owners: HashMap<_, _> = tasks
        .iter()
        .filter(|task| reusable_owner(task))
        .map(|task| (util::task_path_key(Path::new(&task.save_path)), task))
        .collect();
    if owners.is_empty() {
        return;
    }
    for req in requests {
        let Some(expected) = req.sha256.as_deref().and_then(normalize_sha256) else {
            continue;
        };
        let default = req.source.default_revision();
        let revision = req
            .revision
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or(default);
        let Ok(paths) = util::build_task_paths_revision(
            &req.save_dir,
            &req.repo_id,
            &req.remote_path,
            revision,
            default,
        ) else {
            continue;
        };
        let Some(owner) = owners.get(&util::task_path_key(&paths.final_path)) else {
            continue;
        };
        if owner.source == req.source
            && owner.repo_id == req.repo_id
            && owner.revision == revision
            && owner.remote_path == req.remote_path
        {
            continue;
        }
        let root = Path::new(req.save_dir.trim()).canonicalize().ok();
        inspect_disk(
            &state.digests,
            root.as_deref(),
            &paths.final_path,
            req.size,
            Some(&expected),
            true,
        );
    }
}

pub fn inspect(
    state: &AppState,
    source: Source,
    repo_id: &str,
    revision: &str,
    save_dir: &str,
    files: &[RepoFile],
    verify: bool,
) -> Vec<LocalMatch> {
    let root = Path::new(save_dir.trim()).canonicalize().ok();
    let tasks = state.tasks_snapshot();
    let mut owners = HashMap::<String, Vec<usize>>::new();
    for (index, task) in tasks.iter().enumerate() {
        for key in util::task_path_keys(Path::new(&task.save_path)) {
            owners.entry(key).or_default().push(index);
        }
    }
    let mut matches = Vec::new();
    for file in files {
        let found = |status, owner| LocalMatch {
            path: file.path.clone(),
            status,
            source: owner,
        };
        let Ok(paths) = util::build_task_paths_revision(
            save_dir,
            repo_id,
            &file.path,
            revision,
            source.default_revision(),
        ) else {
            matches.push(found(LocalStatus::Unreadable, None));
            continue;
        };
        let path = &paths.final_path;
        let keys = util::task_path_keys(path);
        let mut claims = keys.iter().filter_map(|key| owners.get(key)).flatten();
        let owner = claims.next().map(|index| &tasks[*index]);
        let origin = owner.map(|task| task.source);
        if let Some(task) = owner {
            if claims.any(|&i| tasks[i].task_id != task.task_id)
                || keys[0] != util::task_path_key(Path::new(&task.save_path))
            {
                matches.push(found(LocalStatus::Occupied, origin));
                continue;
            }
            if !reusable_owner(task) {
                // 同一任务的实时进度、失败和取消状态仍由队列事件驱动。
                if task.source != source
                    || task.repo_id != repo_id
                    || task.revision != revision
                    || task.remote_path != file.path
                {
                    matches.push(found(LocalStatus::Occupied, origin));
                }
                continue;
            }
        }
        let status = inspect_disk(
            &state.digests,
            root.as_deref(),
            path,
            file.size,
            file.sha256.as_deref(),
            verify,
        );
        if status != LocalStatus::Missing || owner.is_some() {
            matches.push(found(status, origin));
        }
    }
    matches
}
