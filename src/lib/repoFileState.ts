import type { DownloadTask, LocalRepoMatch, RepoFile, Source } from '../types'
import { SOURCE_LABEL, SOURCE_SHORT } from './labels.ts'
import { remoteIsNewer } from './libraryCatalog.ts'

export interface FileStateInfo {
  label: string
  title?: string
  tone: 'emerald' | 'blue' | 'amber' | 'red' | 'slate'
  disabled: boolean
}

export function repoFileState(
  file: RepoFile, source: Source, task?: DownloadTask, local?: LocalRepoMatch,
): FileStateInfo | null {
  if (local) {
    const other = local.source && local.source !== source ? local.source : null
    const origin = other ? `原下载记录来自 ${SOURCE_LABEL[other]}。` : ''
    switch (local.status) {
      case 'verified':
        return { label: other ? `已下载 · ${SOURCE_SHORT[other]}` : '已下载', tone: 'emerald', disabled: true,
          title: `${origin}本地文件的 SHA-256 与当前仓库一致。` }
      case 'needsHash':
        return { label: '本地待校验', tone: 'blue', disabled: true, title: `${origin}正在后台核对本地文件。` }
      case 'present':
        return { label: task?.status === 'completed' ? '已下载' : '本地已有', tone: 'slate', disabled: true,
          title: `${origin}当前仓库未提供 SHA-256，内容尚未确认。可更改目录另存。` }
      case 'different':
        return { label: remoteIsNewer(file, task) ? '可更新' : '内容不同', tone: 'amber', disabled: true,
          title: `${origin}本地文件大小或 SHA-256 与当前仓库不同。可更改目录另存。` }
      case 'occupied':
        return { label: '路径已占用', tone: 'amber', disabled: true, title: `${origin}目标路径或临时文件属于另一项任务。请查看下载队列或更改目录。` }
      case 'missing':
        return { label: '文件缺失', tone: 'amber', disabled: true, title: `${origin}下载记录仍在，目标文件已移走。请清理对应记录或更改目录。` }
      case 'unreadable':
        return { label: '无法核对', tone: 'amber', disabled: true, title: '请检查保存路径和文件读取权限，然后刷新文件列表。' }
    }
  }
  if (!task) return null
  if (task.status === 'completed') {
    if (task.verifyStatus === 'pending') return { label: '正在校验', tone: 'blue', disabled: true }
    if (remoteIsNewer(file, task)) return { label: '可更新', tone: 'amber', disabled: true }
    return { label: '已下载', tone: 'emerald', disabled: true }
  }
  if (task.status === 'error') return { label: '下载失败', tone: 'red', disabled: false }
  if (task.status === 'cancelled') return { label: '已取消', tone: 'amber', disabled: false }
  return { label: '队列中', tone: 'blue', disabled: true }
}
