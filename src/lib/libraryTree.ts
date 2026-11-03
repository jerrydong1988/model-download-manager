/**
 * 本地模型库多扫描根目录树（v0.2.0 重构）。
 *
 * 输入：scanLibrary() 返回的绝对路径 LocalFile[]（含 `rootDir`）+ 扫描根目录数组
 *      （`[settings.downloadDir, ...settings.libraryRoots]`）。
 * 输出：每个扫描根一个顶层根节点（即使该根暂无文件也会出现，便于「添加目录」后立即看到）；
 *      不在任何配置根下的文件归入「其他位置」。
 * Windows 路径统一转 `/` 后做大小写不敏感匹配。
 */

import type { FileKind, LocalFile } from '../types'
import { normalizeDownloadDir } from './downloadPaths'

export interface LibraryFileEntry extends LocalFile {
  /** 相对所属扫描根的路径（使用 `/` 分隔）；「其他位置」下为规范化后的绝对路径 */
  relativePath: string
}

export interface LibraryDir {
  /** 相对所属扫描根的路径（`/` 分隔）；根为 ''，「其他位置」为 `__external__` */
  path: string
  /** 绝对路径（根节点 = 扫描根绝对路径；子目录 = 根 + 相对路径；外部节点为占位值） */
  absolutePath: string
  /** 所属扫描根（绝对路径）；「其他位置」为空字符串 */
  rootDir: string
  /** 显示名称 */
  name: string
  /** 根节点 depth=0，其后逐级 +1（「其他位置」与根同级，depth=0） */
  depth: number
  dirs: LibraryDir[]
  files: LibraryFileEntry[]
  /** 递归聚合字节数 */
  totalSize: number
  /** 递归聚合文件数 */
  fileCount: number
  /** 递归最近修改时间（Unix 毫秒，无文件为 0） */
  latest: number
  external?: boolean
  isRoot?: boolean
}

export interface LibraryFilters {
  query: string
  kind: FileKind | 'all'
}

export const EXTERNAL_PATH = '__external__'
/** 兼容旧导入：v0.2.0 起展开集合以节点 `absolutePath` 作为 key。 */
export const ROOT_KEY = '__root__'

export function isFilterActive(filters: LibraryFilters): boolean {
  return filters.query.trim().length > 0 || filters.kind !== 'all'
}

/** 统一为 `/` 分隔、折叠重复分隔符、去掉结尾分隔符。 */
export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

export function baseNameOf(dir: string): string {
  const normalized = normalizeSlashes(dir)
  if (!normalized) return ''
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/** 绝对路径 → 相对下载根的路径；不在该根下时返回 null。 */
export function relativePathOf(filePath: string, baseDir: string): string | null {
  const base = normalizeSlashes(baseDir)
  if (!base) return null
  const normalized = normalizeSlashes(filePath)
  const lowerBase = base.toLowerCase()
  const lowerPath = normalized.toLowerCase()
  if (lowerPath === lowerBase) return ''
  if (!lowerPath.startsWith(`${lowerBase}/`)) return null
  return normalized.slice(base.length + 1)
}

/** 相对路径 → 绝对路径（打开目录用，Windows 反斜杠格式）。 */
export function absolutePathOf(baseDir: string, relativePath: string): string {
  const base = normalizeDownloadDir(baseDir)
  if (!relativePath) return base
  return `${base.replace(/[\\/]+$/, '')}\\${relativePath.replace(/\//g, '\\')}`
}

/** 规范化 + 去重扫描根（忽略大小写重复、去尾部斜杠、保持原顺序）。 */
export function normalizeRootDirs(roots: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of roots) {
    if (typeof raw !== 'string') continue
    const root = normalizeDownloadDir(raw)
    if (!root) continue
    const key = normalizeSlashes(root).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(root)
  }
  return result
}

/** 文件是否属于某个扫描根（优先使用 LocalFile.rootDir，缺省按路径前缀兜底）。 */
export function fileBelongsToRoot(file: LocalFile, root: string): boolean {
  const normalizedRoot = normalizeSlashes(root).toLowerCase()
  if (!normalizedRoot) return false
  const declared = file.rootDir ? normalizeSlashes(file.rootDir).toLowerCase() : ''
  if (declared) return declared === normalizedRoot
  const normalizedPath = normalizeSlashes(file.path).toLowerCase()
  return (
    normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
  )
}

