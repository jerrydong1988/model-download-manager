# 后端独立审查报告（BACKEND-REVIEW）

> 审查者：backend-engine（独立只读审查，按 Lead 裁决不改 `src-tauri/src/**`）
> 审查时间：2026-11-03 19:03–19:35（+08:00）
> 审查对象：`src-tauri/src/**`（模型 mtime 19:03:05 的快照）、`src-tauri/Cargo.toml`、`src-tauri/tests/download_mock.rs`
> 依据：`docs/IPC-CONTRACT.md`（19:04 版）、`docs/ARCHITECTURE.md`、`docs/api-contracts.md`（19:02 版）
> 方法：全量静态代码审查 + 前后端契约逐项比对 + 独立复跑 `cargo test` / `cargo build`（未修改任何后端代码）
> 写域：仅本文件。发现的问题不在此修复，由 Lead 分派 backend-rust。

## 0. 结论摘要

| 项 | 结论 |
|----|------|
| 独立复跑 `cargo test` | **通过**：32 unit + 7 integration = 39 个测试全绿，exit 0 |
| 独立复跑 `cargo build` | **通过**：`Finished dev profile ... exit 0`；`target/debug/model-download-manager.exe` 已生成 |
| P0（阻断交付） | **0 条** |
| P1（应修，用户可感知/数据完整性） | **3 条**（#1 队列竞态卡死、#2 retries 字段永不更新、#3 stale part 被当成完成） |
| P2（建议修/文档同步） | 20 条（见 §4） |
| 契约一致性 | 类型/命令/事件**全部一致**；仅 2 处注释/文档表述需同步（非代码缺陷） |
| 安全（token 泄露） | 未发现 token 泄露；有 1 条 P2 建议对 error 文本中的 CDN 预签名 URL query 脱敏 |

**总体判断**：这份后端质量高于“脚手架”预期，架构分层、EventSink 抽象、Range/重试/限速/暂停语义、错误中文化、路径净化都基本符合契约，39 个测试有真实断言且覆盖了架构要求的 mock server 场景。当前无阻断级缺陷。建议 Lead 优先安排 #1（队列状态机 CAS）与 #2（retries）的修复，#3 视排期。

---

## 1. 验证执行证据

### 1.1 `cargo test`（独立执行，19:10 左右）

```text
cd src-tauri; cargo test
    Finished `test` profile [unoptimized + debuginfo] target(s) in 7.23s
running 32 tests ...（download 4 / sources-hf 5 / sources-ms 5 / util 8 / settings 4 / queue 4 / library 2）
test result: ok. 32 passed; 0 failed; 0 ignored
running 7 tests (tests/download_mock.rs)
test result: ok. 7 passed; 0 failed; 0 ignored
Doc-tests: 0 passed
===TEST_EXIT=0===
```

> 注：Lead 转述 backend-rust 的测试数是 “31 unit + 7 integration”，**实际为 32 + 7**（多 1 个 unit test，无碍）。

### 1.2 `cargo build`（独立执行）

```text
cd src-tauri; cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.50s
===BUILD_EXIT=0===
```

产物：`src-tauri/target/debug/model-download-manager.exe`（20,811,776 B，19:05:34）。

### 1.3 未执行项（说明）

- `cargo run` 启动窗口验证：**未执行**。按 Lead 分工该项归 QA/backend-rust 的验收；本节只确认 `cargo build` 成功且 exe 已产出。若 QA 尚未覆盖，建议补做（注意：直接 `cargo run` 的 debug 构建走 `devUrl=http://localhost:1420`，不先 `npm run dev` 时窗口可能白屏，这是 Tauri dev 模式预期行为，不代表构建失败）。
- NSIS 安装包 / 真实网络下载：QA 负责，不在本报告范围。

### 1.4 测试“真实性”抽查（不是摆设）

逐条读了 `tests/download_mock.rs`，7 个集成测试都有实际断言：最终文件字节与源内容逐字节相等（`read_final(&dir) == full/content()`）、mock 请求计数（`counter == 1/2`）、错误文案包含“已重试 N 次”、`.part` 长度与 reported downloaded 相等、`.part.json` 保留、临时文件清理等。mock server 是真实 `tokio::TcpListener` + 手写 HTTP/1.1（含 truncated/slow 模式），不联网。

---

## 2. P0 —— 无

未发现会阻断启动、编译、核心下载链路或安全边界的 P0 级缺陷。

---

## 3. P1 —— 3 条（建议本轮修复）

### P1-1 队列状态机存在 TOCTOU 竞态：暂停与“下载完成”并发时任务可能永久卡在 `pausing`

- **位置**：`src-tauri/src/queue.rs:397-435`（`pause_task`），其中 `queue.rs:405` 先读快照、`queue.rs:412-417` 再无条件 `update_task(|task| task.status = Pausing)`；对侧 `queue.rs:192-294`（`finish_task`）在下载协程结束时把状态写成 `Completed/Paused/Cancelled`。同族：`queue.rs:83-88`（pump 取 `next_queued_task`）与 `queue.rs:133-142`（`start_task` 无条件写 `Active`）相对 `queue.rs:421-431`（queued→paused）的竞态。
- **复现条件（待复现，窗口约“两次短锁之间”的微秒级）**：
  1. 下载即将完成（`transfer()` 已返回、`finish_task` 还未执行/刚执行完 `update_task(Completed)`）；
  2. 用户在同一瞬间点“暂停”；
  3. 若 `pause_task` 的 `update_task` 落在 `finish_task` 的 `Completed` 之后，状态被覆盖为 `Pausing`，而此刻已无任何传输协程会再更新它。
