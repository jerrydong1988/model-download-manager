//! 桌面运行层（v0.1.3）：单实例、系统通知、托盘、窗口关闭策略与后台运行。
//!
//! 仅在非单元测试构建中编译：
//! - 单元测试（`cargo test --lib`）不需要窗口/托盘，且 test harness 没有 tauri-build
//!   为可执行文件生成的 manifest；若链接 tray/menu 代码会导入 comctl32 v6 专有导出
//!   （如 `TaskDialogIndirect`），导致 test 进程在 loader 阶段报 STATUS_ENTRYPOINT_NOT_FOUND。
//! - 集成测试/正式应用构建仍会编译本模块。

use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::state::AppState;
use crate::util::AppHandleSink;
use crate::{commands, queue, settings, state, updater};

const TRAY_ID: &str = "main-tray";
const MAIN_WINDOW: &str = "main";

/// 应用入口，由 `main.rs` 调用。
pub fn run() {
    tauri::Builder::default()
        // 单实例插件必须最先注册：第二次启动时只聚焦已有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                handle_close_requested(window, api);
            }
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let settings = settings::load(&data_dir);
            let state = Arc::new(state::AppState::new(settings, data_dir));

            let report_state = state.clone();
            let app_handle = app.handle().clone();
            state.set_verify_report(Arc::new(move |task, notify_success| {
                let sink = crate::util::AppHandleSink::new(app_handle.clone());
                crate::util::emit_task_updated(&sink, task);
                let outcome = if task.status == crate::models::TaskStatus::Error {
                    crate::batch_notice::BatchOutcome::Failure(
                        task.error.clone().unwrap_or_default(),
                    )
                } else if notify_success
                    && task.verify_status == crate::models::VerifyStatus::Verified
                {
                    crate::batch_notice::BatchOutcome::Success
                } else {
                    crate::batch_notice::BatchOutcome::Observe
                };
                let Some(body) = report_state.take_batch_notice(task, outcome) else {
                    return;
                };
                if report_state.current_settings().notifications_enabled {
                    crate::notifications::notify_body(&app_handle, &body);
                }
            }));
            queue::recover(&state)?;
            app.manage(state.clone());

            // v0.5.0：在线升级。待装更新缓存独立管理；autoCheckUpdates 默认开，
            // 启动延迟自动检查一次，失败静默（见 updater::spawn_auto_check）。
            let update_state = std::sync::Arc::new(updater::UpdateState::default());
            app.manage(update_state.clone());
            if state.current_settings().auto_check_updates {
                updater::spawn_auto_check(app.handle().clone(), state.clone(), update_state);
            }

            // 调度泵：autoResume 时自动继续 queued 任务。
            queue::spawn_pump(app.handle().clone(), state);

            // v0.2.0：通知点击跳转。必须尽早注册：插件只有在存在 handler 时才以
            // tracked 模式展示通知（Windows 上 toast 在屏期间点击会上报 action）。
            if let Err(err) = app.notification().on_action({
                let handle = app.handle().clone();
                move |action: &tauri_plugin_notification::ActionPerformed| {
                    if action.action_id() == "tap" {
                        show_main_window(&handle);
                    }
                }
            }) {
                eprintln!("notification-click handler 注册失败：{err}");
            }

            // v0.1.3 托盘：创建失败只记录，不阻塞应用启动（交由 QA 真机诊断）。
            if let Err(err) = setup_tray(app.handle()) {
                eprintln!("托盘初始化失败：{err}");
            }
            update_tray_tooltip(app.handle());
            spawn_tray_tooltip_refresh(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::search_repos,
            commands::get_repo_detail,
            commands::start_downloads,
            commands::pause_download,
            commands::resume_download,
            commands::pause_all,
            commands::resume_all,
            commands::cancel_download,
            commands::retry_download,
            commands::remove_tasks,
            commands::clear_finished,
            commands::get_settings,
            commands::save_settings,
            commands::scan_library,
            commands::list_partials,
            commands::open_path,
            commands::delete_local_file,
            commands::test_connection,
            commands::list_revisions,
            commands::get_default_download_dir,
            commands::open_data_dir,
            commands::disk_space,
            updater::check_update,
            updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// 窗口显示 / 关闭策略
// ---------------------------------------------------------------------------

/// 显示、还原并聚焦主窗口（托盘左键、单实例二次启动、托盘菜单共用）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 关闭主窗口：`closeToTray=true` → 隐藏到托盘继续下载；否则暂停全部、落盘并退出。
fn handle_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let app = window.app_handle();
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let settings = state.current_settings();
    if settings.close_to_tray {
        // 注意：窗口是 hide 而非 destroy，WebView 与下载任务继续运行。
        api.prevent_close();
        if let Err(err) = window.hide() {
            eprintln!("隐藏主窗口失败：{err}");
        }
        if let Err(err) = app.emit("window-hidden-to-tray", serde_json::json!({})) {
            eprintln!("发送 window-hidden-to-tray 事件失败：{err}");
        }
    } else {
        // 真正退出：先暂停全部 + 立即落盘，确保任务状态不丢。
        pause_all_and_persist(app, &state);
        api.prevent_close();
        app.exit(0);
    }
}