/** 扫描根显示名：目录基名；盘符根等情况回退为完整路径。 */
export function rootDisplayName(root: string): string {
  return baseNameOf(root) || root
}

function createDir(
  path: string,
  absolutePath: string,
  rootDir: string,
  name: string,
  depth: number,
  extras: Partial<LibraryDir> = {},
): LibraryDir {
  return {
    path,
    absolutePath,
    rootDir,
    name,
    depth,
    dirs: [],
    files: [],
    totalSize: 0,
    fileCount: 0,
    latest: 0,
    ...extras,
  }
}

function compareName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

function aggregate(dir: LibraryDir): void {
  let totalSize = 0
  let fileCount = 0
  let latest = 0
  for (const file of dir.files) {
    totalSize += file.size
    fileCount += 1
    latest = Math.max(latest, file.modifiedAt)
  }
  for (const child of dir.dirs) {
    aggregate(child)
    totalSize += child.totalSize
    fileCount += child.fileCount
    latest = Math.max(latest, child.latest)
  }
  dir.files.sort(compareName)
  dir.dirs.sort(compareName)
  dir.totalSize = totalSize
  dir.fileCount = fileCount
  dir.latest = latest
}

export interface LibraryTreeResult {
  /** 所有配置的扫描根（顺序 = downloadDir, ...libraryRoots；含暂无文件的空根） */
  roots: LibraryDir[]
  /** 不在任何配置根下的文件（通常为空） */
  external: LibraryDir | null
  externalCount: number
  /** 兼容单根展示：汇总虚拟根（不参与渲染；统计用 totalSize/fileCount/latest） */
  root: LibraryDir
}

/**
 * 构建多扫描根目录树。
 * `rootDirs` 接受字符串数组；也兼容单根字符串（v0.1.x 调用方式）。
 */
export function buildLibraryTree(
  files: LocalFile[],
  rootDirs: string | string[],
): LibraryTreeResult {
  const roots = normalizeRootDirs(Array.isArray(rootDirs) ? rootDirs : [rootDirs])
  const rootNodes = roots.map((root) =>
    createDir('', root, root, rootDisplayName(root), 0, { isRoot: true }),
  )
  const nodeByRootKey = new Map<string, LibraryDir>()
  for (const node of rootNodes) {
    nodeByRootKey.set(normalizeSlashes(node.rootDir).toLowerCase(), node)
  }
  const dirsByRoot = new Map<string, Map<string, LibraryDir>>()
  for (const node of rootNodes) {
    dirsByRoot.set(normalizeSlashes(node.rootDir).toLowerCase(), new Map([['', node]]))
  }

  const external = createDir(EXTERNAL_PATH, EXTERNAL_PATH, '', '其他位置', 0, {
    external: true,
  })
  let externalCount = 0

  const findRoot = (file: LocalFile): LibraryDir | null => {
    const declared = file.rootDir ? normalizeSlashes(file.rootDir).toLowerCase() : ''
    if (declared && nodeByRootKey.has(declared)) {
      return nodeByRootKey.get(declared) ?? null
    }
    // 兜底：最长前缀匹配（旧后端未返回 rootDir 时仍可分组）。
    const normalizedPath = normalizeSlashes(file.path).toLowerCase()
    let matched: LibraryDir | null = null
    let matchedLength = -1
    for (const root of roots) {
      const base = normalizeSlashes(root).toLowerCase()
      if (!base) continue
      if (!normalizedPath.startsWith(`${base}/`)) continue
      if (base.length > matchedLength) {
        matched = nodeByRootKey.get(base) ?? null
        matchedLength = base.length
      }
    }
    return matched
  }

  for (const file of files) {
    const rootNode = findRoot(file)
    if (!rootNode) {
      externalCount += 1
      external.files.push({
        ...file,
        relativePath: normalizeSlashes(file.path),
      })
      continue
    }
    const relative = relativePathOf(file.path, rootNode.rootDir)
    if (relative === null || relative === '') {
      // 根目录自身不是文件；异常数据走「其他位置」兜底。
      if (relative === null) {
        externalCount += 1
        external.files.push({ ...file, relativePath: normalizeSlashes(file.path) })
      }
      continue
    }
    const segments = relative.split('/').filter(Boolean)
    const fileName = segments.pop() ?? file.name
    const dirs = dirsByRoot.get(normalizeSlashes(rootNode.rootDir).toLowerCase())
    if (!dirs) continue
    let parent = rootNode
    let currentPath = ''
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let node = dirs.get(currentPath)
      if (!node) {
        node = createDir(
          currentPath,
          absolutePathOf(rootNode.rootDir, currentPath),
          rootNode.rootDir,
          segment,
          parent.depth + 1,
        )
        dirs.set(currentPath, node)
        parent.dirs.push(node)
      }
      parent = node
    }
    parent.files.push({ ...file, name: fileName, relativePath: relative })
  }

  for (const node of rootNodes) aggregate(node)
  const hasExternal = external.files.length > 0
  if (hasExternal) aggregate(external)

  // 兼容单根/统计用的虚拟总根（不渲染）。
  const virtualRoot = createDir('', '', '', '全部扫描根', 0, { isRoot: true })
  virtualRoot.dirs = hasExternal ? [...rootNodes, external] : [...rootNodes]
  aggregate(virtualRoot)

  return {
    roots: rootNodes,
    external: hasExternal ? external : null,
    externalCount,
    root: virtualRoot,
  }
}

