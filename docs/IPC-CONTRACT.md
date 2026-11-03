# IPC 契约（唯一事实来源）

> 所有 Rust 命令、事件、数据类型必须与本文件严格一致。前端 `src/types.ts` 与后端
> `src-tauri/src/models.rs` 是它的两份镜像实现。修改契约必须先改本文件，并通知 Team Lead。

## 1. 通用约定

- Tauri v2，命令参数使用 **camelCase**（前端 `invoke('cmd', { taskId })` ↔ Rust 参数 `#[tauri::command(rename_all = "camelCase")]` 或 serde 字段 rename）。
- 所有结构体 serde 输出 **camelCase**（`#[serde(rename_all = "camelCase")]`）。
- 时间戳：Unix 毫秒（`u64`）。
- 大小：字节（`u64`）。
- 命令失败统一返回 `Err(String)`，字符串是**给用户看的中文错误信息**（可带 HTTP 状态码），不得泄露 token。
- 命令成功且无数据时返回 `()`。

## 2. 基础类型

```ts
type Source = 'huggingface' | 'modelscope'
type FileKind = 'weight' | 'mmproj' | 'imatrix' | 'config' | 'other'
type TaskStatus = 'queued' | 'active' | 'pausing' | 'paused' | 'completed' | 'error' | 'cancelled'
```

`FileKind` 语义与中文展示：

| kind | 展示名 | 含义 |
|------|--------|------|
| `weight` | 权重 | 模型主权重（含 `.hgn` 等特殊格式、分片索引） |
| `mmproj` | 投影器 | 多模态投影文件（文件名含 `mmproj` 或 `clip` 词元，且为权重类扩展名） |
| `imatrix` | 权重矩阵 | 量化重要性矩阵（文件名含 `imatrix`） |
| `config` | 配置 | 配置、分词器、脚本、文档等文本资产 |
| `other` | 其他 | 图片/音频等杂项 |

### Settings

```ts
interface Settings {
  downloadDir: string        // 绝对路径；默认 %USERPROFILE%\Documents\Models
  hfToken: string            // 可空；HuggingFace User Access Token
  msToken: string            // 可空；ModelScope SDK Token
  hfEndpoint: string         // 默认 "https://hf-mirror.com"（实测国内官方站不可达，镜像可用）；可改回官方
  msEndpoint: string         // 默认 "https://www.modelscope.cn"
  proxy: string              // 例如 "http://127.0.0.1:7890"；空 = 走系统环境变量
  concurrency: number        // 1..=8，默认 3
  bandwidthLimit: number     // 字节/秒，0 = 不限速，默认 0
  maxRetries: number         // 0..=10，默认 3
  autoResume: boolean        // 启动时自动继续未完成任务，默认 true
  /** v0.1.3 新增：界面主题，默认 "system"（跟随系统） */
  theme: 'light' | 'dark' | 'system'
  /** v0.1.3 新增：关闭窗口时隐藏到托盘继续后台下载，默认 true */
  closeToTray: boolean
  /** v0.1.3 新增：下载完成/失败时发送 Windows 系统通知，默认 true */
  notificationsEnabled: boolean
  /** v0.2.0 新增：单文件下载连接数（HTTP Range 分段并行），1..=8，默认 4 */
  connectionsPerFile: number
  /** v0.2.0 新增：本地库附加扫描根目录（绝对路径数组）；空 = 仅扫描 downloadDir */
  libraryRoots: string[]
}
```

> 旧版本 `settings.json` 缺少新字段时按默认值补齐（serde default），无需迁移。
> `libraryRoots` 允许 0..=8 个绝对目录，去重并规范化；扫描时与 `downloadDir` 一起作为根（downloadDir 始终包含）。

### 后台运行与托盘（v0.1.3）