- **后果**：任务永久显示“正在保存临时文件…”。`resume_download` 对 `Pausing` 是 no-op（`queue.rs:465`），`cancel_download` 对 `Pausing` 只置标志（`queue.rs:512-520`）也没有传输再收尾，`remove_tasks` 拒绝删除非终态 → **UI 无法自救，只能重启应用**（重启恢复把 pausing→paused 后才可继续）。pump 竞态同样会让用户刚点的“暂停 queued 任务”丢失（任务照常变 active）。
- **建议修法**：把状态变更改成“带前置条件的 CAS”。例如给 `AppState::update_task` 加一个返回 `Option<DownloadTask>` 的变体，闭包返回 `bool` 表示是否接受本次变更；所有命令/收尾都只在“当前状态仍属于预期集合”时才写：
  - `pause_task`：仅 `Active|Pausing` 且 `!terminal` 时置 `Pausing`；
  - `cancel_task` active 分支、`start_task` 置 `Active`、`finish_task` 置终态同理；
  - 或集中实现 `fn transition(task, from: &[TaskStatus], to: TaskStatus) -> bool`。
  建议补一个并发单元测试（可用可控的“暂停钩子”在 `finish_task` 前后注入），至少覆盖 “Completed 后 pause 应返回错误/无操作而不是覆盖”。
- **状态**：代码级可证，竞态窗口小、尚未复现；标 **待复现**。

### P1-2 `DownloadTask.retries` 永远是 0，前端“重试 N 次”永不显示

- **位置**：字段定义 `src-tauri/src/models.rs:212`；初始化 `queue.rs:371`（新建恒 0）与 `queue.rs:766`（测试）；实际重试计数只存在于 `download.rs:618` 的局部变量 `retries_used`，经 `download.rs:454-483` 自增，**从未回传到任务表**。前端展示：`src/components/downloads/TaskRow.tsx:272-274`（“重试 {task.retries} 次”徽章）与 `:342`（error 行“已重试 {task.retries} 次”）。
- **契约**：`docs/IPC-CONTRACT.md` §2 `DownloadTask.retries: number // 已重试次数`。现在该字段在真实失败/重试后仍为 0，契约字段失效，UI 功能静默不生效。
- **建议修法（最小改动）**：给 `TransferContext` 增加一个重试回调，如 `on_retry: Arc<dyn Fn(u32) + Send + Sync>`；`retry_or_stop` 自增后调用它。`queue::start_task` 传入闭包：`state.update_task(task_id, |t| t.retries = n)` 并 `util::emit_task_updated(sink, &task)`（重试频率低，无需限流）。若想更简单：让 `DownloadError` 携带 `retries_used`，由 `finish_task` 的 error 分支写入 `task.retries`（只保证终值正确，重试过程中不实时）。
- **状态**：**已确认（静态可证）**。

### P1-3 `.part` 长度 ≥ `total_size` 时未经验证直接 rename 为最终文件（数据完整性）

- **位置**：`src-tauri/src/download.rs:613-616`（进入主循环前）与 `download.rs:637-640`（每轮循环前）：`if total_size > 0 && downloaded >= total_size { finish_transfer(...) }`。`total_size` 优先取任务创建时的列表 size（`queue.rs:117-121`、`download.rs:592-596`），`downloaded` 取 `.part` 实际长度（`download.rs:608`）。
- **复现条件（待复现）**：任务已暂停，`.part` 比“当前记录的 total_size”长，且尚未发任何 Range 请求（因此 etag/lastModified 校验根本不会执行）：
  - 远端文件在暂停期间被替换成更小版本（模型仓库更新很常见），而队列里 `task.total_size` 仍是旧值（更大）→ 通常不会触发本条件；
  - 更容易触发的是 `task.total_size` 是**小于** part 的过期/错误列表值（例如远程列表 size 字段异常、或 tasks.json 中 size 被旧版本写小）；
  - 或者上次异常退出遗留了比当前列表 size 更长的 `.part`。
- **后果**：把超长/陈旧内容直接 `rename` 成最终文件并上报 `completed`，不校验内容完整性（`downloaded > totalSize` 的文件被标记完成），后续 UI 认为已下载成功。
- **建议修法**：把两处前置判断从 `>=` 改为 `==`；`downloaded > total_size` 时删除 `.part`/`.part.json`、`downloaded = 0` 走一次正常 Range 流程（服务器会以 200/206/416 给出真实 total，416 分支会再校验）。
- **状态**：代码可证，需构造 stale part 才能复现；标 **待复现**。

---

## 4. P2 —— 20 条（按主题分组，按建议优先级排序）

### 4.1 下载引擎健壮性

- **P2-1 暂停/取消无法中断“限速等待”和“等待响应头”**：`download.rs:431` 调 `ctx.limiter.acquire(...)`，而 `util.rs:553-578` 的 acquire 循环只 sleep/补 token、**不检查 `TaskControl`**；此外 `download.rs:654` 的 `request.send().await` 最长可等 connect timeout 30s，且没有读空闲超时。正常 UI 限速最小 0.5 MB/s（8KB 块 ≤16ms）无感；但用户可手输极小值（如 0.001 MB/s），暂停延迟可达数秒~数十秒；服务器挂起时任务会长时间停在 active 且进度不动。
  - 建议：`acquire` 接受 `&TaskControl` 并在等待循环中返回 Paused/Cancelled（或拆出 `acquire_interruptible`）；可选增加读空闲超时（如 120s 无数据视为可重试网络错误）——后者与契约“无全局超时”不冲突。
- **P2-2 一批下载请求中任一非法路径会让整批失败**：`queue.rs:315-318` 循环内 `?` 直接返回 Err。用户在仓库详情多选 15 个文件，若其中 1 个远端路径含 Windows 非法字符/保留名，**全部无法创建任务**。
  - 建议：逐项收集错误，合法项照常入队，返回/提示“N 个文件因路径非法被跳过：<首个原因>”。（若改返回结构需先改契约，可先只跳过 + eprintln，至少不整批失败。）
