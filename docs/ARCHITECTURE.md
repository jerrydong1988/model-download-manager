# 架构与协作规范

## 1. 项目定位

**Model Download Manager（模型下载管理器）**：独立桌面工具，用于浏览 ModelScope /
HuggingFace 仓库并下载模型权重文件。Tauri 2 + React 18 + TypeScript + Tailwind，
Windows 优先，中文界面。

参考实现：`llama-server-manager`（下载模块是其中的子功能，
本工具只借用其下载引擎/仓库浏览的设计思路与关键实现，不复制其应用业务逻辑）。

## 2. 目录结构与所有权（写域）

```
Model Download Manager/
├── package.json / vite.config.ts / tsconfig*.json / index.html / tailwind.config.js
├── docs/
│   ├── IPC-CONTRACT.md        # 契约（Lead 维护，唯一事实来源）
│   ├── ARCHITECTURE.md        # 本文件
│   └── api-contracts.md       # researcher 实测的第三方 API 契约
├── scripts/                   # 探测脚本、图标生成
├── src/                       # 【frontend-app】前端
│   ├── main.tsx / App.tsx / styles.css
│   ├── types.ts               # 契约镜像（与 IPC-CONTRACT.md 一致）
│   ├── lib/ipc.ts             # invoke 封装 + mock 分流
│   ├── lib/format.ts          # 字节/速度/时间格式化
│   ├── store/                 # zustand store
│   ├── components/            # 布局、通用 UI
│   ├── pages/                 # Browse / Downloads / Library / Settings
│   └── mocks/                 # 浏览器 mock（Playwright 视觉验证用）
├── src-tauri/                 # 【backend-engine】Rust 后端
│   ├── Cargo.toml / build.rs / tauri.conf.json / capabilities/
│   ├── icons/                 # Lead 已生成
│   └── src/
│       ├── main.rs
│       ├── lib.rs             # run()、setup、命令注册、状态初始化
│       ├── models.rs          # 契约类型
│       ├── settings.rs        # 设置读写/钳制/默认值
│       ├── state.rs           # AppState、任务存储、控制标志、调度通知
│       ├── sources/
│       │   ├── mod.rs         # Source、URL 模板、共享分页
│       │   ├── huggingface.rs # 搜索/文件树/详情
│       │   └── modelscope.rs  # 搜索/文件列表/详情
│       ├── download.rs        # 单文件传输引擎（Range/重试/限速/进度）
│       ├── queue.rs           # 调度泵、并发控制、持久化、恢复
│       ├── library.rs         # 本地库扫描
│       ├── commands.rs        # #[tauri::command] 薄封装
│       └── util.rs            # 路径净化、原子写、事件、资源管理器
└── README.md                  # 使用/构建说明（Lead 收尾）
```

写域（并发修改时不得越界）：

| 成员 | 写域 |
|------|------|
| Lead | 根配置、`docs/IPC-CONTRACT.md`、`docs/ARCHITECTURE.md`、`scripts/`、`README.md`、最终集成修复 |
| backend-engine | `src-tauri/src/**`、`src-tauri/Cargo.toml`、`src-tauri/examples/**`（可加依赖，需在报告中说明） |
| frontend-app | `src/**`、`index.html` |
| api-researcher | `docs/api-contracts.md`、`scripts/probe-*` |
| qa-integration | `docs/QA-REPORT.md`、`tests/e2e/**`（只读源码，除非经 Lead 协调修复） |

## 3. 后端分层（可测试性是硬要求）

```
commands.rs        —— 只做参数校验、状态读写、返回/错误映射（薄）
    ↓
sources/*.rs       —— 纯异步函数，签名形如
                       pub async fn search(client: &reqwest::Client, settings: &Settings, q: &SearchQuery) -> Result<RepoSearchPage, String>
                       不依赖 tauri::AppHandle，可被测试/example 直接调用
queue.rs           —— 调度：任务状态机、并发槽、持久化、恢复
    ↓
download.rs        —— 纯传输引擎：
                       pub async fn transfer(ctx: TransferContext, sink: &dyn EventSink) -> Result<TransferOutcome, DownloadError>
                       使用 EventSink trait 发事件（AppHandle 实现 + 测试用 RecordingSink）
util.rs / settings.rs / models.rs —— 无状态工具与类型
```

硬性要求：
1. `sources`、`download`、`settings`、`util` 模块**不得**依赖 `tauri::AppHandle`（`EventSink` 抽象除外）。
2. 事件通过 `pub trait EventSink: Send + Sync { fn emit(&self, event: &str, payload: serde_json::Value); }` 发出；
   `AppHandleSink` 实现该 trait，`commands` 负责构造。