- 应用常驻托盘（Tauri tray-icon）。关闭主窗口时：`closeToTray=true` → 拦截关闭、隐藏窗口、**下载任务继续**并 emit `window-hidden-to-tray`；`closeToTray=false` → 暂停全部任务、落盘 `tasks.json`、正常退出。
- 托盘交互：左键单击显示并聚焦主窗口；右键菜单：`显示主窗口` / `暂停全部` / `继续全部` / `退出`。退出前暂停全部 + 落盘。
- 单实例：第二次启动（如快捷方式再次打开）只显示/聚焦已有窗口（`tauri-plugin-single-instance`）。
- 窗口隐藏期间事件仍由 WebView 接收（窗口是 hide 而非 destroy），重新显示时状态即为最新；`get_snapshot` 语义不变。
- 系统通知（`tauri-plugin-notification`，Rust 侧发送）：任务 `completed` → 「下载完成：{fileName}」；任务 `error` → 「下载失败：{fileName}」。受 `notificationsEnabled` 控制；窗口可见时同样发送（Windows 会聚合）。
- **通知点击跳转（v0.2.0）**：注册 `NotificationExt::on_action`；用户点击通知正文（`action_id == "tap"`）时显示并聚焦主窗口（Windows 仅在 toast 仍在屏幕时上报点击，属平台限制）。托盘左键点击一直有效。
- 托盘 tooltip 显示「模型下载管理器」；有运行中任务时显示「模型下载管理器 · N 个任务下载中」。


### RepoSummary / RepoSearchPage

```ts
interface RepoSummary {
  id: string                 // "Qwen/Qwen2.5-7B-Instruct" / "org/model"
  source: Source
  downloads: number
  likes: number
  lastModified?: string      // ISO8601 或原样字符串
  tags: string[]
  pipelineTag?: string
  gated?: boolean            // 是否需要授权（HF）
}

interface RepoSearchPage {
  items: RepoSummary[]
  hasMore: boolean
  nextCursor?: string        // 不透明分页游标；仅 HF 使用
}
```

### RepoDetail / RepoFile

```ts
interface RepoFile {
  path: string               // 仓库内相对路径，如 "model-00001-of-00004.safetensors"
  name: string               // 文件名（path 的最后一段）
  size: number               // 字节；未知为 0
  kind: FileKind             // 后端按扩展名分类
}

interface RepoDetail {
  id: string
  source: Source
  revision: string           // HF 默认 "main"，ModelScope 默认 "master"
  files: RepoFile[]
  totalSize: number          // 所有文件 size 之和
  downloads: number
  likes: number
  lastModified?: string
  tags: string[]
  gated?: boolean
  license?: string
}
```

分类规则（后端 `util::classify_file`，v0.1.2 起，按顺序判定）：

1. 取文件名（basename）转小写，取最后一段扩展名。
2. **权重类扩展名**集合：
   `safetensors, bin, pt, pth, gguf, gguf_file, hgn, onnx, onnx_data, ckpt, h5, msgpack,
   npy, npz, engine, tflite, mlmodel, ot, pkl, pickle, joblib, keras, nemo, sft, mindir, om, plan, dat`
   - `.safetensors.index.json` / `.bin.index.json` 虽以 `.json` 结尾，仍归 `weight`（先于配置判定）。
3. **名称规则（仅在扩展名属于权重类时生效，避免把 `README.md`、`convert_mmproj_to_gguf.py` 等配置/脚本误判）**：
   - 文件名按 `. - _ 空格` 切分出的词元包含 `mmproj` 或 `clip` → `mmproj`（多模态投影文件，如 `mmproj-Qwen3.8-Flash-Next-f16.gguf`、`clip_vision_model.safetensors`）
   - 词元包含 `imatrix` → `imatrix`（量化重要性矩阵，如 `imatrix_unsloth.gguf_file`）
4. 扩展名属于权重类 → `weight`（含 `.hgn` 等特殊格式）。
5. **配置类扩展名**：`json, yaml, yml, txt, md, model, tiktoken, py, jinja, cfg, ini, toml, spm, vocab` → `config`
6. 其余 → `other`（图片/音频等）