- **P2-3 去重键只用最终路径，忽略 source**：`queue.rs:322-324` + `state.rs:192-197`。契约 §3 命令 4 要求按“source+repo+remotePath+最终路径”去重。跨源同名仓库（如同 `Qwen/Qwen2.5-0.5B-Instruct` 分别从 HF/MS 下到同一目录）第二次会被静默跳过。建议去重条件追加 `task.source == request.source`。
- **P2-4 未知 total + 干净 EOF 被当完成**：`download.rs:857-858`（`unknown_total_finished = total_size == 0`）。若服务器既无 Content-Length 又非 chunked，连接被中途切断看起来就是正常 EOF，会得到截断文件并标记完成。现实两家 API 都带 Content-Length/chunked，风险低；可作为已知限制记录，或对“未知 total + 0 字节结束”改为再请求一次大小/校验。
- **P2-5 206 但缺 `Content-Range` 时直接判“远端已变”**：`download.rs:734-747`：按契约 206 应带 CR，合规服务器不会触发；但若 CDN 返回裸 206，会删 part 重下一次后报错。建议 206 无 CR 时按 `Content-Length` + 起点未知处理（保守可保留现状，列入已知限制）。
- **P2-6 重试计数跨“有进展”不重置**：`download.rs:618` 的 `retries_used` 一次 transfer 内累计，收到新数据不清零。长时间下载中间偶发 3 次断线（maxRetries=3）→ 直接 error，而每次其实都成功续传了。契约未细化“连续失败”语义，建议收到 >1MB 新数据后 `retries_used = 0`（更符合“重试”直觉），并在契约里写清。

### 4.2 队列与持久化

- **P2-7 `tasks.json` 损坏时被静默覆盖为空**：`state.rs:335-362` 读失败仅 eprintln 后返回空表，`queue.rs:66-69` 紧接着 `install_recovered_tasks(vec![])` 落盘 → 损坏文件被空列表覆盖，用户任务历史永久丢失。建议失败时把原文件重命名为 `tasks.json.corrupt-<ts>` 保留现场。
- **P2-8 dirty 标志与落盘存在竞态**：`state.rs:323-328` 先取快照、写盘后无条件 `dirty.store(false)`；写盘期间的新变更可能被清掉。终态标记因 `terminal_dirty` 单独处理通常会被下一轮补写，但极端情况下最后一次变更可能等到下次变更才落盘（崩溃丢 2s 内状态，与契约“每 2 秒或终态”略有偏差）。建议用 generation 计数：写盘前记 `g`，写盘后仅在 `dirty_generation == g` 时清除。
- **P2-9 取消“刚好已完成”的 active 任务被静默忽略**：`queue.rs:511-520` active 分支只置标志并返回 Ok；若此刻任务已完成且 control 已移除，会新建一个 control 置标志，但状态仍是 Completed，用户看到“取消成功”提示却什么都没发生（且新建 control 泄漏到 map，直到 remove_tasks）。建议 active 分支也在 `update_task` 里做状态前置校验，已完成时返回“任务已完成，无法取消”。
- **P2-10 `resume_download` 对 `pausing` 返回 Ok 但无操作**：`queue.rs:465`。前端目前不展示该入口（TaskRow pausing 只给“暂停禁用+取消”），但 API 语义模糊；建议返回中文错误或明确支持“pausing→queued（取消暂停意图）”。
- **P2-11 启动时 tasks.json 落盘失败会导致应用起不来**：`lib.rs:18` `queue::recover(&state)?` → `state.rs:365-373` 中 `persist_tasks` 返回 Err → setup 失败。数据目录只读/磁盘满等情况下应用直接无法打开。建议 recover 的落盘失败只 eprintln，不阻断启动（内存态仍可用）。
- **P2-12 清理终态记录不清理残留 `.part`**：契约明确 `clear_finished`“不删文件”，但取消时 `deletePartial=false` 的任务会留下 `.part/.part.json`，`scan_library` 又跳过它们 → 永久占盘且 UI 不可见。建议在 `remove_tasks`/`clear_finished` 里对终态任务调用 `remove_task_temp_files`（不违反“不删最终文件”），或 UI 提供清理入口。

### 4.3 路径与安全

- **P2-13 符号链接单元测试可能静默空转**：`util.rs:716-734` 的 `prepare_download_rejects_symlinks_and_creates_dirs` 只有在 `std::os::windows::fs::symlink_dir(...).is_ok()` 时才断言；Windows 非开发者模式/非管理员通常创建失败 → **测试通过但根本没测符号链接**。另外 Rust `FileType::is_symlink()` 对 Windows **junction/mount point 返回 false**，实际拦截依赖 `ensure_safe_relative` 的 `canonicalize` 前缀校验（`util.rs:274/294-302`），该路径没有专门测试。建议：用 `cmd /c mklink /J` 创建 junction 做测试（不要求管理员）、断言创建成功或 `#[ignore]` 明确标注；再补一条“已存在 junction 指向 root 外必须被拒绝”的测试。
- **P2-14 `scan_library` 不排除 junction**：`library.rs:35-47` 只跳过 `is_symlink()`；junction 目录在 Windows 上 `is_dir()==true` 且不是 symlink，会被递归进入（深度≤8、≤20000 文件兜底，不会死循环，但可能列出下载目录之外的文件、或浪费大量 IO）。建议对目录项 canonicalize 后校验仍在 root 前缀内，或跳过 reparse point。
- **P2-15 保留名检查未覆盖 `CONIN$`/`CONOUT$` 与上标数字**：`util.rs:83-86,108-111` 覆盖 CON/PRN/AUX/NUL/COM1-9/LPT1-9（含扩展名），但漏 `CONIN$`、`CONOUT$`、`COM¹` 等 Windows 特殊设备名。命中概率极低，作为加固项记录。
- **P2-16 error 文本可能带 CDN 预签名 URL 的 query**：`download.rs:425-426`、`sources/mod.rs:165-167` 会把 `reqwest::Error` 的 Display（含 URL）拼进中文错误；若失败发生在 302 跳转后，URL 可能是 `cdn-lfs-cn-1.modelscope.cn/...?auth_key=...` 或 `cas-bridge.xethub.hf.co/...?X-Amz-Signature=...`，随后进入 `task.error` 并在 UI 显示。**不是用户 token**，但属短期凭证；建议对错误文本做 URL query 脱敏（正则去掉 `?...` 或只保留 host+path）。
- **P2-17 `/select,` 参数未转义**：`util.rs:489-492` `format!("/select,{}", path.display())` 对含空格/逗号的路径可能选择失败（explorer 参数解析）。建议 `format!("/select,\"{}\"", ...)` 或用 ShellExecute 语义。

