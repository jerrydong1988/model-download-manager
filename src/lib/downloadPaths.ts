import type { DownloadTask, Source } from '../types'

/** Preserve Windows drive/UNC roots while removing redundant trailing separators. */
export function normalizeDownloadDir(value: string): string {
  const trimmed = value.trim()
  if (/^[a-z]:[\\/]+$/i.test(trimmed)) return `${trimmed.slice(0, 2)}\\`
  return trimmed.replace(/[\\/]+$/, '')
}

export function downloadPathKey(value: string): string {
  return value.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function downloadFinalPath(saveDir: string, source: Source, repoId: string, revision: string, remotePath: string): string {
  const root = saveDir.trim().replace(/[\\/]+$/, '')
  const segments = [root]
  if (revision !== (source === 'huggingface' ? 'main' : 'master')) {
    const encoded = Array.from(new TextEncoder().encode(revision), byte => byte.toString(16).padStart(2, '0')).join('')
    segments.push('.mdm-revisions', encoded)
  }
  return [...segments, repoId, remotePath].join('/').replace(/\//g, '\\')
}

export function taskMatchesDestination(task: DownloadTask, source: Source, repoId: string, revision: string, saveDir: string): boolean {
  const defaultRevision = source === 'huggingface' ? 'main' : 'master'
  if (task.source !== source || task.repoId !== repoId || (task.revision || defaultRevision) !== revision) return false
  if (!saveDir.trim()) return false
  const expected = downloadFinalPath(saveDir, source, repoId, revision, task.remotePath)
  // Existing tasks keep their stored v0.2.0 destination when resuming after upgrade.
  const legacy = `${downloadPathKey(saveDir)}/${repoId}/${revision}/${task.remotePath}`
  return downloadPathKey(task.savePath) === downloadPathKey(expected) || (revision !== defaultRevision && downloadPathKey(task.savePath) === downloadPathKey(legacy))
}