> 例：`qwen38-flash-next-mtp.hgn` → `weight`；`mmproj-Qwen3.8-Flash-Next-f16.gguf` → `mmproj`；
> `imatrix_unsloth.gguf_file` → `imatrix`；`mmproj_config.json` → `config`；`model.gguf` → `weight`。

### DownloadTask

```ts
interface DownloadTask {
  taskId: string
  source: Source
  repoId: string
  remotePath: string         // 仓库内相对路径
  fileName: string
  savePath: string           // 最终文件绝对路径
  tempPath: string           // 未完成临时文件绝对路径（<savePath>.part）
  totalSize: number          // 远端大小（来自列表/响应头），未知为 0
  downloaded: number         // 已下载字节（含续传历史）
  status: TaskStatus
  speed: number              // 当前速度 字节/秒（仅 active 有意义，其他为 0）
  error?: string
  retries: number            // 已重试次数
  /** v0.2.0：下载使用的仓库 revision（HF 默认 main / MS 默认 master） */
  revision: string
  addedAt: number
  completedAt?: number
  etag?: string              // 断点续传校验
  lastModified?: string
}
```

### DownloadRequest

```ts
interface DownloadRequest {
  source: Source
  repoId: string
  remotePath: string
  size: number               // 仓库列表中的大小；0 表示未知
  saveDir: string            // 本次下载的根目录（Settings.downloadDir 或用户临时指定）
  /** v0.2.0：可空；缺省用来源默认 revision（HF main / MS master） */
  revision?: string
}
```

### LocalFile（本地模型库）

```ts
interface LocalFile {
  path: string               // 绝对路径
  name: string
  size: number
  modifiedAt: number         // Unix 毫秒
  source?: Source            // 来自下载历史则填充
  repoId?: string
  kind: FileKind
  /** v0.2.0：该文件所属扫描根目录（绝对路径） */
  rootDir: string
}
```

### AppSnapshot

```ts
interface AppSnapshot {
  tasks: DownloadTask[]
  settings: Settings
  appVersion: string         // env!("CARGO_PKG_VERSION")
  dataDir: string            // 应用数据目录（持久化文件所在）
  defaultDownloadDir: string
}
```

## 3. 命令表

| # | 命令 | 参数 | 返回 | 说明 |
|---|------|------|------|------|
| 1 | `get_snapshot` | — | `AppSnapshot` | 前端启动时拉取全量状态 |
| 2 | `search_repos` | `{ source, query, page, limit, cursor? }` | `RepoSearchPage` | `page` 从 1 起；`limit` 1..=50 默认 20；HF 用 `cursor` 连续翻页，ModelScope 用 `page` |
| 3 | `get_repo_detail` | `{ source, repoId, revision? }` | `RepoDetail` | 文件列表；revision 缺省按来源默认 |
| 3b | `list_revisions` | `{ source, repoId }` | `RevisionList { branches: string[], tags: string[] }` | v0.2.0：HF 用 `/api/models/{repo}/refs` 返回分支/标签；ModelScope 尽力返回（失败给空数组），两源都允许 UI 自定义 revision 文本 |
| 4 | `start_downloads` | `{ requests: DownloadRequest[] }` | `DownloadTask[]` | 去重（同 source+repo+remotePath+最终路径已在队列中则复用），返回新建的任务 |
| 5 | `pause_download` | `{ taskId }` | `()` | active→pausing→paused；queued→paused |
| 6 | `resume_download` | `{ taskId }` | `()` | paused/error/cancelled→queued |
| 7 | `pause_all` | — | `()` | 所有 active/queued 暂停 |
| 8 | `resume_all` | — | `()` | 所有 paused/error/cancelled 重新入队 |
| 9 | `cancel_download` | `{ taskId, deletePartial }` | `()` | 停止并把状态置 `cancelled`；`deletePartial=true` 删除 part 文件 |
| 10 | `retry_download` | `{ taskId }` | `()` | error→queued，保留已下载字节 |
| 11 | `remove_tasks` | `{ taskIds: string[] }` | `()` | 仅允许删除终态任务记录（completed/error/cancelled） |
| 12 | `clear_finished` | — | `()` | 删除所有终态任务记录（不删文件） |
| 13 | `get_settings` | — | `Settings` | |
| 14 | `save_settings` | `{ settings: Settings }` | `Settings` | 校验/钳制后持久化并生效，返回生效值 |
| 15 | `scan_library` | — | `LocalFile[]` | 递归扫描 `downloadDir`（深度 ≤ 8，文件数 ≤ 20000），按修改时间倒序 |
| 16 | `open_path` | `{ path, reveal }` | `()` | `reveal=true` 在资源管理器中选中文件；否则打开目录/文件 |
| 17 | `delete_local_file` | `{ path, removeTask }` | `()` | 删除文件及其 `.part`/`.part.json`；`removeTask` 同时删除对应任务记录。**实现加严**：仅允许删除 `downloadDir` 内文件，且该文件不存在未终态任务 |
| 18 | `test_connection` | `{ source }` | `string` | 发起一次真实请求（例如查询 `Qwen/Qwen2.5-0.5B-Instruct` 的文件列表），返回中文成功信息或 `Err` |
| 19 | `get_default_download_dir` | — | `string` | |
| 20 | `open_data_dir` | — | `()` | 打开应用数据目录 |
| 21 | `list_revisions` | `{ source, repoId }` | `RevisionList` | v0.2.0：仓库可下载 revision 列表（HF refs；ModelScope 尽力） |