### 4.4 数据源与错误文案

- **P2-18 ModelScope 搜索把所有失败都降级成同一句提示**：`sources/modelscope.rs:246-262` 把网络错误/代理错误/响应格式错误统统替换为 `SEARCH_UNAVAILABLE_MESSAGE`，用户配错代理时只会看到“搜索暂不可用，请直接输入仓库 ID”，无法定位。建议只对业务层不可用（HTTP 404/非 200）降级，网络错误原样抛中文。
- **P2-19 HF 非法/过期 cursor 未回退第一页**：`sources/huggingface.rs:101-107` 本地校验失败直接报“分页游标无效”；服务器对非法 cursor 返回 400 时走 `map_http_error` → “请求失败（HTTP 400）”。api-contracts 建议“游标失效回到第 1 页”。建议 400/游标无效时自动回退首页并 `hasMore=false` 提示，避免用户卡在错误页。
- **P2-20 HF 403 一律提示 Token/授权**：`sources/mod.rs:146-162` 对 HF 401/403 固定返回 gated 文案；若 403 来自镜像限流/风控，会误导。可接受（镜像未返回可区分头），记录为已知限制。

### 4.5 前端集成与工程

- **P2-21 `src/types.ts:29` 注释过期**：仍写 “默认 https://huggingface.co；可填镜像”，而后端 `settings.rs:14` 与契约（19:04 版）默认已是 `https://hf-mirror.com`。仅注释，但会误导后续维护者。建议 frontend-app 同步（Lead 已更新契约）。
- **P2-22 mock 代码被静态打进生产 bundle**：`src/lib/ipc.ts:24-25` `import { createMockBridge } from '../mocks/mockIpc'` 是静态 import；实测 `dist/assets/index-*.js` 中可见 `mock-task-...` 等 fixture 字符串（`src-tauri/../dist` 19:05 构建产物）。影响：bundle 体积 +（虽无地址栏）生产进程中保留 `?mock=1` 切换分支。建议改成仅 mock 分支 `const { createMockBridge } = await import('../mocks/mockIpc')`（Vite 自动拆包），并在 `detectMockMode` 中 `import.meta.env.PROD` 时强制 false。监听注册时序本身处理正确（appStore 已覆盖“注册完成前取消”）。
- **P2-23 `bytes = "1"` 依赖未使用**：`Cargo.toml:25`；源码中无 `bytes::`（reqwest 内部已自带）。建议移除，减少无关编译。
- **P2-24 `settings.rs` 单测会真实创建用户目录**：`settings.rs:206-215` 的 `clamps_out_of_range_numbers` 调 `validate_and_clamp`，后者 `create_dir_all(settings.download_dir)`（`settings.rs:104-105`），而测试用 `default_download_dir()` → 在跑测试的机器上真实创建 `%USERPROFILE%\Documents\Models`。建议测试改用临时目录。
- **P2-25 命令参数无默认值**：`commands.rs:39-46` 的 `search_repos` 要求 `page`/`limit` 必传，契约写“limit 默认 20、page 从 1 起”；前端总是传，故无实际影响。建议改 `Option<u32>` + 默认值以贴合契约。
- **P2-26 CSP 与 `tauri dev` HMR（待验证）**：`tauri.conf.json` `script-src 'self'`，Vite dev 模式会注入内联 react-refresh preamble；Tauri v2 是否在 dev 应用 CSP 需实测。QA 用构建产物不受影响；若 `npm run tauri:dev` 白屏，优先怀疑此处（可加 `devCsp` 或 dev 时放宽）。

---

## 5. 契约一致性核对（逐项）

### 5.1 类型（`models.rs` ↔ `types.ts` ↔ 契约 §2）

| 项 | 结果 | 备注 |
|----|------|------|
| `Source` / `FileKind` / `TaskStatus` 字面量 | ✅ 一致 | Rust `#[serde(rename_all="lowercase")]` ↔ TS union |
| `Settings` 10 字段 + camelCase | ✅ 一致 | `#[serde(default)]`，默认值与契约一致（含 hf 镜像默认） |
| `RepoSummary` / `RepoSearchPage` | ✅ 一致 | `gated` HF 字符串 "auto"/"manual"→true 处理正确；`nextCursor` 为改写后完整 URL（前端按不透明串透传，后端会再校验+重写） |
| `RepoFile` / `RepoDetail` | ✅ 一致 | `totalSize` = Σfiles；`revision` 按来源默认 |
| `DownloadTask` 18 字段 | ⚠️ 字段存在但 `retries` 恒 0 | 见 P1-2 |
| `DownloadRequest` | ✅ 一致 | `size` serde 默认 0 |
| `LocalFile` / `AppSnapshot` | ✅ 一致 | |
| 时间/大小单位、camelCase 输出 | ✅ 一致 | |

### 5.2 命令（20 个，`commands.rs` ↔ `ipc.ts`）

20 个命令名、参数名、必选/可选、返回类型逐项核对**全部一致**：`get_snapshot`；`search_repos{source,query,page,limit,cursor?}`；`get_repo_detail{source,repoId,revision?}`；`start_downloads{requests[]}`；`pause/resume_download{taskId}`；`pause_all`/`resume_all`；`cancel_download{taskId,deletePartial}`；`retry_download{taskId}`；`remove_tasks{taskIds[]}`；`clear_finished`；`get_settings`/`save_settings{settings}`；`scan_library`；`open_path{path,reveal}`；`delete_local_file{path,removeTask}`；`test_connection{source}`；`get_default_download_dir`；`open_data_dir`。全部 `#[tauri::command(rename_all="camelCase")]`，Tauri v2 注入参数（`AppHandle`/`State`）不参与 camelCase 映射，正确。`revision?: undefined` 经前端 `invoke` 序列化会省略字段 → Rust `Option<String>` 收到 None，行为正确。

### 5.3 事件（`util.rs` emit helpers ↔ `ipc.ts` listen / appStore）

| 事件 | payload | 结果 |
|------|---------|------|
| `download-progress` | `{taskId,downloaded,totalSize,speed}` | ✅ 字段名一致 |
| `task-updated` | `{task}` | ✅ |
| `tasks-removed` | `{taskIds}` | ✅ |
| `settings-updated` | `{settings}` | ✅ |

