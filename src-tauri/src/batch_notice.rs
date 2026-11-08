//! 同一仓库的完成/失败通知合并成一条。
//!
//! 批次键是来源 + 仓库 + revision。只要这批里还有排队、下载、暂停或等待校验的任务，
//! 就不发通知；全部结束后再发「成功 N，失败 M」。单个文件仍沿用原来的完成/失败文案。

use std::collections::HashMap;

use crate::models::{DownloadTask, Source, TaskStatus, VerifyStatus};
use crate::notifications::{completed_text, failure_text};

#[derive(Clone)]
struct Notice {
    file_name: String,
    error: Option<String>,
}

#[derive(Default)]
pub struct BatchLedger {
    pending: HashMap<String, Vec<Notice>>,
}

/// 这次状态变化要不要记入成功或失败。
#[derive(Clone)]
pub enum BatchOutcome {
    Success,
    Failure(String),
    /// 批次有任务结束，但这次不计入成功/失败，例如取消。
    Observe,
}

pub fn batch_key(task: &DownloadTask) -> String {
    let source = match task.source {
        Source::Huggingface => "huggingface",
        Source::Modelscope => "modelscope",
    };
    format!("{source}|{}|{}", task.repo_id, task.revision)
}

/// 排队、下载中、暂停，以及已完成但还在校验的任务，都表示这批还没结束。
pub fn is_batch_settled(task: &DownloadTask) -> bool {
    match task.status {
        TaskStatus::Queued | TaskStatus::Active | TaskStatus::Pausing | TaskStatus::Paused => false,
        TaskStatus::Completed => task.verify_status != VerifyStatus::Pending,
        TaskStatus::Error | TaskStatus::Cancelled => true,
    }
}

impl BatchLedger {
    /// 记录一次终态。若同批任务都已结束，返回要发送的通知正文。
    pub fn note(
        &mut self,
        tasks: &[DownloadTask],
        task: &DownloadTask,
        outcome: BatchOutcome,
    ) -> Option<String> {
        let key = batch_key(task);
        match outcome {
            BatchOutcome::Success => {
                self.pending.entry(key.clone()).or_default().push(Notice {
                    file_name: task.file_name.clone(),
                    error: None,
                });
            }
            BatchOutcome::Failure(error) => {
                self.pending.entry(key.clone()).or_default().push(Notice {
                    file_name: task.file_name.clone(),
                    error: Some(error),
                });
            }
            BatchOutcome::Observe => {}
        }
        let waiting = tasks
            .iter()
            .any(|item| batch_key(item) == key && !is_batch_settled(item));
        if waiting {
            return None;
        }
        let notes = self.pending.remove(&key).unwrap_or_default();
        summary_body(&task.repo_id, &notes)
    }
}

fn summary_body(repo_id: &str, notes: &[Notice]) -> Option<String> {
    let succeeded = notes.iter().filter(|note| note.error.is_none()).count();
    let failed: Vec<&Notice> = notes.iter().filter(|note| note.error.is_some()).collect();
    if succeeded == 0 && failed.is_empty() {
        return None;
    }
    if succeeded == 1 && failed.is_empty() {
        return Some(completed_text(&notes[0].file_name));
    }
    if succeeded == 0 && failed.len() == 1 {
        let error = failed[0].error.as_deref().unwrap_or("");
        return Some(failure_text(&failed[0].file_name, error));
    }
    Some(format!(
        "{repo_id}：成功 {succeeded}，失败 {}",
        failed.len()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(name: &str, status: TaskStatus, verify: VerifyStatus) -> DownloadTask {
        DownloadTask {
            update_seq: 0,
            task_id: name.to_string(),
            source: Source::Huggingface,
            repo_id: "org/model".to_string(),
            remote_path: name.to_string(),
            file_name: name.to_string(),
            save_path: format!("D:/Models/{name}"),
            temp_path: format!("D:/Models/{name}.part"),
            total_size: 1,
            downloaded: 1,
            status,
            speed: 0,
            error: None,
            retries: 0,
            revision: "main".to_string(),
            added_at: 1,
            completed_at: None,
            etag: None,
            last_modified: None,
            sha256: None,
            verify_status: verify,
        }
    }

    #[test]
    fn waits_until_every_file_in_the_repo_is_settled() {
        let mut ledger = BatchLedger::default();
        let active = task("a.bin", TaskStatus::Active, VerifyStatus::Unavailable);
        let done = task("b.bin", TaskStatus::Completed, VerifyStatus::Unavailable);
        let first = ledger.note(
            &[active.clone(), done.clone()],
            &done,
            BatchOutcome::Success,
        );
        assert!(first.is_none(), "还有文件在下载时不发通知");

        let settled_active = task("a.bin", TaskStatus::Completed, VerifyStatus::Unavailable);
        let second = ledger
            .note(
                &[settled_active, done],
                &task("a.bin", TaskStatus::Completed, VerifyStatus::Unavailable),
                BatchOutcome::Success,
            )
            .expect("整批结束后要有一条通知");
        assert_eq!(second, "org/model：成功 2，失败 0");
    }

    #[test]
    fn single_file_keeps_the_original_wording() {
        let mut ledger = BatchLedger::default();
        let done = task("model.safetensors", TaskStatus::Completed, VerifyStatus::Unavailable);
        let body = ledger
            .note(&[done.clone()], &done, BatchOutcome::Success)
            .expect("单文件应立即通知");
        assert_eq!(body, "下载完成：model.safetensors");
    }

    #[test]
    fn pending_verify_holds_the_summary() {
        let mut ledger = BatchLedger::default();
        let verifying = task("a.bin", TaskStatus::Completed, VerifyStatus::Pending);
        let done = task("b.bin", TaskStatus::Completed, VerifyStatus::Verified);
        let held = ledger.note(&[verifying.clone(), done.clone()], &done, BatchOutcome::Success);
        assert!(held.is_none());
        let verified = task("a.bin", TaskStatus::Error, VerifyStatus::Mismatch);
        let body = ledger
            .note(
                &[verified.clone(), done],
                &verified,
                BatchOutcome::Failure("校验不一致".to_string()),
            )
            .expect("校验结束后汇总");
        assert_eq!(body, "org/model：成功 1，失败 1");
    }
}
