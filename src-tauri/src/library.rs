//! 本地模型库扫描（v0.2.0）：递归多个扫描根（downloadDir ∪ libraryRoots），
//! 每个根深度 ≤ 8、总文件数 ≤ 20000，跳过符号链接/临时文件，按修改时间倒序。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::models::{DownloadTask, LocalFile};
use crate::util;

/// 最大递归深度（相对于每个扫描根）。
pub const MAX_DEPTH: usize = 8;
/// 最多返回文件数（跨所有根合计）。
pub const MAX_FILES: usize = 20_000;

/// Return the same canonical path that passed the scan-root boundary check.
pub fn resolve_scan_path(target: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let target = dunce::canonicalize(target).map_err(|e| format!("无法解析路径：{e}"))?;
    if roots
        .iter()
        .filter_map(|root| dunce::canonicalize(root).ok())
        .any(|root| target.starts_with(root))
    {
        Ok(target)
    } else {
        Err("只能打开已配置扫描根目录内的路径".into())
    }
}

pub fn task_reveal_path(task: &DownloadTask) -> Result<PathBuf, String> {
    use crate::models::TaskStatus;
    let saved = Path::new(&task.save_path);
    let partial = util::with_suffix(saved, ".part");
    let path = match task.status {
        TaskStatus::Completed => saved,
        TaskStatus::Error if !partial.try_exists().map_err(|e| e.to_string())? => saved,
        _ => &partial,
    };
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("无法定位下载文件：{e}"))?;
    if !path.is_absolute() || !metadata.is_file() {
        return Err("只能定位下载任务记录的普通文件".into());
    }
    dunce::canonicalize(path).map_err(|e| format!("无法解析下载文件：{e}"))
}

/// 扫描本地模型库（v0.2.0 支持多扫描根）。
///
/// - `roots` 按顺序扫描（调用方保证 downloadDir 在前），同一文件只保留首次出现；
/// - 每个文件通过 `rootDir` 记录其所属扫描根；
/// - `tasks` 用于把文件关联回下载历史（source/repoId）。
pub fn scan_library(roots: &[PathBuf], tasks: &[DownloadTask]) -> Vec<LocalFile> {
    let mut files = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for root in roots {
        if files.len() >= MAX_FILES {
            break;
        }
        if !root.is_dir() {
            continue;
        }
        walk(root, root, 0, &mut files, &mut seen, tasks, false);
    }
    files.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    files
}

/// 只收集下载残留的 `.part` 文件，不包含已完成模型和 `.part.json`。
pub fn scan_partials(roots: &[PathBuf], tasks: &[DownloadTask]) -> Vec<LocalFile> {
    let mut files = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for root in roots {
        if files.len() >= MAX_FILES {
            break;
        }
        if !root.is_dir() {
            continue;
        }
        walk(root, root, 0, &mut files, &mut seen, tasks, true);
    }
    files.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    files
}

fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<LocalFile>,
    seen: &mut HashSet<String>,
    tasks: &[DownloadTask],
    partials_only: bool,
) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 跳过符号链接/junction，避免循环与越界。
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if depth < MAX_DEPTH {
                walk(root, &entry.path(), depth + 1, out, seen, tasks, partials_only);
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_part = name.ends_with(".part") && !name.ends_with(".part.json");
        let is_temp = name.ends_with(".part") || name.ends_with(".part.json");
        if partials_only {
            if !is_part {
                continue;
            }
        } else if is_temp {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let path_buf = entry.path();
        // 同一文件可能同时落在 downloadDir 与附加根（嵌套根）→ 去重。
        let dedupe_key = path_buf
            .canonicalize()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path_buf.to_string_lossy().into_owned());
        if !seen.insert(dedupe_key) {
            continue;
        }
        let path = path_buf.to_string_lossy().into_owned();
        let history = tasks.iter().find(|task| {
            if partials_only {
                task.temp_path == path
            } else {
                task.save_path == path
            }
        });
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        out.push(LocalFile {
            path,
            kind: util::classify_file(&name),
            name,
            size: metadata.len(),
            modified_at,
            source: history.map(|task| task.source),
            repo_id: history.map(|task| task.repo_id.clone()),
            root_dir: root.to_string_lossy().into_owned(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Source, TaskStatus};

    fn unique_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mdm-library-test-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_task(save_path: &str) -> DownloadTask {
        DownloadTask {
            update_seq: 0,
            task_id: "t1".to_string(),
            source: Source::Huggingface,
            repo_id: "org/model".to_string(),
            remote_path: "a.safetensors".to_string(),
            file_name: "a.safetensors".to_string(),
            save_path: save_path.to_string(),
            temp_path: format!("{save_path}.part"),
            total_size: 5,
            downloaded: 5,
            status: TaskStatus::Completed,
            speed: 0,
            error: None,
            retries: 0,
            revision: "main".to_string(),
            added_at: 1,
            completed_at: Some(2),
            etag: None,
            last_modified: None,
            sha256: None,
            verify_status: crate::models::VerifyStatus::Unavailable,
        }
    }

    #[test]
    fn scans_nested_files_and_skips_temp_files() {
        let root = unique_dir("scan");
        std::fs::create_dir_all(root.join("sub").join("deep")).unwrap();
        std::fs::write(root.join("a.safetensors"), [1u8; 5]).unwrap();
        std::fs::write(root.join("sub").join("b.json"), b"{}").unwrap();
        std::fs::write(root.join("sub").join("deep").join("c.bin"), [2u8; 3]).unwrap();
        std::fs::write(root.join("partial.part"), [3u8; 3]).unwrap();
        std::fs::write(root.join("partial.part.json"), b"{}").unwrap();

        let tasks = vec![sample_task(&root.join("a.safetensors").to_string_lossy())];
        let files = scan_library(&[root.clone()], &tasks);
        assert_eq!(files.len(), 3, "应跳过 .part/.part.json");
        let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
        assert!(names.contains(&"a.safetensors"));
        assert!(names.contains(&"b.json"));
        assert!(names.contains(&"c.bin"));
        let serialized = files
            .iter()
            .find(|file| file.name == "a.safetensors")
            .unwrap();
        assert_eq!(serialized.kind, crate::models::FileKind::Weight);
        assert_eq!(serialized.source, Some(Source::Huggingface));
        assert_eq!(serialized.repo_id.as_deref(), Some("org/model"));
        assert_eq!(
            serialized.root_dir,
            root.to_string_lossy(),
            "rootDir 应为扫描根"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_partials_returns_only_part_files() {
        let root = unique_dir("partials");
        std::fs::write(root.join("done.safetensors"), [1u8; 4]).unwrap();
        std::fs::write(root.join("done.safetensors.part"), [2u8; 2]).unwrap();
        std::fs::write(root.join("done.safetensors.part.json"), b"{}").unwrap();
        let files = scan_partials(&[root.clone()], &[]);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "done.safetensors.part");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn respects_max_depth() {
        let root = unique_dir("depth");
        let mut current = root.clone();
        // d1..d8 内文件应被扫描到；d9 超出深度限制。
        for level in 1..=9 {
            current = current.join(format!("d{level}"));
            std::fs::create_dir_all(&current).unwrap();
            std::fs::write(current.join(format!("f{level}.bin")), [0u8; 1]).unwrap();
        }
        let files = scan_library(&[root.clone()], &[]);
        let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
        assert!(names.contains(&"f8.bin"), "深度 8 内文件应被扫描");
        assert!(!names.contains(&"f9.bin"), "超过最大深度应跳过");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scans_multiple_roots_and_reports_root_dir() {
        let root_a = unique_dir("root-a");
        let root_b = unique_dir("root-b");
        std::fs::write(root_a.join("from-a.safetensors"), [1u8; 3]).unwrap();
        std::fs::write(root_b.join("from-b.gguf"), [2u8; 4]).unwrap();
        std::fs::create_dir_all(root_b.join("nested")).unwrap();
        std::fs::write(root_b.join("nested").join("deep.bin"), [3u8; 5]).unwrap();

        let files = scan_library(&[root_a.clone(), root_b.clone()], &[]);
        assert_eq!(files.len(), 3, "应扫描多个根");
        let from_a = files
            .iter()
            .find(|file| file.name == "from-a.safetensors")
            .unwrap();
        assert_eq!(from_a.root_dir, root_a.to_string_lossy());
        let from_b = files
            .iter()
            .find(|file| file.name == "from-b.gguf")
            .unwrap();
        assert_eq!(from_b.root_dir, root_b.to_string_lossy());
        assert!(files.iter().any(|file| file.name == "deep.bin"));

        // 嵌套根（root_a 包含文件，root_a 作为第二个根重复扫描）→ 去重。
        let deduped = scan_library(&[root_a.clone(), root_a.clone()], &[]);
        assert_eq!(deduped.len(), 1, "同一路径不得重复");
        let _ = std::fs::remove_dir_all(&root_a);
        let _ = std::fs::remove_dir_all(&root_b);
    }

    #[test]
    fn allows_paths_inside_a_configured_root() {
        let root = unique_dir("in");
        let inside = root.join("model.bin");
        std::fs::write(&inside, b"x").unwrap();
        assert!(resolve_scan_path(&inside, std::slice::from_ref(&root)).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_paths_outside_all_roots() {
        let root = unique_dir("root");
        let other = unique_dir("other");
        let outside = other.join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert!(resolve_scan_path(&outside, std::slice::from_ref(&root)).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn rejects_sibling_directory_sharing_a_name_prefix() {
        // `root` 与 `root-evil` 字符串前缀相同，但不是父子关系，必须拒绝。
        let root = unique_dir("pfx");
        let evil = PathBuf::from(format!("{}-evil", root.display()));
        std::fs::create_dir_all(&evil).unwrap();
        let file = evil.join("x.bin");
        std::fs::write(&file, b"x").unwrap();
        assert!(resolve_scan_path(&file, std::slice::from_ref(&root)).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&evil);
    }

    #[test]
    fn unresolvable_root_is_skipped_not_trusted() {
        let root = unique_dir("ok");
        let file = root.join("a.bin");
        std::fs::write(&file, b"x").unwrap();
        let missing = root.join("not-created");
        assert!(resolve_scan_path(&file, &[missing.clone(), root.clone()]).is_ok());
        assert!(resolve_scan_path(&file, std::slice::from_ref(&missing)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reveals_only_the_selected_task_file_in_a_custom_directory() {
        let dir = unique_dir("custom");
        let path = dir.join("模型, example.gguf");
        let mut task = sample_task(path.to_str().unwrap());
        let partial = util::with_suffix(&path, ".part");
        std::fs::write(&partial, b"a").unwrap();
        task.status = TaskStatus::Paused;
        assert_eq!(
            task_reveal_path(&task).unwrap(),
            dunce::canonicalize(&partial).unwrap()
        );
        std::fs::rename(&partial, &path).unwrap();
        for status in [TaskStatus::Completed, TaskStatus::Error] {
            task.status = status;
            assert_eq!(
                task_reveal_path(&task).unwrap(),
                dunce::canonicalize(&path).unwrap()
            );
        }
        assert!(resolve_scan_path(&path, &[]).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