### RevisionList

```ts
interface RevisionList {
  source: Source
  repoId: string
  defaultRevision: string      // HF "main" / MS "master"
  branches: string[]           // 分支名
  tags: string[]               // 标签名
}
```


参数命名：前端调用 `invoke('start_downloads', { requests })`。Rust 侧必须使用
`#[tauri::command(rename_all = "camelCase")]` 或逐参数 `#[serde(rename)]` 保证 camelCase 匹配。

## 4. 事件表（后端 → 前端）

全部通过 `app.emit(name, payload)` 发送；前端 `listen()` 订阅。

| 事件 | payload | 时机 |
|------|---------|------|
| `download-progress` | `{ taskId, downloaded, totalSize, speed }` | 下载中，每任务限流 ≤ 4 次/秒 |
| `task-updated` | `{ task: DownloadTask }` | 任务状态/元数据变化（入队、开始、暂停、完成、失败、取消） |
| `tasks-removed` | `{ taskIds: string[] }` | `remove_tasks`/`clear_finished` 后 |
| `settings-updated` | `{ settings: Settings }` | `save_settings` 后（含钳制结果） |
| `window-hidden-to-tray` | `{}` | v0.1.3：关闭窗口但继续后台下载（隐藏到托盘）时触发；前端弹提示「已最小化到托盘，下载继续」 |

前端 reducers 必须幂等：同一 task 事件重复到达不应产生重复条目。

## 5. 下载引擎行为规范

> 版本说明：v0.1 的 `DownloadRequest` 不含 `revision` 字段，下载固定使用来源默认 revision
> （HF `main`、ModelScope `master`）；`get_repo_detail` 支持传入 `revision` 仅用于浏览。
> 后续扩展 revision 选择时需同步修改 `DownloadRequest`、`DownloadTask` 与 UI。

### 5.1 路径与文件

- 最终路径：
  - **默认 revision（HF `main` / MS `master`）**：`{saveDir}/{repoId 的安全形式}/{remotePath 的安全形式}`（与 v0.1.x 完全一致，保证历史任务/本地库路径不变）。
  - **非默认 revision**：`{saveDir}/{repoId}/{revision 的安全形式}/{remotePath}`，避免同一仓库不同分支/标签的同名文件互相覆盖；`revision` 按 `util::sanitize_segment` 净化。
  - `repoId` 中的 `/` 保留为目录分隔（即 `org/model` → `org/model`）。