事件顺序符合契约 §5.7（完成先 progress 后 task-updated）；前端 store 幂等合并、进度不回退、注册前取消订阅处理都正确。

### 5.4 架构硬性要求

| 要求 | 结果 |
|------|------|
| `sources/download/settings/util` 不依赖 `tauri::AppHandle`（EventSink 除外） | ✅：`util.rs` 仅 `AppHandleSink`（架构明确豁免），其余三模块零 tauri 依赖，可直接测试/example 调用 |
| `EventSink` trait + AppHandleSink + 测试 RecordingSink/NoopSink | ✅：`util.rs:383-412`；queue 测试用 RecordingSink，集成测试用 NoopSink |
| 中文用户错误 `Result<_, String>` | ✅ 主链路均为中文；英文仅出现在 reqwest/serde 细节括注中，可接受 |
| 持久化布局 `settings.json` / `tasks.json{version:1,tasks}` | ✅ |
| Tauri v2 写法（`Emitter`/`Manager`、`app_data_dir()`、`rename_all`、`async_runtime::spawn`、`.manage()`） | ✅ `lib.rs` 全部符合 |
| 安全：不输出 token、固定 URL 模板、路径净化 | ✅（仅 P2-16/P2-13 加固建议） |

---

## 6. 测试覆盖评估（对照 ARCHITECTURE §3.4/§3.5）

### 已覆盖（要求项）

| 要求 | 覆盖测试 |
|------|----------|
| 路径净化/`..`/盘符/UNC/保留名 | `util::tests::rejects_dangerous_remote_paths`、`sanitizes_repo_ids`、`builds_paths_under_save_dir`（拒绝相对目录） |
| 符号链接拒绝 | `prepare_download_rejects_symlinks_and_creates_dirs`（**有静默跳过风险，见 P2-13**） |
| `Content-Range` 解析、206/200/416 分支 | `download::tests::parses_content_range_variants` + mock 集成 4 个用例 |
| 重试判定（可重试 vs 不可） | `retryable_status_classification` + `exhausts_retries_on_5xx` + `does_not_retry_on_401` |
| 令牌桶 0=不限 / 不足等待 / 恢复继续 | `token_bucket_unlimited_returns_immediately`、`token_bucket_waits_when_budget_insufficient` |
| 分类函数 | `classifies_files_per_contract` |
| 队列状态机 | `queued_pause_resume_cancel_and_remove_rules`、`start_downloads_dedupes_by_final_path`、`completed_file_is_detected_at_enqueue`、`recovery_pauses_active_tasks_and_respects_auto_resume` |
| 续传（中途断开） | `resumes_after_mid_stream_disconnect`（内容逐字节断言 + 请求次数） |
| 416 total==part 长度完成 | `treats_416_with_matching_total_as_complete` |
| 5xx 重试耗尽 error | `exhausts_retries_on_5xx` |
| 暂停保留 part、resume 后内容完整 | `pause_keeps_part_and_resume_finishes` |
| ModelScope 200+Content-Range 特殊语义 | `handles_modelscope_style_200_with_content_range` |
| HF 镜像忽略 Range → 从头写 | `falls_back_to_full_download_when_server_ignores_range` |

### 缺口（建议补测，按价值排序）

1. **etag/lastModified 变化 → 删除 part 从头下载**（契约 §5.2.4，当前无任何测试覆盖；`resume_headers_match` 只有纯函数测试）。
2. **队列 active→pausing→paused 全链路**与 **cancel active→cancelled（含 deletePartial 清理）**——目前 queue 单测只覆盖 queued 分支；集成测试直接测引擎，未经过队列状态机，P1-1 的竞态也正因缺此类测试而未被发现。
3. **`maxRetries=0` 首次失败即 error**（契约 §5.6 边界；现在只间接在 416 用例用 0，5xx 用 1）。
4. **token 头行为**：配置 token 时应发 `Authorization: Bearer`、为空时不发；且错误文本不含 token（mock server 可断言请求头）。
5. **未知 totalSize 完成路径**（`total_size=0` 且服务器无 Content-Length）。
6. **限速等待中的暂停延迟**（对应 P2-1，可用 1 KB/s + 慢速 mock 断言暂停在 1s 内生效）。
7. **`start_downloads` 单个非法路径不拖垮整批**（对应 P2-2）。

> 说明：以上缺口不影响现有 39 个测试的有效性；P1-1/P1-2/P1-3 建议修完后各自补对应回归测试。

---

## 7. 安全与 token 审查

- 全仓 grep `eprintln!/println!/dbg!`：仅 5 处日志（事件发送失败、序列化失败、tasks/settings 文件异常、MS 搜索失败、断点保存失败），**均不含 settings/token**。✅
- `Authorization: Bearer` 仅在 `sources::with_auth` 与 `download.rs:647-649` 构造，未写入任何日志、事件或持久化文件；`.part.json` 只存 etag/lastModified/total/repoId/remotePath。✅
- `settings.json` 明文存 token 符合契约 §7；设置页已有“明文存储”警示（SettingsPage 中的 amber 提示）。✅
- reqwest 0.12.28 在跨 host 重定向时会移除 `Authorization`（已查 registry 源码 `redirect.rs:239-251`）→ HF LFS 302 到 `cas-bridge.xethub.hf.co` 时 token 不会泄露给 CDN，同时避免与预签名 URL 冲突。✅（无需修改）
- 事件 payload 不含 token（`settings-updated` 含完整 Settings 是契约要求的，属前端可信域）。✅
- 唯一建议：P2-16（错误文本中 CDN 预签名 URL 的 query 脱敏）。
- 路径安全：`..`/绝对路径/盘符/UNC/反斜杠/保留名/尾点尾空格/控制字符均拒绝；`sanitize_repo_id` 最多 2 段；下载前逐级 canonicalize 校验。✅（junction 依赖 canonicalize 兜底，见 P2-13/14）

---

## 8. 建议修复顺序（供 Lead 分派）