function cloneDirShallow(dir: LibraryDir): LibraryDir {
  return {
    ...dir,
    dirs: [],
    files: [],
    totalSize: 0,
    fileCount: 0,
    latest: 0,
  }
}

export interface FilteredTreeResult {
  roots: LibraryDir[]
  external: LibraryDir | null
  /** 命中过滤条件的文件数（含根目录与其他位置） */
  matchedCount: number
  /** 兼容统计用的虚拟总根 */
  root: LibraryDir
}

/**
 * 按关键词（文件名 / 相对路径 / 绝对路径）与类型裁剪树。
 * 只保留命中文件及其祖先目录；目录聚合值改为命中文件的聚合。
 * 无命中的扫描根会被隐藏（避免筛选时出现空根噪声）。
 */
export function filterLibraryTree(
  roots: LibraryDir[],
  external: LibraryDir | null,
  filters: LibraryFilters,
): FilteredTreeResult {
  if (!isFilterActive(filters)) {
    const virtualRoot = createDir('', '', '', '全部扫描根', 0, { isRoot: true })
    virtualRoot.dirs = external ? [...roots, external] : [...roots]
    aggregate(virtualRoot)
    return { roots, external, matchedCount: virtualRoot.fileCount, root: virtualRoot }
  }
  const keyword = filters.query.trim().toLowerCase()
  let matchedCount = 0

  const visit = (dir: LibraryDir): LibraryDir | null => {
    const files = dir.files.filter((file) => {
      if (filters.kind !== 'all' && file.kind !== filters.kind) return false
      if (!keyword) return true
      return (
        file.name.toLowerCase().includes(keyword) ||
        file.relativePath.toLowerCase().includes(keyword) ||
        file.path.toLowerCase().includes(keyword)
      )
    })
    matchedCount += files.length
    const next = cloneDirShallow(dir)
    next.files = files
    for (const child of dir.dirs) {
      const filteredChild = visit(child)
      if (filteredChild) next.dirs.push(filteredChild)
    }
    if (!dir.isRoot && files.length === 0 && next.dirs.length === 0) return null
    // 重新计算裁剪后的聚合值
    let totalSize = 0
    let fileCount = 0
    let latest = 0
    for (const file of files) {
      totalSize += file.size
      fileCount += 1
      latest = Math.max(latest, file.modifiedAt)
    }
    for (const child of next.dirs) {
      totalSize += child.totalSize
      fileCount += child.fileCount
      latest = Math.max(latest, child.latest)
    }
    next.totalSize = totalSize
    next.fileCount = fileCount
    next.latest = latest
    return next
  }

  const filteredRoots: LibraryDir[] = []
  for (const root of roots) {
    const next = visit(root)
    if (next) filteredRoots.push(next)
  }
  const filteredExternal = external ? visit(external) : null
  const virtualRoot = createDir('', '', '', '全部扫描根', 0, { isRoot: true })
  virtualRoot.dirs = filteredExternal
    ? [...filteredRoots, filteredExternal]
    : [...filteredRoots]
  aggregate(virtualRoot)
  return {
    roots: filteredRoots,
    external: filteredExternal,
    matchedCount,
    root: virtualRoot,
  }
}

