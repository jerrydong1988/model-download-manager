//! 后端入口：模块声明与应用入口（见 `docs/ARCHITECTURE.md` / `docs/IPC-CONTRACT.md`）。
//!
//! v0.1.3 起的桌面运行层（单实例 / 系统通知 / 托盘 / 窗口关闭策略）位于 `desktop` 模块，
//! 且仅在非单元测试构建中编译：test harness 没有 tauri-build 生成的 Windows manifest，
//! 链接 tray/menu 代码会导入 comctl32 v6 专有导出导致 loader 失败（STATUS_ENTRYPOINT_NOT_FOUND）。

pub mod download;
pub mod library;
pub mod models;
pub mod notifications;
pub mod queue;
pub mod settings;
pub mod sources;
pub mod state;
pub mod util;

// v0.2.0 多连接分段下载引擎（不依赖 Tauri；单元/集成测试直接覆盖）。
mod segmented;

// 命令层与桌面运行层依赖 tauri 的 AppHandle/State 及托盘/菜单代码，仅非单元测试构建编译。
// 原因：lib unit-test harness 没有 tauri-build 生成的 Windows manifest；链接 tray/menu 代码
// 会导入 comctl32 v6 专有导出（TaskDialogIndirect 等），导致 test 进程 loader 失败。
#[cfg(not(test))]
pub mod commands;

#[cfg(not(test))]
mod desktop;

#[cfg(not(test))]
pub use desktop::run;
