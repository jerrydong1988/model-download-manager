//! v0.1.3 系统通知：任务终态（completed / error）时按 `notificationsEnabled` 发送。
//!
//! - 契约：completed → 「下载完成：{fileName}」；error → 「下载失败：{fileName}」+ 简短错误；
//! - 发送失败不阻断下载队列，只 `eprintln!` 一行（包含 "notification" 便于 QA grep）；
//! - 通知正文统一做 URL 脱敏（只留 scheme+host+path），不得包含 token/预签名参数。
//!
//! 平台发送函数仅在非单元测试构建编译（test harness 不链接 tauri 通知栈）；
//! `completed_body` / `failed_body` 为纯函数，单元测试直接覆盖。

#[cfg(not(test))]
use tauri::AppHandle;
#[cfg(not(test))]
use tauri_plugin_notification::NotificationExt;

use crate::models::DownloadTask;
use crate::util;

/// 通知正文最大字符数（超出截断并加省略号）。
const MAX_BODY_CHARS: usize = 200;

/// 完成通知正文。
pub fn completed_body(task: &DownloadTask) -> String {
    util::redact_urls(&format!("下载完成：{}", task.file_name))
}

/// 失败通知正文（含简短错误，已脱敏）。
pub fn failed_body(task: &DownloadTask, error: &str) -> String {
    util::redact_urls(&format!(
        "下载失败：{}\n{}",
        task.file_name,
        shorten(error, MAX_BODY_CHARS)
    ))
}

/// 发送「下载完成」通知。
#[cfg(not(test))]
pub fn notify_completed(app: &AppHandle, task: &DownloadTask) {
    notify(app, &completed_body(task));
}

/// 发送「下载失败」通知。
#[cfg(not(test))]
pub fn notify_failed(app: &AppHandle, task: &DownloadTask, error: &str) {
    notify(app, &failed_body(task, error));
}

#[cfg(not(test))]
fn notify(app: &AppHandle, body: &str) {
    if let Err(err) = app
        .notification()
        .builder()
        .title("模型下载管理器")
        .body(body)
        .show()
    {
        // QA 可通过 grep "notification" 定位通知失败（不阻断队列）。
        eprintln!("notification 发送失败：{err}");
    }
}

fn shorten(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let shortened: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{shortened}…")
    } else {
        shortened
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Source;

    fn sample_task() -> DownloadTask {
        DownloadTask {
            update_seq: 0,
            task_id: "t1".to_string(),
            source: Source::Huggingface,
            repo_id: "org/model".to_string(),
            remote_path: "model.safetensors".to_string(),
            file_name: "model.safetensors".to_string(),
            save_path: "C:\\Models\\org\\model\\model.safetensors".to_string(),
            temp_path: "C:\\Models\\org\\model\\model.safetensors.part".to_string(),
            total_size: 100,
            downloaded: 100,
            status: crate::models::TaskStatus::Completed,
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
    fn completed_notification_body_matches_contract() {
        let body = completed_body(&sample_task());
        assert_eq!(body, "下载完成：model.safetensors");
    }

    #[test]
    fn failed_notification_body_redacts_urls() {
        let body = failed_body(
            &sample_task(),
            "网络请求失败（https://cdn.example.com/f.bin?token=secret&X-Amz-Signature=abc）",
        );
        assert!(body.starts_with("下载失败：model.safetensors"));
        assert!(body.contains("https://cdn.example.com/f.bin"));
        assert!(!body.contains("secret"), "通知不得泄漏 token：{body}");
        assert!(!body.contains("X-Amz-Signature"));
    }

    #[test]
    fn failed_notification_body_is_truncated() {
        let long_error = "错".repeat(1000);
        let body = failed_body(&sample_task(), &long_error);
        // 前缀「下载失败：model.safetensors\n」+ 200 字符 + 省略号。
        assert!(
            body.chars().count() <= "下载失败：model.safetensors\n".chars().count() + 201,
            "正文应截断，实际长度 {}",
            body.chars().count()
        );
        assert!(body.ends_with('…'));
    }
}
