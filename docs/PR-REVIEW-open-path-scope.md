# PR 审查说明：`fix/open-path-scope`

## 1. 概要

本分支包含两类改动：

1. **安全修复（本次主要目的）**
   - `open_path` 现在只允许打开已配置扫描根（`downloadDir` ∪ `libraryRoots`）之内的路径，与 `delete_local_file` 的规则一致。两者共用 `ensure_within_scan_roots`。
   - Windows 下 `explorer /select,` 的路径加了引号，修复包含空格或逗号的路径选中错误。
2. **随分支提交的既有未提交功能**（需单独审查，见第 3 节）：本地文件检查、仓库文件状态、镜像共享校验、分段下载相关改动。

## 2. 安全修复审查要点

| 位置 | 改动 | 审查关注点 |
| --- | --- | --- |
| `src-tauri/src/commands.rs` `open_path` | 增加扫描根校验 | 路径需先 `canonicalize`，不存在的路径会以"无法解析路径"拒绝，符合预期 |
| `src-tauri/src/commands.rs` `ensure_within_scan_roots` | 抽取的共用校验 | `delete_local_file` 仍保留原错误文案（经 `map_err` 覆盖），前端提示不变 |
| `src-tauri/src/util.rs` `open_in_explorer` | `/select,"<path>"` 加引号 | 仅 Windows 分支；非 Windows 分支未改动 |

**已验证**
- `cargo check --all-targets` 通过
- `cargo test --lib` 77/77 通过
- `tsc --noEmit` 通过
- 前端测试 48/48 通过（需 `node --test --test-isolation=none`，在沙箱中默认方式会因子进程 `spawn EPERM` 失败，属环境限制）

**未验证**
- 未在真实 Windows 桌面手动测试"打开文件 / 在资源管理器中显示"功能。
- 未对 `open_path` 的拒绝路径做专门的单元测试（建议补充）。

## 3. 随分支提交的既有功能：下载核心审查结论

按要求，我逐行审阅了 `src-tauri/src/download.rs`（1218 行），并核对了 `queue.rs` 中的完成与校验路径。结论如下。

### 3.1 已确认的正确行为

- **不可重试错误**：401/403/404、以及非 408/429/5xx 的 4xx 直接失败，不会无意义重试（`download.rs` `status_is_retryable`）。
- **校验失败不会静默放行**：SHA-256 不一致时任务进入 `Error`，`verify_status = Mismatch`，文件原地保留且不会被删除（`queue.rs` `apply_verify_outcome`，第 135-149 行）。
- **远端变化检测**：续传时通过 `If-Range` 与 `ETag` / `Last-Modified` 比对，不一致则丢弃断点重下，且只允许重置一次，避免死循环（`download.rs` 第 920-947 行）。
- **预分配或陈旧断点**：`.part` 长度达到远端大小时视为不可信，丢弃重下，不直接 rename（第 810-817、841-854 行）。
- **孤立断点清理**：没有有效元数据记录的 `.part` 会被清理，避免把零填充文件当作已下载数据（`discard_untracked_part`）。
- **符号链接拒绝**：下载目标、`.part`、元数据路径若为符号链接，直接拒绝（`prepare_target`）。

### 3.2 需要关注的风险（建议在 PR 中讨论）

**R1（中）：无 SHA-256 时完成即视为有效，不做内容校验**
- 位置：`queue.rs` 第 459-463 行；`download.rs` 第 446 行 `finish_transfer`。
- 现象：只要 `written == total_size`（或 total 未知且流正常结束），文件即 rename 为最终文件，`verify_status = Unavailable`。
- 风险：若远端在两次请求之间内容变化而长度相同，或续传时 ETag 缺失（`resume_headers_match` 在任一方缺失时直接返回"一致"，第 247-258 行），拼接出的文件可能损坏，且无任何提示。
- 建议：为续传增加"无 ETag 时至少比对 Content-Length 与总长"的检查，或在 UI 中对 `Unavailable` 状态给出明确提示。

**R2（中）：未知总长度时任何流结束都视为完成**
- 位置：`download.rs` 第 1094-1096 行，`unknown_total_finished`。
- 现象：`total_size == 0` 时，只要 HTTP 流正常结束（即使被中途截断，如 TCP 层提前关闭但未报错）即 rename 完成。
- 风险：服务器不返回 `Content-Length` 且连接被截断时，会得到不完整文件并被标记为成功。
- 建议：对未知长度的下载，要求必须有 SHA-256 才能确认完整性，或将其标记为"未经校验"。

**R3（低）：`resume_headers_match` 对缺失校验器宽容**
- 与 R1 相同根源，记录在此以便一并讨论。无 ETag 的源仍可续传，这是有意的设计取舍，但应在文档中说明。

**R4（低）：`.part` 删除失败被忽略**
- 位置：多处 `let _ = tokio::fs::remove_file(...)`（如 `download.rs` 第 813-814、939-940、980-981 行）。
- 风险：删除失败后可能残留旧断点，下一次续传误用。当前有 `discard_untracked_part` 兜底，影响有限。

### 3.3 未覆盖范围

以下文件本次**未逐行审阅**，需要单独安排审查：
- `src-tauri/src/queue.rs`：仅审阅了完成、校验与恢复路径（约 220 行），调度器与暂停/取消状态机未深入审阅。
- `src-tauri/src/segmented.rs`（1099 行）：多连接分段下载，未审阅。分段续传的正确性风险较高，**强烈建议重点审查**。
- `src-tauri/src/integrity.rs`（新增 203 行）：未逐行审阅。
- 前端 `src/` 中随分支提交的新改动（`useLocalRepoFiles.ts`、`repoFileState.ts` 等）：未审阅。

## 4. 审查清单（给 reviewer）

- [ ] `open_path` 的扫描根校验对符号链接与 `..` 路径的行为是否符合预期
- [ ] Windows 上 `/select,"..."` 对包含中文与空格的真实路径是否工作
- [ ] R1/R2：无校验和未知长度下载的完整性风险是否可接受
- [ ] `segmented.rs` 分段续传的正确性（未审阅，建议重点）
- [ ] `integrity.rs` 摘要缓存的失效条件（未审阅）
- [ ] 随分支提交的前端改动是否应拆分到独立 PR

## 5. 建议拆分

由于本分支混合了安全修复与较大的既有功能，**建议拆成两个 PR**：
1. `fix/open-path-scope`：仅保留 `open_path` 与 explorer 引号修复（以及相关 `.gitignore` 变更）。
2. 既有功能单独成 PR，便于针对分段下载与完整性逻辑做专门审查。

拆分可用 `git` 从 `8c4461a` 中挑选相应改动完成，我可以代为执行。