- 临时文件：`{finalPath}.part`；元数据：`{finalPath}.part.json`（保存 etag/lastModified/total/repoId/remotePath；v0.2.0 分段下载额外保存 chunkSize/chunks）。
- 路径安全：拒绝 `..`、绝对路径、Windows 盘符、UNC 前缀、以分隔符开头的 `remotePath`；拒绝已存在的符号链接/junction（下载前检查每级父目录与目标文件）。
- 完成后：`fs::rename(temp, final)` 原子改名（同卷确保原子）；删除 `.part.json`。
- 若最终文件已存在且大小 == totalSize：标记 `completed`（不重复下载），发事件。

### 5.2 断点续传

1. 若 `.part` 存在，`resumeFrom = part.len()`。
2. 请求带 `Range: bytes={resumeFrom}-`。
3. 响应：
   - `206`：解析 `Content-Range`，要求 `start == resumeFrom`，`total` 以 Content-Range 的 `*/total` 为准（覆盖列表中的 size）；不匹配则视为远端已变：删除 part 从头再来一次（最多 1 次）。
   - **`200` 且带 `Content-Range`**（ModelScope 实测：`HTTP 200 + Content-Range: bytes 100-199/659 + Content-Length: 100`）：若 `start == resumeFrom` 且 total 合理 → 按续传成功处理（继续 append），不要截断。
   - `200` 无 `Content-Range`：服务器不支持 Range/远端已变 → 截断 part 从头写。
   - `416`：若 `Content-Range: bytes */N` 且 `N == resumeFrom`，说明已完整，走完成流程；否则删除 part 重试一次。
   - `401/403`：不可重试，提示检查 Token/授权。
   - `404`：不可重试，提示文件不存在。
   - `429/5xx`/网络错误：按 `maxRetries` 指数退避重试（1s, 2s, 4s… 上限 30s）。
4. 续传时校验 `.part.json` 中 etag/lastModified 与响应头一致；不一致则从头下载（删除 part）。
5. 流式写入：`tokio::fs::File` + `AsyncWriteExt`，每写一块调用限速器。

### 5.3 并发与限速

- 全局并发：同时 active 任务数 ≤ `settings.concurrency`；队列 FIFO。
- 限速：全局令牌桶（字节/秒），每个下载任务写入前扣减令牌；`bandwidthLimit == 0` 时跳过。令牌桶按 50ms 粒度补充，避免全局吞吐抖动。
- 每次设置变更立即生效（限速器/并发信号量读取最新 settings）。

### 5.4 暂停/取消

- 每个任务持有 `Arc<TaskControl> { cancelled: AtomicBool, paused: AtomicBool }`。
- 下载循环每读取一块检查 `paused`：置位则 flush、保存 `.part.json`、状态 `paused`、释放并发槽。
- `cancel`：置位后删除 `.part`/`.part.json`（当 `deletePartial`）、状态 `cancelled`。
- `pause_all` 对 queued 任务直接置 `paused`；active 任务异步转 `pausing` → `paused`（前端可见中间态）。

### 5.5 启动恢复

- 启动时读 `tasks.json`：`active/pausing` → `paused`；`queued` 保持 `queued`；若 `settings.autoResume == false` 则全部 `paused`。
- 下载器在 `setup` 中启动调度泵，`autoResume == true` 时自动跑 queued 任务。
- 写 `tasks.json` 采用「临时文件 + rename」原子写，每 2 秒或在状态终态时落盘。

### 5.6 重试语义

- 可重试：网络错误、超时、5xx、429、读写挂起。
- 不可重试：400 类（除 429）、401、403、404、本地磁盘满/权限错误、路径非法。
- 重试计数超过 `maxRetries` → `error`，错误信息中文可读。

### 5.7 进度事件

