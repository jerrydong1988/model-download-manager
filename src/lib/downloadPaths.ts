import type { DownloadTask, Source } from '../types'

/** Preserve Windows drive/UNC roots while removing redundant trailing separators. */
export function normalizeDownloadDir(value: string): string {
  const trimmed = value.trim()
  if (/^[a-z]:[\\/]+$/i.test(trimmed)) return `${trimmed.slice(0, 2)}\\`
  return trimmed.replace(/[\\/]+$/, '')
}

function pathKey(value: string): string {
  return value.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function taskMatchesDestination(task: DownloadTask, source: Source, repoId: string, revision: string, saveDir: string): boolean {
  const defaultRevision = source === 'huggingface' ? 'main' : 'master'
  if (task.source !== source || task.repoId !== repoId || (task.revision || defaultRevision) !== revision) return false
  const root = pathKey(saveDir)
  if (!root) return false
  const suffix = `${repoId}/${task.remotePath}`
  const expected = revision === defaultRevision
    ? `${root}/${suffix}`
    : `${root}/.mdm-revisions/${Array.from(new TextEncoder().encode(revision), byte => byte.toString(16).padStart(2, '0')).join('')}/${suffix}`
  // Existing tasks keep their stored v0.2.0 destination when resuming after upgrade.
  const legacy = `${root}/${repoId}/${revision}/${task.remotePath}`
  return pathKey(task.savePath) === pathKey(expected) || (revision !== defaultRevision && pathKey(task.savePath) === pathKey(legacy))
}
