import type { DownloadTask, FileKind, LocalFile, RepoFile } from '../types'

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

function relativePathOf(filePath: string, baseDir: string): string | null {
  const base = normalizeSlashes(baseDir)
  if (!base) return null
  const normalized = normalizeSlashes(filePath)
  if (normalized.toLowerCase() === base.toLowerCase()) return ''
  if (!normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return null
  return normalized.slice(base.length + 1)
}

export interface LibraryViewState {
  rootsKey: string
  expanded: string[]
  query: string
  kind: FileKind | 'all'
}

const VIEW_KEY = 'mdm.libraryView.v1'

function pathKey(value: string): string {
  return normalizeSlashes(value).toLowerCase()
}

function parentDir(filePath: string): string {
  const normalized = normalizeSlashes(filePath)
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : ''
}

/** 同一相对路径出现在两个以上扫描根时，这些文件都算重复。 */
export function duplicateFilePaths(files: LocalFile[]): Set<string> {
  const groups = new Map<string, LocalFile[]>()
  for (const file of files) {
    if (!file.rootDir) continue
    const relative = relativePathOf(file.path, file.rootDir)
    if (!relative) continue
    const key = relative.toLowerCase()
    const list = groups.get(key) ?? []
    list.push(file)
    groups.set(key, list)
  }
  const duplicates = new Set<string>()
  for (const group of groups.values()) {
    const roots = new Set(group.map((file) => pathKey(file.rootDir)))
    if (roots.size < 2) continue
    for (const file of group) duplicates.add(pathKey(file.path))
  }
  return duplicates
}

/** 目录下任务只有一个 revision 时，返回该 revision。 */
export function directoryRevisions(tasks: DownloadTask[]): Map<string, string> {
  const grouped = new Map<string, Set<string>>()
  for (const task of tasks) {
    const revision = task.revision?.trim()
    if (!revision) continue
    const dir = pathKey(parentDir(task.savePath))
    if (!dir) continue
    const revisions = grouped.get(dir) ?? new Set<string>()
    revisions.add(revision)
    grouped.set(dir, revisions)
  }
  const result = new Map<string, string>()
  for (const [dir, revisions] of grouped) {
    if (revisions.size === 1) result.set(dir, [...revisions][0])
  }
  return result
}

/**
 * 已完成的本地文件与当前远端清单的大小或校验和不同。
 * 只提示，不表示应该自动覆盖。
 */
export function remoteIsNewer(file: RepoFile, task: DownloadTask | undefined): boolean {
  if (!task || task.status !== 'completed') return false
  if (file.size > 0 && task.totalSize > 0 && file.size !== task.totalSize) return true
  const remoteHash = file.sha256?.trim().toLowerCase()
  const localHash = task.sha256?.trim().toLowerCase()
  return Boolean(remoteHash && localHash && remoteHash !== localHash)
}

export function readLibraryView(rootsKey: string): LibraryViewState | null {
  if (typeof localStorage === 'undefined' || !rootsKey) return null
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LibraryViewState>
    if (parsed.rootsKey !== rootsKey) return null
    if (!Array.isArray(parsed.expanded) || typeof parsed.query !== 'string') return null
    const kind = parsed.kind
    if (kind !== 'all' && kind !== 'weight' && kind !== 'mmproj' && kind !== 'imatrix' && kind !== 'config' && kind !== 'other') {
      return null
    }
    return {
      rootsKey,
      expanded: parsed.expanded.filter((item) => typeof item === 'string'),
      query: parsed.query,
      kind,
    }
  } catch {
    return null
  }
}

export function writeLibraryView(state: LibraryViewState): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(VIEW_KEY, JSON.stringify(state))
}