- 每 250ms 最多一次/任务（实现常量 `PROGRESS_INTERVAL=250ms`，即 ≤4 次/秒）；`totalSize` 未知（0）时前端显示不确定进度。
- 完成时先发 `download-progress`（downloaded=total）再 `task-updated`（completed）。

### 5.8 单文件多连接分段下载（v0.2.0）

实测单连接约 12.6 MB/s、4 连接聚合约 42 MB/s、8 连接聚合约 82 MB/s（ModelScope CDN 单连接限速），
因此默认启用单文件多连接分段下载：

- 设置项 `connectionsPerFile`（1..=8，默认 **4**）。任务实际连接数 = min(设置值, 可切分段数)；`1` 时走原有单流引擎。
- 支持条件：远端返回可用 `Content-Range`（206 或 ModelScope 的 200+Content-Range）且 total 已知；否则自动回退单流引擎（删除分段元数据，按 5.2 单流逻辑下载）。
- 分段策略：固定分块 `CHUNK_SIZE = 16 MiB`（最后一块可短），`chunks[i]` 记录已下载字节；连接池从「未完成的块」中领取任务（先到先得，避免长段拖尾）。
- 临时文件：首次分段前若 `.part` 是旧版单流文件（长度 < total 且无 `chunks` 元数据），将其视为**连续前缀**转换为分段进度（`floor(len/CHUNK_SIZE)` 块完成 + 边界块部分完成），随后 `set_len(total)` 预分配；保留断点，不重新下载。
- 写入：各连接使用独立文件句柄 `seek(offset) + write`；进度以全局原子计数聚合；限速令牌桶与暂停/取消检查与单流一致（每次读取块都检查）。
- 每个分块独立重试（指数退避，计入任务 `retries`）；单块非可重试错误（401/403/404）终止任务并保留 `.part`/元数据供恢复。
- 完成：全部块满 → `flush` + 删除 `.part.json` + 原子 rename（同 5.1）。
- 校验：分段请求必须校验 `Content-Range` 的 start 与块内偏移一致、total 与已知一致；远端 etag/lastModified 与元数据不一致 → 从头下载（删除 part/meta）。
- 进度事件语义不变；`downloaded` = 各块已完成字节之和（跨恢复累计）。
- 并发约束：全局并发槽仍按任务计（一个任务不论用几条连接只占一个槽）；文档提示总连接数 ≈ `concurrency × connectionsPerFile`。

## 6. 数据源 HTTP 接口（2026-11-03 实测，见 docs/api-contracts.md）

### HuggingFace

- 搜索：`GET {hfEndpoint}/api/models?search={q}&limit={n}&sort=downloads&direction=-1&full=true[&cursor=...]`
  - **必须带 `full=true`**，否则响应缺少 `gated` 与 `lastModified` 字段（实测）。
  - 需要 Token 时带 `Authorization: Bearer {hfToken}`（gated 仓库）。
  - 分页：响应头 `Link: <...>; rel="next"`。**镜像模式下 Link 中的 next URL 仍是官方 `huggingface.co` host**，因此校验规则为：host ∈ {当前 endpoint host, `huggingface.co`}、scheme https、path 以 `/api/` 开头；通过后必须把 origin 重写为当前 endpoint 再请求。
  - 实测返回字段：`id`、`downloads`、`likes`、`lastModified`、`tags`、`pipeline_tag`、`gated`、`private`。
- 仓库详情（可选，用于 RepoDetail 元数据）：`GET {hfEndpoint}/api/models/{repoId}` → 同名字段 + `cardData.license`。
- 文件列表：`GET {hfEndpoint}/api/models/{repoId}/tree/{revision}?recursive=true`，分页同上；`lfs.size` 优先于 `size`。
  - 实测大仓库（Qwen2.5-7B-Instruct）一次返回全部条目（14 个），无 Link；仍保留 Link 分页兜底。