| 顺序 | 项 | 理由 |
|------|----|------|
| 1 | **P1-1 队列状态 CAS** | 唯一可能造成“永久卡死只能重启”的用户可见缺陷；改动局限 queue/state，回归成本低 |
| 2 | **P1-2 retries 回传** | 契约字段失效 + 前端已有 UI 逻辑；改动小（回调即可） |
| 3 | **P1-3 part 长度判断** | 数据完整性，改动 2 行；建议同时补 stale-part 测试 |
| 4 | P2-13/14 符号链接/junction 测试与扫描 | 安全测试“假绿”风险 + 扫描越界 |
| 5 | P2-7/8/11 持久化健壮性 | 崩溃/损坏场景的用户数据保护 |
| 6 | 其余 P2 | 按 QA 实际反馈取舍 |

**给 Lead 的提醒**：
- 若 backend-rust 已停手，上表 1-3 可作为一个“小修复批次”派给它，修完跑 `cargo test` 即可；我可在其修完后做一次复核（只读）。
- `docs/IPC-CONTRACT.md` §5.7 “每 400ms 最多一次”与 §4 “≤4 次/秒”、实现 250ms 三处表述不一致，建议统一为“≤4 次/秒（最小间隔 250ms）”。（Lead 已于 19:2x 修正契约，实现 250ms 与契约一致。）
- `src/types.ts` 默认端点注释、mock 静态打包属前端小改，建议一并交给 frontend-app（仅 P2）。

---

# 复核结论（修复后复验，2026-11-03 19:20–19:27）

> 复核者：backend-engine（独立只读；未修改任何应用源码，仅本文件）
> 修复执行者：backend-rust（19:16–19:19），复核基线：`docs/BACKEND-REVIEW.md` 初版 + 修复前源码 SHA256 快照
> 裁决依据：Lead 复核 GO（P1-1/2/3 + P2 a/b/c/d 随批修复；R2–R7 裁决不修，记为 v0.1 已知限制）

## 9.0 快照与稳定性

- 修复后源码 SHA256 快照两次采集完全一致（19:20:43 与 19:26:37），说明 backend-rust **已停手、复跑期间源码零改动**：
  `commands.rs EBC0E87D`（仅 `start_downloads` 文档注释）、`download.rs 0942B012`、`queue.rs E28D7ADE`、`sources/mod.rs B26D1F52`、`state.rs DF509E5D`、`util.rs 7C6E727B`、`tests/download_mock.rs 55C8B5BA`；`models.rs / lib.rs / settings.rs / huggingface.rs / modelscope.rs / Cargo.toml` 未变（契约类型、命令注册、依赖均零变更）。
- 复跑前确认 `cargo/rustc/model-download-manager` 进程为空（QA 的 tauri build 与 E2E 已于 19:24 结束）。
- 变更文件：7 个（state.rs / queue.rs / download.rs / util.rs / sources/mod.rs / commands.rs 注释 / tests）。

## 9.1 独立复跑证据（只读）

| 命令 | 结果 |
|------|------|
| `cd src-tauri; cargo test` | **48/48 通过，exit 0**：39 unit + 9 integration（`Finished test profile in 0.50s`；unit 0.31s；integration 3.11s） |
| `cd src-tauri; cargo build` | **exit 0**（`Finished dev profile in 0.62s`，缓存命中） |
| `cd src-tauri; cargo build --example probe_sources` | **exit 0**（`Finished dev profile in 0.44s`） |
| 产物 | `target/debug/model-download-manager.exe` 20,835,328 B（19:19:39）；`target/debug/examples/probe_sources.exe` 8,451,072 B |

与 backend-rust 声称的 “48/48、cargo build 成功” **一致**；测试数从修复前 32+7=39 增至 **39+9=48**（+7 unit / +2 integration = 9 个新测试，与 Lead 口径一致）。

## 9.2 三个 P1 修复复核（代码 + 测试双重确认）

### P1-1 队列 CAS —— ✅ 已真正解决

- `state.rs:260-287` 新增 `transition_task(task_id, expected, update)`：在**同一把 tasks 锁内**校验前置状态并更新，返回 `Updated/Conflict/Missing`；冲突时不修改任务，仅在 Updated 时 `mark_dirty`。这是正确的原子原语。
- 覆盖性核查：`queue.rs` 全部 11 处状态写入均收进 CAS 闭包（开始 `:135`、完成 `:271`、暂停 `:293`、取消 `:311`、失败 `:337`、queued 暂停 `:500`、active 暂停 `:505`、恢复入队 `:553`、非 active 取消 `:648`、重试入队 `:681`、测试 helper `:886`）；仅启动恢复 `state.rs:419/422` 直接写状态——启动阶段单线程、无并发，安全。
- `finish_task`（`queue.rs:218-349`）以 `[Active, Pausing]` 为 expected 收尾（`:261`），因此 **Pausing 中的任务仍能正常转 Completed/Paused/Cancelled/Error，不会卡死**；取消意图优先（Paused/Err 结果遇到 cancelled 标志改为 Cancelled，`:239-259`）；完成/取消/失败分支均正确 `remove_control`、置终态、`mark_dirty(true)`；取消分支按 `delete_partial` 清理 `.part/.part.json`；暂停分支保留 part。
- 无死锁/锁重入：`transition_task` 闭包均为纯字段赋值，不在持锁时调用其它 `AppState` 方法；`tasks`/`controls` 两把锁在所有路径都是顺序获取，无嵌套；`on_retry` 回调在 tokio worker 上执行短锁 `update_task`，不在 transition 闭包内。
- CAS 冲突语义：暂停/取消撞上终态时静默丢弃（`pause_task:524`、`cancel_task:670`），不再覆盖终态；终端状态下的 pause 返回 Ok、cancel 仍返回中文错误，符合此前约定。
- 回归测试：`queue::tests::active_completion_not_overridden_by_concurrent_pause`（Pausing 中完成 → Completed 且完成后再 pause 不覆盖）、`pause_after_completion_is_noop`（完成 → pause 无操作、resume 报错）、`state::tests::transition_task_rejects_stale_expected_status`（冲突不改任务 + 匹配时正常迁移）——断言真实、逻辑对应原竞态（注：为确定性顺序模拟，非真实线程并发；见 §9.5 R7）。

