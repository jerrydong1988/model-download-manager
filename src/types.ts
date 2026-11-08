/**
 * IPC 契约镜像（唯一事实来源：docs/IPC-CONTRACT.md）。
 *
 * 规则：
 * - 所有字段均为 camelCase；
 * - 文件大小：字节；时间戳：Unix 毫秒；
 * - 本文件只放类型，运行时常量放在 lib/labels.ts。
 */

export type Source = 'huggingface' | 'modelscope'
export type FileKind = 'weight' | 'mmproj' | 'imatrix' | 'config' | 'other'
/** v0.1.3：界面主题设置（system = 跟随系统；实际生效主题由 theme.ts 解析） */
export type ThemeSetting = 'light' | 'dark' | 'system'
export type TaskStatus =
  | 'queued'
  | 'active'
  | 'pausing'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

/** 下载完成后的内容校验。旧任务缺省为无校验和。 */
export type VerifyStatus = 'unavailable' | 'pending' | 'verified' | 'mismatch'

/** 应用设置（命令 13-14 / 事件 settings-updated） */
export interface Settings {
  /** 绝对路径；默认 %USERPROFILE%\Documents\Models */
  downloadDir: string
  /** 可空；HuggingFace User Access Token */
  hfToken: string
  /** 可空；ModelScope SDK Token */
  msToken: string
  /** 默认 "https://huggingface.co"；可填镜像 "https://hf-mirror.com" */
  hfEndpoint: string
  /** 默认 "https://www.modelscope.cn" */
  msEndpoint: string
  /** 例如 "http://127.0.0.1:7890"；空 = 走系统环境变量 */
  proxy: string
  /** 1..=8，默认 3 */
  concurrency: number
  /** 字节/秒，0 = 不限速，默认 0 */
  bandwidthLimit: number
  /** 0..=10，默认 3 */
  maxRetries: number
  /** 启动时自动继续未完成任务，默认 true */
  autoResume: boolean
  /** v0.1.3 新增：界面主题，默认 "system"（跟随系统） */
  theme: ThemeSetting
  /** v0.1.3 新增：关闭窗口时隐藏到托盘继续后台下载，默认 true */
  closeToTray: boolean
  /** v0.1.3 新增：下载完成/失败时发送 Windows 系统通知，默认 true */
  notificationsEnabled: boolean
  /** v0.2.0 新增：单文件下载连接数（HTTP Range 分段并行），1..=8，默认 4 */
  connectionsPerFile: number
  /** v0.2.0 新增：本地库附加扫描根目录（绝对路径数组）；空 = 仅扫描 downloadDir */
  libraryRoots: string[]
}

/** 仓库搜索结果条目（命令 2） */
export interface RepoSummary {
  /** "Qwen/Qwen2.5-7B-Instruct" / "org/model" */
  id: string
  source: Source
  downloads: number
  likes: number
  /** ISO8601 或原样字符串 */
  lastModified?: string
  tags: string[]
  pipelineTag?: string
  /** 是否需要授权（HF） */
  gated?: boolean
}

/** 搜索分页（命令 2） */
export interface RepoSearchPage {
  items: RepoSummary[]
  hasMore: boolean
  /** 不透明分页游标；仅 HF 使用 */
  nextCursor?: string
}

/** 仓库文件（命令 3） */
export interface RepoFile {
  /** 仓库内相对路径，如 "model-00001-of-00004.safetensors" */
  path: string
  /** 文件名（path 的最后一段） */
  name: string
  /** 字节；未知为 0 */
  size: number
  /** 后端按扩展名分类 */
  kind: FileKind
  /** 内容 sha256（小写十六进制）；没有远端校验和时省略 */
  sha256?: string
}

/** 仓库详情（命令 3） */
export interface RepoDetail {
  id: string
  source: Source
  /** HF 默认 "main"，ModelScope 默认 "master" */
  revision: string
  files: RepoFile[]
  /** 所有文件 size 之和 */
  totalSize: number
  downloads: number
  likes: number
  lastModified?: string
  tags: string[]
  gated?: boolean
  license?: string
}

/** 下载任务（命令 4-12 / 事件） */
export interface DownloadTask {
  /** Backend mutation sequence; absent in legacy/mock events. */
  updateSeq?: number
  taskId: string
  source: Source
  repoId: string
  /** 仓库内相对路径 */
  remotePath: string
  fileName: string
  /** 最终文件绝对路径 */
  savePath: string
  /** 未完成临时文件绝对路径（<savePath>.part） */
  tempPath: string
  /** 远端大小（来自列表/响应头），未知为 0 */
  totalSize: number
  /** 已下载字节（含续传历史） */
  downloaded: number
  status: TaskStatus
  /** 当前速度 字节/秒（仅 active 有意义，其他为 0） */
  speed: number
  error?: string
  /** 已重试次数 */
  retries: number
  /** v0.2.0：下载使用的仓库 revision（HF 默认 main / MS 默认 master） */
  revision: string
  addedAt: number
  completedAt?: number
  /** 断点续传校验 */
  etag?: string
  lastModified?: string
  /** 期望的内容 sha256 */
  sha256?: string
  /** 完成后的校验结果；缺省表示无校验和 */
  verifyStatus?: VerifyStatus
}

