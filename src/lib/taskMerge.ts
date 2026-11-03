/**
 * 任务状态合并（纯函数，可在 Node 下直接单元测试）。
 *
 * 背景（v0.1.3 线上问题）：`start_downloads` 命令返回的是「排队中」快照，
 * 而调度泵可能在命令响应之前就发出 `task-updated(active)` 事件。若前端在收到
 * active 事件后又把命令响应 upsert 进 store，就会把状态覆盖回 queued，
 * 之后只剩进度事件（不再有状态事件），导致：
 *   - 任务实际在下载，但 UI 显示「排队中」/速度 0/进行中 0/等待空闲并发槽。
 *
 * 修复策略：
 * 1. mergeTask 拒绝「过期降级」：completed 为终态；active/pausing 不会被 queued 覆盖。
 * 2. applyProgressToTask 自愈：后端只对运行中的任务发进度事件，若 queued 任务收到
 *    前进的进度/速度，说明状态事件丢失，应恢复为 active。
 */
import type { DownloadProgressEvent, DownloadTask, TaskStatus } from '../types'

/** 是否为「过期快照导致的非法状态回退」，需要丢弃 incoming.status。 */
export function isStaleStatusRegression(previous: TaskStatus, incoming: TaskStatus): boolean {
  if (previous === incoming) return false
  // completed 是终态：除 redownload 流程外不存在 completed → 其他状态；UI 不使用该流程。
  if (previous === 'completed') return true
  // active / pausing 只能经由 paused/error/cancelled（不经过 queued 直接回退）或终态收尾。
  if (incoming === 'queued' && (previous === 'active' || previous === 'pausing')) return true
  return false
}

/** 合并同一任务的两份快照（incoming 覆盖 previous，但拒绝过期降级与进度回退）。 */
export function mergeTask(previous: DownloadTask, incoming: DownloadTask): DownloadTask {
  const status = isStaleStatusRegression(previous.status, incoming.status)
    ? previous.status
    : incoming.status
  const merged: DownloadTask = { ...previous, ...incoming, status }
  // 进度事件与状态事件可能乱序：运行中阶段不允许 downloaded 回退。
  if (
    incoming.downloaded < previous.downloaded &&
    (status === 'active' || status === 'pausing' || status === 'queued')
  ) {
    merged.downloaded = previous.downloaded
  }
  // 偶发的 speed=0 状态事件不应让速度闪烁。
  if (
    incoming.speed === 0 &&
    previous.speed > 0 &&
    (status === 'active' || status === 'pausing')
  ) {
    merged.speed = previous.speed
  }
  return merged
}

function compareTasks(a: DownloadTask, b: DownloadTask): number {
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt
  return a.taskId.localeCompare(b.taskId)
}

/** 幂等合并：同 taskId 覆盖，保持 addedAt 升序；新任务追加。 */
export function mergeTaskLists(
  current: DownloadTask[],
  incoming: DownloadTask[],
): DownloadTask[] {
  if (incoming.length === 0) return current
  const byId = new Map<string, DownloadTask>()
  for (const task of current) byId.set(task.taskId, task)
  for (const task of incoming) {
    const previous = byId.get(task.taskId)
    byId.set(task.taskId, previous ? mergeTask(previous, task) : task)
  }
  return [...byId.values()].sort(compareTasks)
}

/**
 * 应用一次进度事件；返回同一个对象表示无变化。
 * 自愈：queued 任务收到前进的进度/速度 → 视为 active（状态事件丢失时兜底）。
 */
export function applyProgressToTask(
  task: DownloadTask,
  progress: DownloadProgressEvent,
): DownloadTask {
  if (task.status === 'completed' || task.status === 'cancelled') return task

  const totalSize = progress.totalSize > 0 ? progress.totalSize : task.totalSize
  const downloaded = Math.max(task.downloaded, progress.downloaded)
  const boundedDownloaded = totalSize > 0 ? Math.min(downloaded, totalSize) : downloaded
  const looksRunning =
    task.status === 'queued' && (progress.speed > 0 || progress.downloaded > task.downloaded)
  const status: TaskStatus = looksRunning ? 'active' : task.status
  const speed =
    status === 'active' || status === 'pausing' ? Math.max(progress.speed, looksRunning ? task.speed : 0) : 0

  if (
    task.downloaded === boundedDownloaded &&
    task.totalSize === totalSize &&
    task.speed === speed &&
    task.status === status
  ) {
    return task
  }
  return {
    ...task,
    downloaded: boundedDownloaded,
    totalSize,
    speed,
    status,
  }
}