### P1-2 retries 回写 —— ✅ 已真正解决

- `download.rs:42-43` 定义 `RetryCallback = Arc<dyn Fn(u32) + Send + Sync>`；`TransferContext.on_retry: Option<RetryCallback>`（`:63-64`）；`retry_or_stop` 在计数自增后、退避睡眠前调用回调（`download.rs:475-479`），仅可重试失败路径触发。
- `queue.rs:164-178` 注入回调：`update_task` 回写 `task.retries` 并 emit `task-updated`（复用 QueueSink）；捕获 `Arc<AppState>`/`AppHandle`/`taskId`，闭包 Send+Sync，tokio 任务内调用安全，无死锁/锁重入；任务被删除时 `update_task` 返回 None 自动跳过。
- 测试 `tests/download_mock.rs:486-562 retry_counter_reports_two_retries_then_completes`：真实 mock server（前两次 503、第三次 200）+ 真实 `AppState` + 与生产一致的回调，断言 **回调序列 [1,2]**、**task.retries==2**、**总请求 3 次**、最终内容逐字节一致——真实有效。
- 契约 `DownloadTask.retries` 从此被填充，前端 `TaskRow.tsx:272-274/342` 的“已重试 N 次”展示逻辑生效。

### P1-3 stale part > total —— ✅ 已真正解决

- `download.rs:617-627`：任何请求发出前，若 `total_size > 0 && downloaded > total_size` → 删除 `.part/.part.json`、`downloaded=0`、置 `stale_part_reset_used=true`；`:632-637` 改为 **仅 `downloaded == total_size` 才直接完成**；循环内（`:657-682`）同样仅 `==` 完成，`>` 时若一次性保护已用尽则返回明确中文错误，不会无限循环。
- 不会误删正常 part：正常下载中 part 合法长度不可能超过 total（服务器超发时会走 `finish_or_retry` 的 `written >= total` 完成路径），该分支只在“本地陈旧/被污染 part 长于远端声明”时触发；删除后重新下载可恢复正确内容。
- 测试 `tests/download_mock.rs:564-602 discards_stale_part_longer_than_total`：预埋 1200 B part / 远端总 1000 B，断言 **请求不带 Range（证明 part 被丢弃）**、**最终文件恰好 1000 B 且逐字节等于源内容**、仅 1 次请求——真实有效。
- 附带效果（QA 已实测）：超长 part 不再被 `rename` 成“完成”的脏文件。

## 9.3 P2 四项随批修复复核

| 项 | 结论 | 依据 |
|----|------|------|
| P2a `start_downloads` 批次隔离 | ✅ | `queue.rs:361-405` 逐条 `build_task_from_request`，非法项收集跳过；有合法项时照常创建（仅 stderr 汇总），**整批全非法才返回首个中文错误**；返回类型仍为契约 `DownloadTask[]`，前端 `upsertTasks(created)` 兼容。测试 `start_downloads_skips_invalid_request_but_keeps_valid`（1 非法+1 合法→创建 1；全非法→Err） |
| P2b 去重含 source | ✅ | `state.rs:205-221 find_duplicate_task(source,repoId,remotePath,savePath)`；`queue.rs:419-433` 调用并做批内去重。测试 `dedupe_key_includes_source`（HF+MS 同路径→2 条） |
| P2c tasks.json 损坏 quarantine | ✅ | `state.rs:394-412` 解析失败 → `quarantine_corrupt_tasks_file`（`:443-462`）改名 `tasks.corrupt-<毫秒>.json` 保留现场后空表启动；测试 `corrupt_tasks_file_is_quarantined`（原文件消失、恰有 1 个隔离文件、空任务列表）。**可恢复**：手工把 `tasks.corrupt-*.json` 改回 `tasks.json` 即可；v0.1 不自动清理隔离文件（见 §9.5 R5c） |
| P2d 错误 URL query 脱敏 | ✅ | `util.rs:628-663 redact_urls`（仅保留 scheme+host+path，丢弃 query/fragment，支持多 URL）；应用于 `download.rs:429/699` 与 `sources/mod.rs:145-170`（map_http_error/map_network_error）；测试 `redacts_url_query_and_fragment`（含 secret/X-Amz-Signature/#frag 被移除、多 URL、无 URL 原样）。边界见 §9.5 R5a/b |

## 9.4 新增 9 个测试真实性抽查

| 测试 | 真实性 |
|------|--------|
| `queue::active_completion_not_overridden_by_concurrent_pause` | 真实断言：Pausing 中完成必须为 Completed；完成后再 pause 状态不变 |
| `queue::pause_after_completion_is_noop` | 真实断言：完成/再 pause 后仍 Completed；resume 返回 Err |
| `state::transition_task_rejects_stale_expected_status` | 真实断言：Conflict 时状态未被修改；匹配时迁移成功 |
| `queue::start_downloads_skips_invalid_request_but_keeps_valid` | 真实断言：跳过 `../escape.bin` 后仅创建 1 条；全非法返回错误 |
| `queue::dedupe_key_includes_source` | 真实断言：HF+MS 同路径创建 2 条任务 |
| `state::corrupt_tasks_file_is_quarantined` | 真实断言：空任务列表 + 原文件不存在 + 隔离文件恰 1 个 |
| `util::redacts_url_query_and_fragment` | 真实断言：host/path 保留、secret/Signature/fragment 消失、多 URL/无 URL 正确 |
| `download_mock::retry_counter_reports_two_retries_then_completes` | 真实 mock server + 真实 `AppState`；断言回调 [1,2]、retries==2、请求数 3、内容一致 |
| `download_mock::discards_stale_part_longer_than_total` | 真实 mock server；断言无 Range、最终 1000 B、内容一致、请求数 1 |

结论：**9 个新测试均有实际断言，无摆设测试**；其中 P1-2/P1-3 用真实 mock HTTP server + 真实 `AppState`，P1-1 为确定性交错模拟（可复现原 bug，但非线程级并发压力，见 R7）。