3. 所有用户可见错误为中文 `Result<_, String>`；内部错误类型可实现 `std::fmt::Display`。
4. 单元测试（`cargo test`，不联网）必须覆盖：
   - 路径净化/拒绝 `..`、盘符、UNC、符号链接
   - `Content-Range` 解析、206/200/416 分支
   - 重试判定（可重试 vs 不可重试状态码）
   - 令牌桶：预算不足时等待、恢复后继续、0 = 不限
   - 文件名/仓库路径净化、分类函数
   - 队列状态机：暂停/取消/恢复/终态删除
5. 本地 mock HTTP server（tokio TcpListener）集成测试必须覆盖：
   - 中途断开 → 续传（Range 起点正确，最终内容与源一致）
   - 416 且 total == part 长度 → 直接完成
   - 5xx → 重试次数用尽后 error
   - 暂停 → part 保留，resume 后内容完整
6. `cargo test` 必须全绿；`cargo build` 必须成功。

## 4. 前端分层

- `types.ts`：契约镜像类型（camelCase）。
- `lib/ipc.ts`：唯一 IPC 出口。
  - `invokeCmd<T>(name, args)`：`@tauri-apps/api/core` 的 `invoke` 包装。
  - mock 分流：当 `import.meta.env.VITE_MOCK === '1'` 或 URL 含 `?mock=1` 时使用 `src/mocks/`，
    返回 fixtures 并模拟 `download-progress`/`task-updated` 推送。**Tauri 生产环境不得走 mock。**
  - `subscribeTasks(handlers)`：封装 `listen`，返回取消订阅函数；mock 模式用定时器模拟。
- `store/appStore.ts`：zustand，持有 tasks（按 taskId 索引 + 有序数组）、settings、snapshot 加载态、
  事件订阅注册。任务事件必须幂等合并。
- 页面：Browse / Downloads / Library / Settings；侧边栏导航 + 顶栏；全部中文文案。
- UX 要求：空状态、加载骨架、错误条（可重试）、操作确认（删除文件）、
  键盘可达、焦点态、禁用态；列表大数据量用窗口化或分块渲染（≥500 文件时不能卡）。
- 视觉：现代桌面工具风格，浅色主题，品牌蓝 `#2563eb`，中文字体栈已在 tailwind 配置。
  使用 lucide-react 图标；不要引入其他 UI 组件库。
- 验收命令：`npm run check:types` 与 `npm run build` 必须通过。

## 5. 参考代码索引（只读）

`llama-server-manager`：

| 主题 | 位置 |
|------|------|
| 限速/并发 | `src-tauri/src/commands/download.rs` 行 135–285 |
| 路径净化 | 同上 285–372；`download_directory.rs` |
| Range/Content-Range/416 | 同上 414–530 |
| 单文件下载主循环（断点续传/重试/进度/暂停） | 同上 994–2016 |
| ModelScope 浏览 | 同上 2026–2092 |
| HuggingFace 文件树（Link 分页） | 同上 2311–2395 |
| 进度事件 payload | 同上 1730–1830 |
| 队列持久化/崩溃恢复 | 同上 2551–2900、3594–3745 |
| 前端下载控制器 | `src/components/DownloadManager.tsx`、`src/components/DownloadManager/*`、`src/store/downloadSlice.ts` |
| 前端类型 | `src/store/types.ts` |

注意：参考实现是 llama.cpp 管理器，**只保留 gguf 等少数扩展名**；本工具必须展示
safetensors/bin/pt/onnx 等全部权重文件（分类规则见契约）。

## 6. 构建与验证

```powershell
# 前端
npm run check:types
npm run build

# 后端（首次编译约 3-6 分钟）
cd src-tauri; cargo check; cargo test; cargo build

# 视觉验证（mock 模式，无需后端）
npm run dev   # 然后打开 http://localhost:1420/?mock=1

# 完整应用
npm run tauri:dev
npm run tauri:build     # 产出 NSIS 安装包（较长）
```

## 7. 协作规则

1. 先读 `docs/IPC-CONTRACT.md`，再写代码；契约有歧义/需变更 → 先 `send_message` 给 Lead。
2. 只改自己的写域；跨域需求发给 Lead 协调。
3. 每个里程碑（骨架可编译 → 首个功能跑通 → 全部功能 → 测试全绿）通过 `send_message` 向 Lead 报告，
   附：完成项、验证命令与结果、遗留问题、下一步。
4. 声称「完成」必须附实际执行的命令与输出摘要；不得只描述未验证的改动。
5. 遇到 10 分钟无进展的阻塞（依赖编译、网络、API 不明确），立即上报 Lead。
6. 不要并行运行多个 `cargo build`/`cargo test`（共享 target 锁会互相等待）；需要时先给 Lead 打招呼。
