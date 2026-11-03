/**
 * 浏览器 mock 桥：仅用于 ?mock=1 / VITE_MOCK=1 视觉与交互验证。
 * 模拟 IPC 延迟、21 个命令、5 个事件与非确定性进度推送；不参与 Tauri 生产构建路径。
 */

import type {
  AppEventHandlers,
  AppSnapshot,
  CancelDownloadArgs,
  DeleteLocalFileArgs,
  DownloadTask,
  GetRepoDetailArgs,
  ListRevisionsArgs,
  LocalFile,
  OpenPathArgs,
  RemoveTasksArgs,
  RepoSearchPage,
  RevisionList,
  SaveSettingsArgs,
  SearchReposArgs,
  Settings,
  StartDownloadsArgs,
  TaskIdArgs,
  TestConnectionArgs,
} from '../types'
import { defaultRevisionFor } from '../lib/format'
import {
  classifyRepoPath,
  createMockLibrary,
  createMockSettings,
  createMockTasks,
  createMultiRootLibrary,
  createStressLibrary,
  createStressTasks,
  getMockRepoDetail,
  getMockRevisions,
  mockFinalPath,
  MOCK_APP_VERSION,
  MOCK_DATA_DIR,
  MOCK_DEFAULT_DOWNLOAD_DIR,
  MOCK_HF_ENDPOINT,
  MOCK_LIBRARY_ROOT_2,
  MOCK_LIBRARY_ROOT_3,
  MOCK_MS_ENDPOINT,
  MOCK_REPOS,
} from './fixtures'

const MB = 1024 * 1024
const TICK_MS = 650
const TERMINAL = new Set<DownloadTask['status']>(['completed', 'error', 'cancelled'])

/** 验收辅助：记录最近 mock 调用（供 Edge/CDP 断言 payload，如 revision / 设置字段）。 */
export interface MockCallRecord {
  command: string
  args?: Record<string, unknown>
  at: number
}

declare global {
  interface Window {
    __MDM_MOCK_CALLS__?: MockCallRecord[]
  }
}

function recordMockCall(
  command: string,
  args?: Record<string, unknown>,
): void {
  if (typeof window === 'undefined') return
  const log = (window.__MDM_MOCK_CALLS__ ??= [])
  log.push({ command, args: args ? clone(args) : undefined, at: Date.now() })
  if (log.length > 120) log.splice(0, log.length - 120)
}