export interface LibraryDirRow {
  kind: 'dir'
  key: string
  depth: number
  dir: LibraryDir
  expanded: boolean
  isRoot: boolean
}

export interface LibraryFileRow {
  kind: 'file'
  key: string
  depth: number
  file: LibraryFileEntry
}

export type LibraryTreeRow = LibraryDirRow | LibraryFileRow

/**
 * 扁平化为可渲染行（只输出展开目录的子级）。
 * forceExpanded=true 时忽略折叠状态（筛选命中分支自动展开）。
 */
export function flattenLibraryTree(
  roots: LibraryDir[],
  expanded: ReadonlySet<string>,
  forceExpanded = false,
  external: LibraryDir | null = null,
): LibraryTreeRow[] {
  const rows: LibraryTreeRow[] = []

  const walk = (dir: LibraryDir, depth: number): void => {
    for (const child of dir.dirs) {
      const isExpanded = forceExpanded || expanded.has(child.absolutePath)
      rows.push({
        kind: 'dir',
        key: child.absolutePath,
        depth,
        dir: child,
        expanded: isExpanded,
        isRoot: false,
      })
      if (isExpanded) walk(child, depth + 1)
    }
    for (const file of dir.files) {
      rows.push({
        kind: 'file',
        key: `file:${file.path}`,
        depth,
        file,
      })
    }
  }

  for (const root of roots) {
    const rootExpanded = forceExpanded || expanded.has(root.absolutePath)
    rows.push({
      kind: 'dir',
      key: root.absolutePath,
      depth: 0,
      dir: root,
      expanded: rootExpanded,
      isRoot: true,
    })
    if (rootExpanded) walk(root, 1)
  }

  if (external) {
    const externalExpanded = forceExpanded || expanded.has(EXTERNAL_PATH)
    rows.push({
      kind: 'dir',
      key: EXTERNAL_PATH,
      depth: 0,
      dir: external,
      expanded: externalExpanded,
      isRoot: false,
    })
    if (externalExpanded) walk(external, 1)
  }
  return rows
}

function collectPaths(dir: LibraryDir, into: Set<string>): void {
  for (const child of dir.dirs) {
    into.add(child.absolutePath)
    collectPaths(child, into)
  }
}

/** 展开全部：所有根 + 所有目录（含「其他位置」）。 */
export function allExpandedPaths(
  roots: LibraryDir[],
  external: LibraryDir | null = null,
): Set<string> {
  const set = new Set<string>()
  for (const root of roots) {
    set.add(root.absolutePath)
    collectPaths(root, set)
  }
  if (external) {
    set.add(EXTERNAL_PATH)
    collectPaths(external, set)
  }
  return set
}

/** 默认展开策略：每个扫描根 + 其第一层目录；「其他位置」同样第一层。 */
export function initialExpandedPaths(
  roots: LibraryDir[],
  external: LibraryDir | null = null,
): Set<string> {
  const set = new Set<string>()
  for (const root of roots) {
    set.add(root.absolutePath)
    for (const child of root.dirs) set.add(child.absolutePath)
  }
  if (external) {
    set.add(EXTERNAL_PATH)
    for (const child of external.dirs) set.add(child.absolutePath)
  }
  return set
}

/** 目录总数（含扫描根与「其他位置」，用于统计文案）。 */
export function countDirs(
  roots: LibraryDir[],
  external: LibraryDir | null = null,
): number {
  let count = 0
  const visit = (dir: LibraryDir): number => {
    let total = 1
    for (const child of dir.dirs) total += visit(child)
    return total
  }
  for (const root of roots) count += visit(root)
  if (external) count += visit(external)
  return count
}

/** 第一层目录总数（跨根，不含「其他位置」）。 */
export function countTopLevelDirs(roots: LibraryDir[]): number {
  return roots.reduce((sum, root) => sum + root.dirs.length, 0)
}

/** 汇总多个根的聚合值（统计卡/footer 用）。 */
export function sumRootStats(
  roots: LibraryDir[],
  external: LibraryDir | null = null,
): { totalSize: number; fileCount: number; latest: number } {
  let totalSize = 0
  let fileCount = 0
  let latest = 0
  for (const node of external ? [...roots, external] : roots) {
    totalSize += node.totalSize
    fileCount += node.fileCount
    latest = Math.max(latest, node.latest)
  }
  return { totalSize, fileCount, latest }
}