/// 暂停全部任务并立即持久化（退出前调用）。
fn pause_all_and_persist(app: &tauri::AppHandle, state: &Arc<AppState>) {
    let sink = AppHandleSink::new(app.clone());
    queue::pause_all(state, &sink);
    if let Err(err) = state.persist_tasks() {
        eprintln!("退出前保存任务列表失败：{err}");
    }
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

/// 创建托盘图标与右键菜单（左键单击显示主窗口）。
fn setup_tray(app: &tauri::AppHandle) -> Result<(), String> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败：{err}"))?;
    let pause_item = MenuItem::with_id(app, "pause_all", "暂停全部", true, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败：{err}"))?;
    let resume_item = MenuItem::with_id(app, "resume_all", "继续全部", true, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败：{err}"))?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败：{err}"))?;
    let menu = Menu::with_items(app, &[&show_item, &pause_item, &resume_item, &quit_item])
        .map_err(|err| format!("创建托盘菜单失败：{err}"))?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .map_err(|err| format!("加载托盘图标失败：{err}"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("模型下载管理器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_tray_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|err| format!("创建托盘图标失败：{err}"))?;
    Ok(())
}

/// 托盘右键菜单动作。
fn handle_tray_menu(app: &tauri::AppHandle, menu_id: &str) {
    match menu_id {
        "show" => show_main_window(app),
        "pause_all" => {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                let sink = AppHandleSink::new(app.clone());
                queue::pause_all(&state, &sink);
            }
        }
        "resume_all" => {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                let sink = AppHandleSink::new(app.clone());
                queue::resume_all(&state, &sink);
            }
        }
        "quit" => {
            // 退出前暂停全部 + 落盘，确保状态不丢。
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                pause_all_and_persist(app, &state);
            }
            app.exit(0);
        }
        _ => {}
    }
}

/// 刷新托盘 tooltip：无运行任务「模型下载管理器」，否则「… · N 个任务下载中」。
fn update_tray_tooltip(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let running = state
        .tasks_snapshot()
        .iter()
        .filter(|task| task.status.is_running())
        .count();
    let tooltip = if running == 0 {
        "模型下载管理器".to_string()
    } else {
        format!("模型下载管理器 · {running} 个任务下载中")
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Err(err) = tray.set_tooltip(Some(tooltip.as_str())) {
            eprintln!("更新托盘 tooltip 失败：{err}");
        }
    }
}

/// 每 3 秒刷新一次托盘 tooltip（任务状态变化后最迟 3 秒可见）。
fn spawn_tray_tooltip_refresh(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            update_tray_tooltip(&app);
        }
    });
}