- 下载：`GET {hfEndpoint}/{repoId}/resolve/{revision}/{remotePath}`，带 Token；跟随 307/302 到 CDN（reqwest 默认 10 跳）。
  - **实测镜像 hf-mirror.com**：小文件 resolve 先 307 到 `/api/resolve-cache/...` 再 200，带 Range 仍返回 200 全量（小文件不续传）；**LFS 大文件** 302 到 `cas-bridge.xethub.hf.co` 并正常返回 `206 + Content-Range`（可续传）。引擎两种分支都覆盖：200 无 Content-Range 从头写，206 续传。
- gated：401/403 时提示「该仓库需要授权：请在设置中填写 HuggingFace Token，并先在网页端同意许可协议」。

### ModelScope

- **搜索（实测可用、匿名）**：`PUT {msEndpoint}/api/v1/dolphin/models`，`Content-Type: application/json`，body：
  ```json
  {"PageSize":30,"PageNumber":1,"SortBy":"Default","Target":"","SingleCriterion":[],"Name":"Qwen","Criterion":[]}
  ```
  - `PageNumber` 从 1 起；`Name` 为空 = 浏览热门。
  - 响应：`{Code, Message, Success, Data:{Model:{Models:[...], TotalCount:N}}}`；`hasMore = PageNumber*PageSize < TotalCount`。
  - 条目映射：`id = Path + "/" + Name`（如 `Qwen/Qwen2.5-0.5B-Instruct`）、`downloads = Downloads`、`likes = Stars`、`lastModified = LastUpdatedTime`（Unix 秒 → ISO-8601）、`tags = Tags`、`pipelineTag = Tasks[0]`。
- **仓库详情（实测可用）**：`GET {msEndpoint}/api/v1/models/{repoId}` → `{Data:{Name, Path, Downloads, Stars, License, LicenseName, LastUpdatedTime, Tags, Libraries, ChineseName, Description, Visibility, ApprovalMode}}`。
- 文件列表：`GET {msEndpoint}/api/v1/models/{repoId}/repo/files?Recursive=true`，`Data.Files[]` 中 `Type == "blob"` 的条目，字段 `Name/Path/Size/Sha256/Revision/IsLFS`。
- 下载：`GET {msEndpoint}/models/{repoId}/resolve/{revision}/{remotePath}`，revision 默认 `master`；私有仓库带 `Authorization: Bearer {msToken}`。
  - **实测 Range 语义**：请求 `Range: bytes=100-199` → `HTTP 200` + `Content-Range: bytes 100-199/659` + `Content-Length: 100`（不是 206），引擎按上文 200+Content-Range 分支处理。
- 错误：`Success: false` 时用 `Message` 作为错误信息；私有/受限返回 `{"Code":10010101003,"Message":"user not logged in"}`（提示填写 Token）。

### 代理 / 镜像

- `http` client 构建：`reqwest::Client::builder()`，若 `settings.proxy` 非空则 `.proxy(reqwest::Proxy::all(...))`，否则默认读取环境变量；超时：连接 30s，无全局请求超时（大文件可能数小时）；`user_agent` 设为 `ModelDownloadManager/0.1 (+https://github.com/)`。
- 修改设置后重建 client（保存设置时重建）。
- `hfEndpoint` 必须是 http(s) 且 host 合法；拼接 URL 前去除尾部 `/`。

## 7. 持久化布局

`{appDataDir}`（Windows: `%APPDATA%\com.modeldownload.manager`）：
- `settings.json` — Settings（token 明文存本地文件，权限受限；UI 说明）
- `tasks.json` — `{ "version": 1, "tasks": DownloadTask[] }`
- `.lock` — 单实例写锁（fs2/advisory，可选）

下载目录默认：`%USERPROFILE%\Documents\Models`（不存在则创建）。

## 8. 安全要求

- 不在日志/事件中输出 token。
- 所有远端提供的字符串进入路径前必须净化；`remotePath` 仅允许相对路径与常规字符。
- 事件 payload 不包含绝对敏感路径以外的信息（savePath 允许）。
- 不实现任意 URL 下载（只允许两个来源 + 固定 URL 模板）。
