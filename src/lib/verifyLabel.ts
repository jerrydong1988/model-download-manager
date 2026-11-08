import type { DownloadTask, VerifyStatus } from '../types'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase()
}

export interface VerifyPresentation {
  label: string
  tone: 'emerald' | 'amber' | 'red' | 'slate'
}

function sameFile(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

/** 用下载任务上的校验结果描述本地文件。没有任务记录时视为无校验和。 */
export function verifyPresentation(filePath: string, tasks: DownloadTask[]): VerifyPresentation {
  const matches = tasks.filter((task) => sameFile(task.savePath, filePath))
  if (matches.length === 0) return { label: '无校验和', tone: 'slate' }
  const latest = matches.reduce((best, task) => (task.addedAt >= best.addedAt ? task : best))
  const status: VerifyStatus = latest.verifyStatus ?? 'unavailable'
  switch (status) {
    case 'verified':
      return { label: '已校验', tone: 'emerald' }
    case 'mismatch':
      return { label: '不一致', tone: 'red' }
    case 'pending':
      return { label: '正在校验', tone: 'amber' }
    default:
      return { label: '无校验和', tone: 'slate' }
  }
}
