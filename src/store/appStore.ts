/**
 * 全局 zustand store。
 *
 * 任务采用「Map 幂等合并 + 稳定顺序」：任何重复的 task-updated / 重复调用都不会产生
 * 重复条目；事件订阅生命周期由 connectEvents() 返回的清理函数管理。
 */

import { create } from 'zustand'
import type {
  AppSnapshot,
  DownloadProgressEvent,
  DownloadTask,
  Settings,
  TaskStatus,
} from '../types'
import * as ipc from '../lib/ipc'
import { toErrorText } from '../lib/ipc'
import { defaultRevisionFor, formatBytes } from '../lib/format'

export type PageKey = 'browse' | 'downloads' | 'library' | 'settings'
export type ToastKind = 'success' | 'error' | 'info'
export type SnapshotStatus = 'idle' | 'loading' | 'ready' | 'error'
export type EventsStatus = 'idle' | 'connecting' | 'ready' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: string
  kind: ToastKind
  title: string
  description?: string
  /** v0.1.3：可选操作按钮（如「打开位置」「重试」），由 ui/Toasts 渲染。 */
  action?: ToastAction
}

interface AppState {
  page: PageKey
  tasks: DownloadTask[]
  settings: Settings | null
  appVersion: string
  dataDir: string
  defaultDownloadDir: string
  snapshotStatus: SnapshotStatus
  snapshotError: string | null
  lastSnapshotAt: number | null
  eventsStatus: EventsStatus
  eventsError: string | null
  toasts: ToastItem[]
  /** v0.1.3：状态栏节流播报（aria-live polite），如「已完成 2 个任务」。 */
  announcement: string
  /** 递增序号：即使文案相同也强制读屏重新播报。 */
  announcementSeq: number

  setPage: (page: PageKey) => void
  /** 拉取 get_snapshot；重复调用安全。force=true 时忽略 ready 缓存。 */
  loadSnapshot: (force?: boolean) => Promise<void>
  /** 注册 5 类后端事件；返回幂等清理函数。 */
  connectEvents: () => () => void
  applyProgress: (progress: DownloadProgressEvent) => void
  upsertTask: (task: DownloadTask) => void
  upsertTasks: (tasks: DownloadTask[]) => void
  removeTasks: (taskIds: string[]) => void
  setSettings: (settings: Settings) => void
  pushToast: (
    kind: ToastKind,
    title: string,
    description?: string,
    action?: ToastAction,
  ) => void
  dismissToast: (id: string) => void
  /** 写入节流后的状态栏播报文案。 */
  announceStatus: (message: string) => void
}

const PAGES: PageKey[] = ['browse', 'downloads', 'library', 'settings']

function isPageKey(value: string): value is PageKey {
  return (PAGES as string[]).includes(value)
}

