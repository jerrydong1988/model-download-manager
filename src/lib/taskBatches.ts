import type { DownloadTask, Source } from '../types'

function isRunningStatus(status: DownloadTask['status']): boolean {
  return status === 'active' || status === 'pausing'
}

export interface TaskBatch {
  key: string
  source: Source
  repoId: string
  revision: string
  tasks: DownloadTask[]
}

export function batchKey(task: Pick<DownloadTask, 'source' | 'repoId' | 'revision'>): string {
  return `${task.source}|${task.repoId}|${task.revision || ''}`
}

/** 按来源、仓库和 revision 聚合。批次顺序取最近加入的任务在前。 */
export function groupTaskBatches(tasks: DownloadTask[]): TaskBatch[] {
  const groups = new Map<string, TaskBatch>()
  for (const task of tasks) {
    const key = batchKey(task)
    const existing = groups.get(key)
    if (existing) {
      existing.tasks.push(task)
      continue
    }
    groups.set(key, {
      key,
      source: task.source,
      repoId: task.repoId,
      revision: task.revision,
      tasks: [task],
    })
  }
  return [...groups.values()].sort((left, right) => {
    const leftAdded = Math.max(...left.tasks.map((task) => task.addedAt))
    const rightAdded = Math.max(...right.tasks.map((task) => task.addedAt))
    return rightAdded - leftAdded
  })
}

export function countBatch(tasks: DownloadTask[]) {
  let running = 0
  let queued = 0
  let paused = 0
  let completed = 0
  let failed = 0
  let cancelled = 0
  for (const task of tasks) {
    if (isRunningStatus(task.status)) running += 1
    else if (task.status === 'queued') queued += 1
    else if (task.status === 'paused') paused += 1
    else if (task.status === 'completed') completed += 1
    else if (task.status === 'error') failed += 1
    else if (task.status === 'cancelled') cancelled += 1
  }
  return { running, queued, paused, completed, failed, cancelled }
}
