//! v0.5.0 在线升级：基于 tauri-plugin-updater 的检查 / 下载安装。
//!
//! 与 `desktop` 模块同理，仅在非单元测试构建中编译（依赖 tauri AppHandle 与插件 API）。
//! - 命令：`check_update`（检查并缓存待装更新）、`install_update`（下载并安装，进度走
//!   `update-progress` 事件，完成发 `update-installed`）。重启走前端 `ipc.restartApp()`
//!   （process 插件的 restart 只经 IPC 暴露，需要 capabilities 的 process:allow-restart）。
//! - 启动自动检查：`desktop.rs` 按设置 `autoCheckUpdates` 调用 [`spawn_auto_check`]，
//!   发现新版发 `update-available` 事件并缓存，供设置页一键更新。
//! - 更新源：默认 tauri.conf.json 内置 GitHub Releases latest.json；设置页
//!   `updateEndpoint` 非空时覆盖为镜像端点（校验在 settings.rs 完成，此处假定已规范化）。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::models::{Settings, UpdateInfo};
use crate::state::AppState;

/// 待安装更新：检查（手动或自动）写入，`install_update` 取出。
#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
}

fn take_pending(updates: &UpdateState) -> Option<Update> {
    updates
        .pending
        .lock()
        .expect("updater pending 锁中毒")
        .take()
}

fn store_pending(updates: &UpdateState, update: Option<Update>) {
    *updates.pending.lock().expect("updater pending 锁中毒") = update;
}

/// 构建更新器：`updateEndpoint` 非空时覆盖内置端点。
fn build_updater(app: &AppHandle, settings: &Settings) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    if !settings.update_endpoint.is_empty() {
        let url = url::Url::parse(&settings.update_endpoint)
            .map_err(|error| format!("更新源地址无效：{error}"))?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|error| format!("更新源地址无效：{error}"))?;
    }
    builder
        .build()
        .map_err(|error| format!("初始化更新器失败：{error}"))
}

fn info_of(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    }
}

/// 检查更新。返回 `Some(UpdateInfo)` 表示有新版并已缓存待装；`None` 表示已是最新。
#[tauri::command(rename_all = "camelCase")]
pub async fn check_update(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    updates: tauri::State<'_, Arc<UpdateState>>,
) -> Result<Option<UpdateInfo>, String> {
    let settings = state.current_settings();
    let updater = build_updater(&app, &settings)?;
    match updater.check().await {
        Ok(Some(update)) => {
            let info = info_of(&update);
            store_pending(&updates, Some(update));
            Ok(Some(info))
        }
        Ok(None) => {
            store_pending(&updates, None);
            Ok(None)
        }
        Err(error) => Err(format!("检查更新失败：{error}")),
    }
}

/// 下载并安装已缓存的新版本；下载进度经 `update-progress` 事件上报（节流 ~200ms，
/// total 在响应头到达前为 null）。Windows 上安装程序接管退出旧实例，
/// 若旧进程已退出则 `update-installed` 可能收不到，属正常。
#[tauri::command(rename_all = "camelCase")]
pub async fn install_update(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    updates: tauri::State<'_, Arc<UpdateState>>,
) -> Result<(), String> {
    let update = take_pending(&updates).ok_or("没有待安装的更新，请先检查更新")?;
    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let bytes = update
        .download(
            move |chunk_length, total| {
                downloaded += chunk_length as u64;
                let now = Instant::now();
                let finished = total.map(|t| downloaded >= t).unwrap_or(false);
                if finished || now.duration_since(last_emit) >= Duration::from_millis(200) {
                    last_emit = now;
                    let _ = progress_app.emit(
                        "update-progress",
                        serde_json::json!({ "downloaded": downloaded, "total": total }),
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|error| format!("下载更新失败：{error}"))?;
    // Windows exits inside install(). Persist active/paused intent before handing off.
    state.persist_tasks().map_err(|error| format!("保存下载队列失败，升级已中止：{error}"))?;
    update.install(bytes).map_err(|error| format!("安装更新失败：{error}"))?;
    let _ = app.emit("update-installed", serde_json::json!({}));
    Ok(())
}

/// 启动自动检查：延迟数秒后检查一次；发现新版缓存并 emit `update-available`；失败静默。
pub fn spawn_auto_check(app: AppHandle, state: Arc<AppState>, updates: Arc<UpdateState>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        let settings = state.current_settings();
        let Ok(updater) = build_updater(&app, &settings) else {
            return;
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let info = info_of(&update);
                store_pending(&updates, Some(update));
                let _ = app.emit("update-available", &info);
            }
            Ok(None) => {}
            Err(error) => eprintln!("自动检查更新失败（已忽略）：{error}"),
        }
    });
}