function initialPage(): PageKey {
  if (typeof window === 'undefined') return 'browse'
  const fromHash = window.location.hash.replace(/^#\/?/, '')
  return isPageKey(fromHash) ? fromHash : 'browse'
}

/* ------------------------------------------------------------------ */
/* 任务合并                                                            */
/* ------------------------------------------------------------------ */
// 合并 / 状态防回退 / 进度自愈逻辑抽到纯函数模块（可 Node 单元测试）：
// src/lib/taskMerge.ts；线上 v0.1.3 的「active 被过期 queued 响应覆盖」问题即在此修复。
import { applyProgressToTask, mergeTaskLists, reconcileTaskSnapshot, type SnapshotMutation } from '../lib/taskMerge'

let snapshotJournal: SnapshotMutation[] | null = null
let snapshotSettings: Settings | null = null

/**
 * v0.2.0：旧版 tasks.json / 后端未升级时任务可能缺少 `revision`，
 * 统一按来源默认值补齐（HF main / MS master），保证历史暂停任务正常显示。
 */
function withDefaultRevision(task: DownloadTask): DownloadTask {
  if (task.revision && task.revision.trim()) return task
  return { ...task, revision: defaultRevisionFor(task.source) }
}

/**
 * v0.2.0：旧后端 / 旧 settings.json 可能缺少新字段，
 * 统一按契约默认值补齐（连接数 4、附加扫描根空），避免页面读取 undefined。
 */
function withSettingsDefaults(settings: Settings): Settings {
  return {
    ...settings,
    theme: settings.theme ?? 'system',
    closeToTray: settings.closeToTray ?? true,
    notificationsEnabled: settings.notificationsEnabled ?? true,
    connectionsPerFile:
      typeof settings.connectionsPerFile === 'number' ? settings.connectionsPerFile : 4,
    libraryRoots: Array.isArray(settings.libraryRoots) ? settings.libraryRoots : [],
  }
}

/* ------------------------------------------------------------------ */
/* 事件订阅会话                                                        */
/* ------------------------------------------------------------------ */

interface EventSession {
  disposed: boolean
  unlisten: (() => void) | null
}

let eventSession: EventSession | null = null

function disposeSession(session: EventSession): void {
  if (session.disposed) return
  session.disposed = true
  session.unlisten?.()
  session.unlisten = null
  if (eventSession === session) eventSession = null
}

function makeToast(
  kind: ToastKind,
  title: string,
  description?: string,
  action?: ToastAction,
): ToastItem {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return { id: `${Date.now()}-${random}`, kind, title, description, action }
}

/* ------------------------------------------------------------------ */
/* 完成/失败通知（P1-4）                                                */
/* ------------------------------------------------------------------ */
/*
 * 设计：
 * - 事件是「状态迁移」驱动，不是进度驱动：仅当同一 taskId 从非终态进入 completed/error
 *   时通知一次；重复事件、进度事件不会触发。
 * - 260ms 窗口内的完成/失败事件合并处理：≤3 条时逐条 Toast（带文件名 + 操作按钮），
 *   >3 条时聚合成 1 条避免一次下载多个分片时提示刷屏（Toast 视口最多同时 3 条）。
 * - 状态栏 aria-live 播报独立节流（≥2.2s 一次），聚合期间的完成/失败数量，只播报
 *   「已完成 N 个任务」，不播报进度。
 */

const NOTIFY_DEBOUNCE_MS = 260
const ANNOUNCE_MIN_INTERVAL_MS = 2200

interface NotifyQueue {
  completed: DownloadTask[]
  failed: DownloadTask[]
}

let notifyTimer: number | null = null
let notifyQueue: NotifyQueue = { completed: [], failed: [] }

let announceTimer: number | null = null
let announceLastAt = 0
let announceCompleted = 0
let announceFailed = 0

function isCompletion(from: TaskStatus | undefined, to: TaskStatus): boolean {
  if (to !== 'completed') return false
  return from !== undefined && from !== 'completed'
}

function isFailure(from: TaskStatus | undefined, to: TaskStatus): boolean {
  if (to !== 'error') return false
  return from !== undefined && from !== 'error'
}

function shortFileNames(tasks: DownloadTask[], max = 3): string {
  const names = tasks.slice(0, max).map((task) => task.fileName)
  const suffix = tasks.length > max ? ` 等 ${tasks.length} 个文件` : ''
  return `${names.join('、')}${suffix}`
}

function openTaskLocation(task: DownloadTask): void {
  const target = task.status === 'completed' ? task.savePath : task.tempPath
  void ipc.openPath(target, true).catch((error: unknown) => {
    useAppStore.getState().pushToast('error', '无法打开所在位置', toErrorText(error))
  })
}

function retryFailedTask(task: DownloadTask): void {
  void ipc.retryDownload(task.taskId).catch((error: unknown) => {
    useAppStore.getState().pushToast('error', '重试失败', toErrorText(error))
  })
}

/**
 * 单个任务完成/失败仍逐条 Toast（含文件名 + 操作按钮）；
 * 一次到达 ≤3 条时逐条展示，超过 3 条时聚合成 1 条避免刷屏（Toast 视口本身也限制 3 条）。
 */
const MAX_INDIVIDUAL_TOASTS = 3

function flushNotifications(): void {
  notifyTimer = null
  const { completed, failed } = notifyQueue
  notifyQueue = { completed: [], failed: [] }
  if (completed.length === 0 && failed.length === 0) return
  const state = useAppStore.getState()

  if (completed.length > 0 && completed.length <= MAX_INDIVIDUAL_TOASTS) {
    for (const task of completed) {
      const size = task.totalSize > 0 ? ` · ${formatBytes(task.totalSize)}` : ''
      state.pushToast('success', '下载完成', `${task.fileName}${size}`, {
        label: '打开位置',
        onClick: () => openTaskLocation(task),
      })
    }
  } else if (completed.length > MAX_INDIVIDUAL_TOASTS) {
    state.pushToast('success', `下载完成 ${completed.length} 个文件`, shortFileNames(completed))
  }

  if (failed.length > 0 && failed.length <= MAX_INDIVIDUAL_TOASTS) {
    for (const task of failed) {
      state.pushToast(
        'error',
        '下载失败',
        `${task.fileName}：${task.error ?? '未知错误'}。可在下载队列中重试。`,
        { label: '重试', onClick: () => retryFailedTask(task) },
      )
    }
  } else if (failed.length > MAX_INDIVIDUAL_TOASTS) {
    state.pushToast(
      'error',
      `${failed.length} 个任务下载失败`,
      `${shortFileNames(failed)}。可在下载队列中重试。`,
    )
  }
}

function queueNotification(completed: DownloadTask[], failed: DownloadTask[]): void {
  if (completed.length === 0 && failed.length === 0) return
  notifyQueue = {
    completed: [...notifyQueue.completed, ...completed],
    failed: [...notifyQueue.failed, ...failed],
  }
  if (notifyTimer != null) return
  notifyTimer = window.setTimeout(flushNotifications, NOTIFY_DEBOUNCE_MS)
}

function flushAnnouncement(): void {
  announceTimer = null
  const completed = announceCompleted
  const failed = announceFailed
  announceCompleted = 0
  announceFailed = 0
  if (completed === 0 && failed === 0) return
  announceLastAt = Date.now()
  const parts: string[] = []
  if (completed > 0) parts.push(`已完成 ${completed} 个任务`)
  if (failed > 0) parts.push(`${failed} 个任务下载失败`)
  useAppStore.getState().announceStatus(parts.join('，'))
}

function queueAnnouncement(completed: number, failed: number): void {
  if (completed === 0 && failed === 0) return
  announceCompleted += completed
  announceFailed += failed
  if (announceTimer != null) return
  const wait = Math.max(0, ANNOUNCE_MIN_INTERVAL_MS - (Date.now() - announceLastAt))
  announceTimer = window.setTimeout(flushAnnouncement, wait)
}

interface TransitionResult {
  completed: DownloadTask[]
  failed: DownloadTask[]
}

/** 对比新旧任务列表，找出进入 completed / error 终态的任务（幂等：重复事件不会重复通知）。 */
function collectTransitions(
  previous: DownloadTask[],
  incoming: DownloadTask[],
): TransitionResult {
  const result: TransitionResult = { completed: [], failed: [] }
  if (incoming.length === 0) return result
  const before = new Map(previous.map((task) => [task.taskId, task]))
  for (const task of incoming) {
    const from = before.get(task.taskId)?.status
    if (isCompletion(from, task.status)) result.completed.push(task)
    else if (isFailure(from, task.status)) result.failed.push(task)
  }
  return result
}

function notifyTransitions(transitions: TransitionResult): void {
  if (transitions.completed.length === 0 && transitions.failed.length === 0) return
  queueNotification(transitions.completed, transitions.failed)
  queueAnnouncement(transitions.completed.length, transitions.failed.length)
}

export const useAppStore = create<AppState>((set, get) => ({
  page: initialPage(),
  tasks: [],
  settings: null,
  appVersion: '',
  dataDir: '',
  defaultDownloadDir: '',
  snapshotStatus: 'idle',
  snapshotError: null,
  lastSnapshotAt: null,
  eventsStatus: 'idle',
  eventsError: null,
  toasts: [],
  announcement: '',
  announcementSeq: 0,

  setPage: (page) => set({ page }),

  loadSnapshot: async (force = false) => {
    const state = get()
    if (state.snapshotStatus === 'loading') return
    if (!force && state.snapshotStatus === 'ready') return
    set({ snapshotStatus: 'loading', snapshotError: null })
    const journal: SnapshotMutation[] = []
    snapshotJournal = journal
    snapshotSettings = null
    try {
      const snapshot: AppSnapshot = await ipc.getSnapshot()
      // 快照请求期间可能已有事件到达：保留现有任务中更新的版本。
      const merged = reconcileTaskSnapshot(
        snapshot.tasks.map(withDefaultRevision),
        journal,
      )
      set({
        tasks: merged,
        settings: withSettingsDefaults(snapshotSettings ?? snapshot.settings),
        appVersion: snapshot.appVersion,
        dataDir: snapshot.dataDir,
        defaultDownloadDir: snapshot.defaultDownloadDir,
        snapshotStatus: 'ready',
        snapshotError: null,
        lastSnapshotAt: Date.now(),
      })
    } catch (error) {
      set({ snapshotStatus: 'error', snapshotError: toErrorText(error) })
    } finally {
      snapshotJournal = null
      snapshotSettings = null
    }
  },

  connectEvents: () => {
    if (eventSession && !eventSession.disposed) {
      const active = eventSession
      return () => disposeSession(active)
    }
    const session: EventSession = { disposed: false, unlisten: null }
    eventSession = session
    set({ eventsStatus: 'connecting', eventsError: null })

    void ipc
      .subscribeAppEvents({
        onProgress: (payload) => get().applyProgress(payload),
        onTaskUpdated: (task) => get().upsertTask(task),
        onTasksRemoved: (taskIds) => get().removeTasks(taskIds),
        onSettingsUpdated: (settings) => get().setSettings(settings),
        onWindowHiddenToTray: () =>
          get().pushToast(
            'info',
            '已最小化到托盘',
            '下载将在后台继续；双击托盘图标可恢复窗口。',
          ),
      })
      .then((unlisten) => {
        if (session.disposed) {
          unlisten()
          return
        }
        session.unlisten = unlisten
        set({ eventsStatus: 'ready' })
        void get().loadSnapshot(true)
      })
      .catch((error: unknown) => {
        if (session.disposed) return
        set({ eventsStatus: 'error', eventsError: toErrorText(error) })
        void get().loadSnapshot()
      })

    return () => disposeSession(session)
  },

  applyProgress: (progress) => {
    snapshotJournal?.push({ kind: 'progress', progress })
    set((state) => {
      const index = state.tasks.findIndex((task) => task.taskId === progress.taskId)
      if (index === -1) return state
      const task = state.tasks[index]
      const nextTask = applyProgressToTask(task, progress)
      if (nextTask === task) return state
      const next = state.tasks.slice()
      next[index] = nextTask
      return { tasks: next }
    })
  },

  upsertTask: (task) => {
    const normalized = withDefaultRevision(task)
    snapshotJournal?.push({ kind: 'tasks', tasks: [normalized] })
    const previous = get().tasks
    const merged = mergeTaskLists(previous, [normalized])
    const transitions = collectTransitions(previous, merged)
    set({ tasks: merged })
    notifyTransitions(transitions)
  },

  upsertTasks: (tasks) => {
    const normalized = tasks.map(withDefaultRevision)
    snapshotJournal?.push({ kind: 'tasks', tasks: normalized })
    const previous = get().tasks
    const merged = mergeTaskLists(previous, normalized)
    const transitions = collectTransitions(previous, merged)
    set({ tasks: merged })
    notifyTransitions(transitions)
  },

  removeTasks: (taskIds) => {
    snapshotJournal?.push({ kind: 'remove', ids: taskIds })
    if (taskIds.length === 0) return
    set((state) => {
      const removing = new Set(taskIds)
      const next = state.tasks.filter((task) => !removing.has(task.taskId))
      return next.length === state.tasks.length ? state : { tasks: next }
    })
  },

  setSettings: (settings) => {
    if (snapshotJournal) snapshotSettings = settings
    set({ settings: withSettingsDefaults(settings) })
  },

  pushToast: (kind, title, description, action) => {
    set((state) => ({
      toasts: [...state.toasts, makeToast(kind, title, description, action)],
    }))
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },

  announceStatus: (message) => {
    set((state) => ({ announcement: message, announcementSeq: state.announcementSeq + 1 }))
  },
}))