export interface MockBridge {
  invoke<Result>(command: string, args?: Record<string, unknown>): Promise<Result>
  subscribe(handlers: AppEventHandlers): Promise<() => void>
  pickDirectory(currentPath?: string): Promise<string | null>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function normalizeSettings(input: Settings): Settings {
  const cleanEndpoint = (value: string, fallback: string): string => {
    const trimmed = (value ?? '').trim().replace(/\/+$/, '')
    return trimmed || fallback
  }
  const concurrency = Math.min(8, Math.max(1, Math.round(input.concurrency || 3)))
  const maxRetries = Math.min(10, Math.max(0, Math.round(input.maxRetries ?? 3)))
  const theme: Settings['theme'] =
    input.theme === 'light' || input.theme === 'dark' || input.theme === 'system'
      ? input.theme
      : 'system'
  const connectionsPerFile = Math.min(
    8,
    Math.max(1, Math.round(input.connectionsPerFile ?? 4)),
  )
  // 契约：libraryRoots 允许 0..=8，去重并规范化（去除尾部斜杠、忽略大小写重复、排除 downloadDir）。
  const downloadDir =
    (input.downloadDir ?? '').trim().replace(/[\\/]+$/, '') || MOCK_DEFAULT_DOWNLOAD_DIR
  const seenRoots = new Set<string>([downloadDir.toLowerCase()])
  const libraryRoots: string[] = []
  for (const raw of Array.isArray(input.libraryRoots) ? input.libraryRoots : []) {
    if (typeof raw !== 'string') continue
    const root = raw.trim().replace(/[\\/]+$/, '')
    if (!root) continue
    const key = root.toLowerCase()
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    libraryRoots.push(root)
    if (libraryRoots.length >= 8) break
  }
  return {
    downloadDir,
    hfToken: (input.hfToken ?? '').trim(),
    msToken: (input.msToken ?? '').trim(),
    hfEndpoint: cleanEndpoint(input.hfEndpoint, MOCK_HF_ENDPOINT),
    msEndpoint: cleanEndpoint(input.msEndpoint, MOCK_MS_ENDPOINT),
    proxy: (input.proxy ?? '').trim(),
    concurrency,
    bandwidthLimit: Math.max(0, Math.round(input.bandwidthLimit ?? 0)),
    maxRetries,
    autoResume: Boolean(input.autoResume),
    theme,
    closeToTray: Boolean(input.closeToTray),
    notificationsEnabled: Boolean(input.notificationsEnabled),
    connectionsPerFile,
    libraryRoots,
  }
}

export function createMockBridge(): MockBridge {
  const params = (() => {
    try {
      return new URLSearchParams(window.location.search)
    } catch {
      return new URLSearchParams()
    }
  })()
  // ?mock=1&empty=1 用于验证空状态（本地库为空、搜索无结果）。
  const emptyFixture = params.get('empty') === '1'
  // ?mock=1&fast=1 让进行中的下载在数秒内完成，用于验证完成 Toast / 状态栏播报。
  const fastFixture = params.get('fast') === '1'
  // ?mock=1&multiroot=1 模拟多扫描根：settings.libraryRoots 预置 2 个附加根 + 对应文件。
  const multiRootFixture = params.get('multiroot') === '1'
  // ?mock=1&refsFail=1 模拟 list_revisions 失败（验证「分支/标签加载失败仍可自定义」降级）。
  const revisionsFailFixture = params.get('refsFail') === '1'
  // ?mock=1&legacy=1 模拟旧版后端/旧数据：snapshot 任务缺 revision、settings 缺 v0.2 字段、
  // 库文件缺 rootDir（验证前端默认值与兼容显示，不崩溃）。
  const legacyFixture = params.get('legacy') === '1'

  let settings: Settings = createMockSettings()
  if (multiRootFixture) {
    settings = {
      ...settings,
      libraryRoots: [MOCK_LIBRARY_ROOT_2, MOCK_LIBRARY_ROOT_3],
    }
  }
  let tasks: DownloadTask[] = createMockTasks(settings)
  let library: LocalFile[] = multiRootFixture
    ? [...createMockLibrary(settings), ...createMultiRootLibrary(settings)]
    : createMockLibrary(settings)

  // ?mock=1&biglibrary=1 追加 500+ 文件压力数据，用于验证窗口化渲染。
  if (params.get('biglibrary') === '1') {
    library = [...library, ...createStressLibrary(settings)]
  }
  // ?mock=1&bigtasks=1 追加 320 条已完成任务，用于验证下载列表渲染上限。
  if (params.get('bigtasks') === '1') {
    tasks = [...tasks, ...createStressTasks(settings)]
  }

  let handlers: AppEventHandlers | null = null
  let timer: number | null = null
  let lastTick = Date.now()
  let directoryCalls = 0

  const speedSeeds = new Map<string, number>()
  for (const task of tasks) {
    speedSeeds.set(task.taskId, task.speed || Math.round(18 * MB + Math.random() * 30 * MB))
  }

  /* ------------------------------ 事件发送 ------------------------------ */

  function emitTask(task: DownloadTask): void {
    handlers?.onTaskUpdated(clone(task))
  }

  function emitProgress(task: DownloadTask): void {
    handlers?.onProgress({
      taskId: task.taskId,
      downloaded: task.downloaded,
      totalSize: task.totalSize,
      speed: task.speed,
    })
  }

  function emitRemoved(taskIds: string[]): void {
    if (taskIds.length > 0) handlers?.onTasksRemoved([...taskIds])
  }

  function emitSettings(): void {
    handlers?.onSettingsUpdated(clone(settings))
  }

  /* ------------------------------ 调度模拟 ------------------------------ */

  function appendLibraryEntry(task: DownloadTask): void {
    if (library.some((file) => file.path === task.savePath)) return
    const rootDir = settings.downloadDir.replace(/[\\/]+$/, '')
    const entry: LocalFile = {
      path: task.savePath,
      name: task.fileName,
      size: task.totalSize > 0 ? task.totalSize : task.downloaded,
      modifiedAt: Date.now(),
      source: task.source,
      repoId: task.repoId,
      kind: classifyRepoPath(task.savePath),
      rootDir,
    }
    library = [entry, ...library]
  }

  function completeTask(task: DownloadTask): void {
    task.status = 'completed'
    if (task.totalSize > 0) task.downloaded = task.totalSize
    task.speed = 0
    task.error = undefined
    task.completedAt = Date.now()
    emitProgress(task)
    emitTask(task)
    appendLibraryEntry(task)
  }

  function pickSpeed(task: DownloadTask): number {
    const seeded = speedSeeds.get(task.taskId)
    if (seeded) return seeded
    const next = Math.round((16 + Math.random() * 34) * MB)
    speedSeeds.set(task.taskId, next)
    return next
  }

  function pumpQueue(): void {
    if (!handlers) return
    const activeCount = tasks.filter(
      (task) => task.status === 'active' || task.status === 'pausing',
    ).length
    let slots = Math.max(0, settings.concurrency - activeCount)
    if (slots === 0) return
    const queued = tasks
      .filter((task) => task.status === 'queued')
      .sort((a, b) => a.addedAt - b.addedAt)
    for (const task of queued) {
      if (slots <= 0) break
      slots -= 1
      task.status = 'active'
      task.speed = pickSpeed(task)
      emitTask(task)
    }
  }

  function tick(): void {
    if (!handlers) return
    const now = Date.now()
    const seconds = Math.min(2, Math.max(0.2, (now - lastTick) / 1000))
    lastTick = now
    for (const task of tasks) {
      if (task.status !== 'active') continue
      const base = pickSpeed(task)
      task.speed = Math.round(base * (0.82 + Math.random() * 0.36))
      if (task.totalSize > 0) {
        // fast 模式（?fast=1）按比例推进，使任务在数次 tick 内完成，便于 UI 验收。
        const step = fastFixture
          ? Math.max(Math.round(task.totalSize * 0.34), Math.round(task.speed * seconds))
          : Math.round(task.speed * seconds)
        task.downloaded = Math.min(task.totalSize, task.downloaded + step)
        if (task.downloaded >= task.totalSize) {
          completeTask(task)
          continue
        }
      } else {
        task.downloaded += Math.round(task.speed * seconds)
      }
      emitProgress(task)
    }
    pumpQueue()
  }

  function ensureTimer(): void {
    if (timer != null) return
    lastTick = Date.now()
    timer = window.setInterval(tick, TICK_MS)
  }

  function stopTimer(): void {
    if (timer == null) return
    window.clearInterval(timer)
    timer = null
  }

  function schedulePause(task: DownloadTask): void {
    if (task.status !== 'active' && task.status !== 'pausing') return
    task.status = 'pausing'
    task.speed = 0
    emitTask(task)
    window.setTimeout(() => {
      if (task.status === 'pausing') {
        task.status = 'paused'
        emitTask(task)
      }
    }, 480)
  }

  function findTask(taskId: string): DownloadTask {
    const task = tasks.find((item) => item.taskId === taskId)
    if (!task) throw new Error('任务不存在或已被移除，请刷新后重试。')
    return task
  }

  /* ------------------------------- 命令实现 ----------------------------- */

  async function invoke<Result>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<Result> {
    recordMockCall(command, args)
    await delay(110 + Math.random() * 180)
    const result = (value: unknown): Result => value as Result

    switch (command) {
      case 'get_snapshot': {
        const snapshot: AppSnapshot = {
          tasks: clone(tasks),
          settings: clone(settings),
          appVersion: MOCK_APP_VERSION,
          dataDir: MOCK_DATA_DIR,
          defaultDownloadDir: MOCK_DEFAULT_DOWNLOAD_DIR,
        }
        if (legacyFixture) {
          // 模拟旧后端：任务缺 revision；settings 缺 v0.2 新字段（前端应回退默认值）。
          snapshot.tasks = snapshot.tasks.map((task) => {
            const legacyTask = { ...task } as Partial<DownloadTask>
            delete legacyTask.revision
            return legacyTask as DownloadTask
          })
          const legacySettings = { ...snapshot.settings } as Partial<Settings>
          delete legacySettings.connectionsPerFile
          delete legacySettings.libraryRoots
          snapshot.settings = legacySettings as Settings
        }
        return result(snapshot)
      }

      case 'search_repos': {
        if (emptyFixture) {
          return result({ items: [], hasMore: false } satisfies RepoSearchPage)
        }
        const { source, query, page = 1, limit = 20 } =
          args as unknown as SearchReposArgs
        const keyword = (query ?? '').trim().toLowerCase()
        const matched = MOCK_REPOS.filter((repo) => {
          if (repo.source !== source) return false
          if (!keyword) return true
          return (
            repo.id.toLowerCase().includes(keyword) ||
            repo.tags.some((tag) => tag.toLowerCase().includes(keyword)) ||
            (repo.pipelineTag ?? '').toLowerCase().includes(keyword)
          )
        }).sort((a, b) => b.downloads - a.downloads)
        const pageSize = Math.max(1, Math.min(50, Math.round(limit) || 20))
        const safePage = Math.max(1, Math.round(page) || 1)
        const start = (safePage - 1) * pageSize
        const items = matched.slice(start, start + pageSize)
        const hasMore = start + pageSize < matched.length
        const response: RepoSearchPage = {
          items: clone(items),
          hasMore,
          nextCursor:
            source === 'huggingface' && hasMore ? String(safePage + 1) : undefined,
        }
        return result(response)
      }

      case 'get_repo_detail': {
        const { source, repoId, revision } = args as unknown as GetRepoDetailArgs
        return result(clone(getMockRepoDetail(source, repoId, revision)))
      }

      case 'list_revisions': {
        const { source, repoId } = args as unknown as ListRevisionsArgs
        if (revisionsFailFixture) {
          throw new Error('无法获取分支/标签：HTTP 500（mock 故障注入）')
        }
        const revisions: RevisionList = getMockRevisions(source, repoId)
        return result(clone(revisions))
      }

      case 'start_downloads': {
        const { requests } = args as unknown as StartDownloadsArgs
        const created: DownloadTask[] = []
        const now = Date.now()
        for (const request of requests ?? []) {
          const savePath = mockFinalPath(
            request.saveDir,
            request.repoId,
            request.remotePath,
          )
          const duplicated = tasks.some(
            (task) =>
              task.source === request.source &&
              task.repoId === request.repoId &&
              task.remotePath === request.remotePath &&
              task.savePath === savePath,
          )
          if (duplicated) continue
          const task: DownloadTask = {
            taskId: `mock-new-${now.toString(36)}-${created.length}-${Math.random()
              .toString(36)
              .slice(2, 6)}`,
            source: request.source,
            repoId: request.repoId,
            remotePath: request.remotePath,
            fileName: request.remotePath.split('/').pop() ?? request.remotePath,
            savePath,
            tempPath: `${savePath}.part`,
            totalSize: request.size,
            downloaded: 0,
            status: 'queued',
            speed: 0,
            retries: 0,
            revision: request.revision?.trim() || defaultRevisionFor(request.source),
            addedAt: now + created.length,
          }
          tasks.push(task)
          created.push(task)
        }
        if (created.length > 0) {
          window.setTimeout(() => {
            for (const task of created) emitTask(task)
            pumpQueue()
          }, 120)
        }
        return result(clone(created))
      }

      case 'pause_download': {
        const { taskId } = args as unknown as TaskIdArgs
        const task = findTask(taskId)
        if (terminalTask(task)) throw new Error('该任务已结束，无法暂停。')
        if (task.status === 'queued') {
          task.status = 'paused'
          emitTask(task)
        } else {
          schedulePause(task)
        }
        return result(undefined)
      }

      case 'resume_download': {
        const { taskId } = args as unknown as TaskIdArgs
        const task = findTask(taskId)
        if (task.status === 'completed' || task.status === 'active') {
          throw new Error('该任务当前状态无需继续。')
        }
        task.status = 'queued'
        task.error = undefined
        task.speed = 0
        emitTask(task)
        return result(undefined)
      }

      case 'pause_all': {
        for (const task of tasks) {
          if (task.status === 'queued') {
            task.status = 'paused'
            emitTask(task)
          } else if (task.status === 'active' || task.status === 'pausing') {
            schedulePause(task)
          }
        }
        return result(undefined)
      }

      case 'resume_all': {
        for (const task of tasks) {
          if (
            task.status === 'paused' ||
            task.status === 'error' ||
            task.status === 'cancelled'
          ) {
            task.status = 'queued'
            task.error = undefined
            task.speed = 0
            emitTask(task)
          }
        }
        return result(undefined)
      }

      case 'cancel_download': {
        const { taskId, deletePartial } = args as unknown as CancelDownloadArgs
        const task = findTask(taskId)
        if (terminalTask(task)) throw new Error('该任务已结束，无法取消。')
        task.status = 'cancelled'
        task.speed = 0
        task.downloaded = deletePartial ? 0 : task.downloaded
        emitTask(task)
        return result(undefined)
      }

      case 'retry_download': {
        const { taskId } = args as unknown as TaskIdArgs
        const task = findTask(taskId)
        if (task.status !== 'error') throw new Error('只有失败的任务可以重试。')
        task.status = 'queued'
        task.error = undefined
        task.speed = 0
        emitTask(task)
        return result(undefined)
      }

      case 'remove_tasks': {
        const { taskIds } = args as unknown as RemoveTasksArgs
        const removable = new Set(
          tasks
            .filter((task) => taskIds?.includes(task.taskId) && terminalTask(task))
            .map((task) => task.taskId),
        )
        tasks = tasks.filter((task) => !removable.has(task.taskId))
        emitRemoved([...removable])
        return result(undefined)
      }

      case 'clear_finished': {
        const removed = tasks.filter(terminalTask).map((task) => task.taskId)
        tasks = tasks.filter((task) => !terminalTask(task))
        emitRemoved(removed)
        return result(undefined)
      }

      case 'get_settings':
        return result(clone(settings))

      case 'save_settings': {
        const { settings: incoming } = args as unknown as SaveSettingsArgs
        settings = normalizeSettings(incoming)
        emitSettings()
        return result(clone(settings))
      }

      case 'scan_library': {
        if (emptyFixture) return result([])
        const sorted = [...library].sort((a, b) => b.modifiedAt - a.modifiedAt)
        const payload = legacyFixture
          ? sorted.map((file) => {
              const legacyFile = { ...file } as Partial<LocalFile>
              delete legacyFile.rootDir
              return legacyFile as LocalFile
            })
          : sorted
        return result(clone(payload))
      }

      case 'open_path': {
        const { path } = args as unknown as OpenPathArgs
        if (!path) throw new Error('路径为空，无法打开。')
        return result(undefined)
      }

      case 'delete_local_file': {
        const { path, removeTask } = args as unknown as DeleteLocalFileArgs
        const before = library.length
        library = library.filter((file) => file.path !== path)
        if (library.length === before) {
          throw new Error('文件不存在或已被删除，请刷新后重试。')
        }
        if (removeTask) {
          const removed = tasks
            .filter((task) => task.savePath === path)
            .map((task) => task.taskId)
          if (removed.length > 0) {
            tasks = tasks.filter((task) => !removed.includes(task.taskId))
            emitRemoved(removed)
          }
        }
        return result(undefined)
      }

      case 'test_connection': {
        const { source } = args as unknown as TestConnectionArgs
        await delay(600)
        if (source === 'huggingface') {
          if (!/^https?:\/\//.test(settings.hfEndpoint)) {
            throw new Error('连接失败：HuggingFace 端点 URL 无效，请填写 http(s) 地址。')
          }
          return result(
            `连接成功：${settings.hfEndpoint} 可用，测试仓库 Qwen/Qwen2.5-0.5B-Instruct 的文件列表已获取（共 14 个文件）。`,
          )
        }
        if (!/^https?:\/\//.test(settings.msEndpoint)) {
          throw new Error('连接失败：ModelScope 端点 URL 无效，请填写 http(s) 地址。')
        }
        return result(
          `连接成功：${settings.msEndpoint} 可用，测试仓库 Qwen/Qwen2.5-0.5B-Instruct 的文件列表已获取（共 14 个文件）。`,
        )
      }

      case 'get_default_download_dir':
        return result(MOCK_DEFAULT_DOWNLOAD_DIR)

      case 'open_data_dir':
        return result(undefined)

      default:
        throw new Error(`mock 模式未实现的命令：${command}`)
    }
  }

  function terminalTask(task: DownloadTask): boolean {
    return TERMINAL.has(task.status)
  }

  async function subscribe(next: AppEventHandlers): Promise<() => void> {
    handlers = next
    ensureTimer()
    // 浏览器里无法真正“关闭窗口隐藏到托盘”，提供 mock 触发点供 UI/验收脚本验证 Toast：
    //   window.dispatchEvent(new CustomEvent('mock:window-hidden-to-tray'))
    const trayListener = () => {
      handlers?.onWindowHiddenToTray({})
    }
    window.addEventListener('mock:window-hidden-to-tray', trayListener)
    return () => {
      window.removeEventListener('mock:window-hidden-to-tray', trayListener)
      if (handlers === next) {
        handlers = null
        stopTimer()
      }
    }
  }

  async function pickDirectory(currentPath?: string): Promise<string | null> {
    await delay(320)
    const candidates = [
      'D:\\AI\\Models',
      MOCK_DEFAULT_DOWNLOAD_DIR,
      `${(currentPath ?? MOCK_DEFAULT_DOWNLOAD_DIR).replace(/[\\/]+$/, '')}\\Models-2`,
    ]
    const picked = candidates[directoryCalls % candidates.length]
    directoryCalls += 1
    return picked
  }

  return { invoke, subscribe, pickDirectory }
}