/** 下载请求（命令 4） */
export interface DownloadRequest {
  source: Source
  repoId: string
  remotePath: string
  /** 仓库列表中的大小；0 表示未知 */
  size: number
  /** 本次下载的根目录（Settings.downloadDir 或用户临时指定） */
  saveDir: string
  /** v0.2.0：可空；缺省用来源默认 revision（HF main / MS master） */
  revision?: string
  /** 仓库列表中的 sha256；没有则省略 */
  sha256?: string
}

/** 目标目录所在卷的可用空间（命令 22） */
export interface DiskSpace {
  /** 调用方可使用的字节 */
  freeBytes: number
  totalBytes: number
  /** 盘符或 UNC 共享，如 `D:` */
  volume: string
}

/** 本地模型库文件（命令 15） */
export interface LocalFile {
  /** 绝对路径 */
  path: string
  name: string
  size: number
  /** Unix 毫秒 */
  modifiedAt: number
  /** 来自下载历史则填充 */
  source?: Source
  repoId?: string
  kind: FileKind
  /** v0.2.0：该文件所属扫描根目录（绝对路径） */
  rootDir: string
}

/** 启动快照（命令 1） */
export interface AppSnapshot {
  tasks: DownloadTask[]
  settings: Settings
  /** env!("CARGO_PKG_VERSION") */
  appVersion: string
  /** 应用数据目录（持久化文件所在） */
  dataDir: string
  defaultDownloadDir: string
}

/** 仓库可下载 revision 列表（命令 21 / v0.2.0） */
export interface RevisionList {
  source: Source
  repoId: string
  /** HF "main" / MS "master" */
  defaultRevision: string
  branches: string[]
  tags: string[]
}

/* ------------------------------------------------------------------ */
/* 命令参数                                                            */
/* ------------------------------------------------------------------ */

export interface SearchReposArgs {
  source: Source
  query: string
  /** 从 1 起 */
  page: number
  /** 1..=50，默认 20 */
  limit: number
  cursor?: string
}

export interface GetRepoDetailArgs {
  source: Source
  repoId: string
  revision?: string
}

export interface StartDownloadsArgs {
  requests: DownloadRequest[]
}

export interface TaskIdArgs {
  taskId: string
}

export interface CancelDownloadArgs {
  taskId: string
  deletePartial: boolean
}

export interface RemoveTasksArgs {
  taskIds: string[]
}

export interface SaveSettingsArgs {
  settings: Settings
}

export interface OpenPathArgs {
  path: string
  reveal: boolean
}

export interface DeleteLocalFileArgs {
  path: string
  removeTask: boolean
}

export interface TestConnectionArgs {
  source: Source
}

/** v0.2.0：list_revisions 参数 */
export interface ListRevisionsArgs {
  source: Source
  repoId: string
}

/* ------------------------------------------------------------------ */
/* 事件 payload（后端 → 前端）                                         */
/* ------------------------------------------------------------------ */

/** download-progress：每任务限流 ≤ 4 次/秒 */
export interface DownloadProgressEvent {
  updateSeq?: number
  taskId: string
  downloaded: number
  totalSize: number
  speed: number
}

/** task-updated：任务状态/元数据变化 */
export interface TaskUpdatedEvent {
  task: DownloadTask
}

/** tasks-removed：remove_tasks / clear_finished 后 */
export interface TasksRemovedEvent {
  taskIds: string[]
}

/** settings-updated：save_settings 后（含钳制结果） */
export interface SettingsUpdatedEvent {
  settings: Settings
}

/**
 * window-hidden-to-tray（v0.1.3）：closeToTray=true 时关闭窗口拦截为隐藏到托盘，
 * 下载继续；前端弹 info 提示「已最小化到托盘，下载继续」。payload 为空对象。
 */
export type WindowHiddenToTrayEvent = Record<string, never>

/** 已挂载应用事件订阅集合 */
export interface AppEventHandlers {
  onProgress: (payload: DownloadProgressEvent) => void
  onTaskUpdated: (task: DownloadTask) => void
  onTasksRemoved: (taskIds: string[]) => void
  onSettingsUpdated: (settings: Settings) => void
  /** v0.1.3：窗口隐藏到托盘（后台继续下载） */
  onWindowHiddenToTray: (payload: WindowHiddenToTrayEvent) => void
}