## 9.5 v0.1 已知限制（残余风险，Lead 裁决本轮不修）

> 以下为复核确认的**非阻断**残余风险。均非本次修复引入的回归；P0/P1 已清零，不触发第二轮改动。记录供 v0.2 backlog。

| ID | 等级 | 描述与影响 | 规避/后续建议 |
|----|------|-----------|--------------|
| R1 | P2 | 暂停/取消无法中断令牌桶等待与等待响应头（`util.rs:553` acquire 不检查控制标志；`download.rs:436`）。正常 UI 限速（≥0.5 MB/s）无感；手输极小限速（如 0.001 MB/s）或服务器挂起时，暂停延迟可达数秒~数十秒 | v0.2：acquire 可中断化 + 可选读空闲超时 |
| R2 | P2 | 用户点暂停「queued 任务」与 pump 启动同一 tick 时，pause 的 CAS 可能 Conflict 后静默丢弃（任务照常变 active）。窗口微秒级、仅丢失一次点击，无状态损坏 | v0.2：pause_task 对 Conflict(Active) 重读状态后按 active 分支重试一次；QA p1-regressions 实测五轮暂停均 187–553ms 收敛，未命中该窗口 |
| R3 | P2 | `finish_task` 的「CAS → remove_control」之间若用户 resume 同一 Paused 任务拉起新 run，finish 的 remove_control 可能摘掉新 run 的控制标志 → 该 run 的暂停/取消可能一次失效（无数据损坏，任务仍会自然完成/失败） | v0.2：`remove_control_if_same(task_id, &Arc)`（ptr_eq）或先 remove 再 CAS |
| R4 | P3 | `retries` 在新 run/手动重试开始时不清零，UI 可能短暂显示上一轮次数；退避睡眠中被暂停也会计一次 retry（回调在 sleep 前） | v0.2：start_task/retry 时重置 retries，回调移至真正重发请求前 |
| R5a | P3 | `redact_urls` 不处理 URL userinfo（`scheme://user:pass@host`），代理密码仍可能出现在 `validate_proxy`/`build_http_client` 的错误文案（这两处也未走 redact） | v0.2：脱敏 userinfo，或代理校验错误不回显原始 URL |
| R5b | P3 | URL 后紧跟全角标点且无 ASCII 分隔符时，`redact_urls` 可能把尾部非 URL 文案一并截掉（仅影响可读性，不会泄露） | v0.2：分隔符集合加入全角标点 |
| R5c | P3 | `tasks.corrupt-*.json` 隔离文件不自动清理/无 UI 入口，需手工恢复 | v0.2：设置页提供数据目录入口（已有 open_data_dir）+ 文档说明 |
| R6 | P3 | 取消与「刚好完成」竞态时任务保持 Completed，而前端 cancel toast 可能显示“已取消”（既有语义）；取消 active 任务在控制标志已被收尾移除时静默 Ok | v0.2：finish 前检查取消标志时把 Completed 也纳入“取消优先”或调整前端提示 |
| R7 | 工艺 | queue 并发测试为确定性顺序模拟（非真实线程竞争）；集成测试 mock server 为单连接 HTTP/1.1，不覆盖 chunked/gzip | 结论已由 QA `p1-regressions 47/47`（五轮真实暂停 187–553ms 收敛、无 pausing 滞留）与 `download-e2e 61/61` 交叉验证；v0.2 可补 loom/压力测试 |

> 说明：初版报告中未随本轮修复的其余 P2（P2-1 限速不可中断、P2-13/14 junction 测试与扫描、P2-7/8/11 持久化健壮性、P2-21/22 前端 mock/注释、P2-23 `bytes` 未用依赖、P2-24 测试创建用户目录、P2-25 参数默认值等）仍记录在 §4，归入 v0.2 backlog；其中 P2-1 即 R1，P2-21 的文档口径 Lead 已修正（契约 §5.7 统一为 250ms）。

## 9.6 契约 / 前端兼容性复核

- **类型零变更**：`models.rs` 未改动（`DownloadTask.retries` 语义现在真正生效，字段本身与 TS `types.ts` 一致）。
- **20 个命令签名零变更**（`commands.rs` 仅增加 `start_downloads` 文档注释，实际实现仍调 `queue::start_downloads`）；返回类型/参数名/camelCase 不变。
- **4 个事件 payload 零变更**；`task-updated` 现在会因重试产生额外事件（前端 store 幂等合并，`mergeTask` 保留进度不回退，无重复条目）。
- `start_downloads` 新语义（跳过非法项、全非法才 Err）与前端 `RepoDetailView` 的 `created.length`/skipped toast 兼容；仅“被跳过”文案把非法项也归为“已在队列或已下载”（P3 文案，无功能影响）。
- `retries` 回写后前端徽章/错误行展示生效；暂停终态请求返回 Ok（前端从不调用终态暂停）无影响。
- **结论：契约与前端对接无回归。**

## 9.7 最终建议：**v0.1 后端可交付**

支持证据：

1. 本次复核独立复跑：`cargo test` **48/48 全绿**、`cargo build` 成功、`cargo build --example probe_sources` 成功（源码 hash 与 backend-rust 交付快照一致，无后续改动）。
2. 三个 P1 全部确认修复（代码逻辑 + 真实断言测试双重验证），未发现新引入的 P0/P1；CAS 覆盖全部迁移点、无死锁、收尾/控制标志/临时文件行为正确。
3. P2 四项随批修复均正确落地并有测试覆盖。
4. 残余风险仅 R1–R7（P2/P3，非阻断），已在 §9.5 明示并记录为 v0.1 已知限制，Lead 裁决不修。
5. QA 端到端证据（Lead 提供）：48/48 测试、download-e2e 61/61、p1-regressions 47/47（P1-1 五轮暂停 187–553ms 收敛、无 pausing 滞留；P1-3 超长 part 丢弃重下）、NSIS 安装包 2,044,828 B / SHA256 `1C7A7B49…`，安装→启动→卸载 PASS。

**交付建议**：按 v0.1 交付；将 §9.5 R1–R7 与 §4 未采纳 P2 列入 v0.2 backlog。**无需第三轮后端改动。**
