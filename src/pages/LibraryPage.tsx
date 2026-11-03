import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes,
  ChevronsDown,
  ChevronsUp,
  FileCog,
  FolderOpen,
  FolderTree,
  HardDrive,
  Inbox,
  Projector,
  RefreshCw,
  Search,
  SearchX,
  X,
} from 'lucide-react'
import type { FileKind, LocalFile } from '../types'
import { normalizeDownloadDir } from '../lib/downloadPaths'
import {
  allExpandedPaths,
  buildLibraryTree,
  countDirs,
  filterLibraryTree,
  flattenLibraryTree,
  initialExpandedPaths,
  isFilterActive,
  normalizeSlashes,
  sumRootStats,
  type LibraryDir,
  type LibraryFileEntry,
} from '../lib/libraryTree'
import {
  deleteLocalFile,
  openPath,
  pickDirectory,
  saveSettings as saveSettingsCommand,
  scanLibrary,
  toErrorText,
} from '../lib/ipc'
import { formatBytes, formatRelativeTime } from '../lib/format'
import { useAppStore } from '../store/appStore'
import {
  APP_FOCUS_SEARCH_EVENT,
  APP_REFRESH_PAGE_EVENT,
} from '../components/layout/useGlobalShortcuts'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Checkbox } from '../components/ui/Checkbox'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorBanner } from '../components/ui/ErrorBanner'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Skeleton } from '../components/ui/Skeleton'
import { StatCard } from '../components/ui/StatCard'
import { LibraryDetailPanel } from '../components/library/LibraryDetailPanel'
import {
  LibraryRootsPanel,
  type LibraryRootEntry,
} from '../components/library/LibraryRootsPanel'
import { LibraryTreeTable } from '../components/library/LibraryTreeTable'

type LoadStatus = 'loading' | 'ready' | 'error'
type KindFilter = FileKind | 'all'

const KIND_OPTIONS: Array<{ value: KindFilter; label: string; title?: string }> = [
  { value: 'all', label: '全部' },
  { value: 'weight', label: '权重', title: '模型权重（weight）' },
  { value: 'mmproj', label: '投影器', title: '多模态投影器（mmproj）' },
  { value: 'imatrix', label: '矩阵', title: '权重矩阵（imatrix）' },
  { value: 'config', label: '配置', title: '配置文件（config）' },
  { value: 'other', label: '其他', title: '其他文件（other）' },
]

/** 契约：libraryRoots 最多 8 个附加根（downloadDir 始终包含）。 */
const MAX_LIBRARY_ROOTS = 8

export default function LibraryPage() {
  const settings = useAppStore((state) => state.settings)
  const setSettings = useAppStore((state) => state.setSettings)
  const setPage = useAppStore((state) => state.setPage)
  const pushToast = useAppStore((state) => state.pushToast)

  const downloadDir = settings?.downloadDir ?? ''
  const configuredRoots = useMemo(
    () =>
      [downloadDir, ...(settings?.libraryRoots ?? [])].filter(
        (root): root is string => Boolean(root && root.trim()),
      ),
    [downloadDir, settings?.libraryRoots],
  )
  const rootsKey = useMemo(
    () => configuredRoots.map((root) => root.toLowerCase()).join('|'),
    [configuredRoots],
  )

  const [files, setFiles] = useState<LocalFile[]>([])
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState('')
  const [lastScanAt, setLastScanAt] = useState<number | null>(null)
  const [scanVersion, setScanVersion] = useState(0)

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>())
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [selectedFile, setSelectedFile] = useState<LibraryFileEntry | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<LocalFile | null>(null)
  const [removeTask, setRemoveTask] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [addingRoot, setAddingRoot] = useState(false)
  const [removingRoot, setRemovingRoot] = useState<string | null>(null)

  const loadedRootsKeyRef = useRef('')
  const expansionKeyRef = useRef('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const loadLibrary = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const result = await scanLibrary()
      // 防御性过滤：后端已排除临时文件，这里再兜底一次。
      const visible = result.filter(
        (file) => !file.name.endsWith('.part') && !file.name.endsWith('.part.json'),
      )
      setFiles(visible)
      setLastScanAt(Date.now())
      setScanVersion((version) => version + 1)
      setStatus('ready')
    } catch (err) {
      setStatus('error')
      setError(toErrorText(err))
    }
  }, [])

  // 配置的扫描根变化（设置页修改下载目录 / 增删附加根）后自动重新扫描。
  useEffect(() => {
    if (!settings) return
    if (loadedRootsKeyRef.current === rootsKey) return
    loadedRootsKeyRef.current = rootsKey
    void loadLibrary()
  }, [loadLibrary, rootsKey, settings])

  // 全局快捷键：Ctrl/Cmd+F 聚焦库内搜索；F5 重新扫描。
  useEffect(() => {
    const focusSearch = () => {
      if (useAppStore.getState().page !== 'library') return
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: string }>).detail
      if (detail?.page && detail.page !== 'library') return
      if (useAppStore.getState().page !== 'library') return
      void loadLibrary().then(() => {
        useAppStore.getState().pushToast('info', '已重新扫描本地模型库')
      })
    }
    window.addEventListener(APP_FOCUS_SEARCH_EVENT, focusSearch)
    window.addEventListener(APP_REFRESH_PAGE_EVENT, refresh)
    return () => {
      window.removeEventListener(APP_FOCUS_SEARCH_EVENT, focusSearch)
      window.removeEventListener(APP_REFRESH_PAGE_EVENT, refresh)
    }
  }, [loadLibrary])

  const tree = useMemo(
    () => buildLibraryTree(files, configuredRoots),
    [configuredRoots, files],
  )
  const rootNodes = tree.roots
  const external = tree.external

  // 默认展开：每个扫描根 + 其第一层目录。
  const expansionKey = `${scanVersion}|${rootsKey}`
  useEffect(() => {
    if (status !== 'ready') return
    if (expansionKeyRef.current === expansionKey) return
    expansionKeyRef.current = expansionKey
    setExpanded(initialExpandedPaths(rootNodes, external))
  }, [expansionKey, external, rootNodes, status])

  const filters = useMemo(() => ({ query, kind: kindFilter }), [kindFilter, query])
  const filterActive = isFilterActive(filters)
  const filteredTree = useMemo(
    () => filterLibraryTree(rootNodes, external, filters),
    [external, filters, rootNodes],
  )
  const rows = useMemo(
    () =>
      flattenLibraryTree(
        filteredTree.roots,
        expanded,
        filterActive,
        filteredTree.external,
      ),
    [expanded, filterActive, filteredTree.external, filteredTree.roots],
  )

  // 扫描后若选中的文件已不存在（被外部删除/重命名），关闭详情面板。
  useEffect(() => {
    if (!selectedFile) return
    if (!files.some((file) => file.path === selectedFile.path)) setSelectedFile(null)
  }, [files, selectedFile])

  // 关闭详情面板后把焦点归还给原文件行（键盘连续操作不丢失位置）。
  const lastSelectedRef = useRef<LibraryFileEntry | null>(null)
  useEffect(() => {
    if (selectedFile) {
      lastSelectedRef.current = selectedFile
      return
    }
    const previous = lastSelectedRef.current
    lastSelectedRef.current = null
    if (!previous) return
    const escaped = previous.relativePath.replace(/["\\]/g, '\\$&')
    const target = document.querySelector<HTMLElement>(
      `[data-row-key="file:${escaped}"]`,
    )
    target?.focus()
  }, [selectedFile])

  const kindStats = useMemo(() => {
    const stats = {
      weight: { count: 0, size: 0 },
      mmproj: { count: 0, size: 0 },
      imatrix: { count: 0, size: 0 },
      config: { count: 0, size: 0 },
      other: { count: 0, size: 0 },
      totalSize: 0,
      latest: 0,
    }
    for (const file of files) {
      stats[file.kind].count += 1
      stats[file.kind].size += file.size
      stats.totalSize += file.size
      stats.latest = Math.max(stats.latest, file.modifiedAt)
    }
    return stats
  }, [files])

  const totals = useMemo(() => sumRootStats(rootNodes, external), [external, rootNodes])
  const dirNodeCount = countDirs(rootNodes, external)
  const initialLoading = status === 'loading' && files.length === 0

  const rootEntries: LibraryRootEntry[] = useMemo(() => {
    const downloadKey = normalizeSlashes(downloadDir).toLowerCase()
    return rootNodes.map((node) => ({
      rootDir: node.rootDir,
      isDownloadDir: normalizeSlashes(node.rootDir).toLowerCase() === downloadKey,
      fileCount: node.fileCount,
      totalSize: node.totalSize,
      latest: node.latest,
    }))
  }, [downloadDir, rootNodes])

  const kindOptions = KIND_OPTIONS.map((option) => ({
    ...option,
    count:
      option.value === 'all' ? files.length : kindStats[option.value as FileKind].count,
  }))

  const toggleDir = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const expandAll = useCallback(
    () => setExpanded(allExpandedPaths(rootNodes, external)),
    [external, rootNodes],
  )
  const collapseAll = useCallback(() => setExpanded(new Set<string>()), [])

  const clearFilters = useCallback(() => {
    setQuery('')
    setKindFilter('all')
  }, [])

  const revealFile = useCallback(
    (file: LocalFile) => {
      void openPath(file.path, true).catch((err: unknown) => {
        pushToast('error', '无法在资源管理器中显示', toErrorText(err))
      })
    },
    [pushToast],
  )

  const revealDir = useCallback(
    (dir: LibraryDir) => {
      if (dir.external) return
      void openPath(dir.absolutePath, false).catch((err: unknown) => {
        pushToast('error', '无法打开目录', toErrorText(err))
      })
    },
    [pushToast],
  )

  const openDownloadDir = useCallback(() => {
    if (!downloadDir) return
    void openPath(downloadDir, false).catch((err: unknown) => {
      pushToast('error', '无法打开下载目录', toErrorText(err))
    })
  }, [downloadDir, pushToast])

  const openRootDir = useCallback(
    (rootDir: string) => {
      void openPath(rootDir, false).catch((err: unknown) => {
        pushToast('error', '无法打开扫描根目录', toErrorText(err))
      })
    },
    [pushToast],
  )

  /** 添加附加扫描根：选择目录 → 写回 settings.libraryRoots → 重新扫描。 */
  const handleAddRoot = async () => {
    if (!settings) return
    const extraRoots = settings.libraryRoots ?? []
    if (extraRoots.length >= MAX_LIBRARY_ROOTS) {
      pushToast('info', `附加扫描根最多 ${MAX_LIBRARY_ROOTS} 个`, '请先移除不再需要的目录')
      return
    }
    setAddingRoot(true)
    try {
      const picked = await pickDirectory(downloadDir)
      if (!picked) return
      const normalized = normalizeDownloadDir(picked)
      if (!normalized) return
      const duplicates = configuredRoots.some(
        (root) => normalizeSlashes(root).toLowerCase() === normalizeSlashes(normalized).toLowerCase(),
      )
      if (duplicates) {
        pushToast('info', '该目录已在扫描根中', normalized)
        return
      }
      const saved = await saveSettingsCommand({
        ...settings,
        libraryRoots: [...extraRoots, normalized],
      })
      setSettings(saved)
      pushToast('success', '已添加扫描根目录', normalized)
      await loadLibrary()
    } catch (err) {
      pushToast('error', '添加扫描根失败', toErrorText(err))
    } finally {
      setAddingRoot(false)
    }
  }

  /** 移除附加扫描根（downloadDir 固定不可移除）。 */
  const handleRemoveRoot = async (rootDir: string) => {
    if (!settings) return
    setRemovingRoot(rootDir)
    try {
      const nextRoots = (settings.libraryRoots ?? []).filter(
        (root) =>
          normalizeSlashes(root).toLowerCase() !== normalizeSlashes(rootDir).toLowerCase(),
      )
      const saved = await saveSettingsCommand({
        ...settings,
        libraryRoots: nextRoots,
      })
      setSettings(saved)
      pushToast('success', '已移除扫描根', rootDir)
      await loadLibrary()
    } catch (err) {
      pushToast('error', '移除扫描根失败', toErrorText(err))
    } finally {
      setRemovingRoot(null)
    }
  }

  const requestDelete = useCallback((file: LocalFile) => {
    setRemoveTask(true)
    setDeleteTarget(file)
  }, [])

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteLocalFile(deleteTarget.path, removeTask)
      setFiles((previous) => previous.filter((file) => file.path !== deleteTarget.path))
      if (selectedFile?.path === deleteTarget.path) setSelectedFile(null)
      pushToast(
        'success',
        '已删除本地文件',
        removeTask ? '对应的下载任务记录也已移除。' : deleteTarget.name,
      )
      setDeleteTarget(null)
    } catch (err) {
      pushToast('error', '删除本地文件失败', toErrorText(err))
    } finally {
      setDeleting(false)
    }
  }

  const showEmptyLibrary = status === 'ready' && files.length === 0
  const showEmptyFilter = filterActive && filteredTree.matchedCount === 0 && files.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="workspace-inset flex min-h-0 flex-1 flex-col gap-5 py-5">
        {status === 'error' ? (
          <ErrorBanner
            title="扫描本地模型库失败"
            message={error}
            onRetry={() => void loadLibrary()}
          />
        ) : null}

        {/* 统计卡：统一 4 张（总占用 / 模型权重 / 投影器与矩阵 / 配置与其他） */}
        <div className="summary-strip shrink-0">
          <StatCard
            label="总占用空间"
            value={formatBytes(totals.totalSize)}
            hint={`共 ${files.length} 个文件 · ${configuredRoots.length} 个扫描根`}
            icon={HardDrive}
            tone="blue"
            loading={initialLoading}
          />
          <StatCard
            label="模型权重"
            value={kindStats.weight.count}
            hint={`合计 ${formatBytes(kindStats.weight.size)}`}
            icon={Boxes}
            tone="violet"
            loading={initialLoading}
          />
          <StatCard
            label="投影器 / 矩阵"
            value={`${kindStats.mmproj.count} / ${kindStats.imatrix.count}`}
            hint={`${formatBytes(kindStats.mmproj.size)} · ${formatBytes(kindStats.imatrix.size)}`}
            icon={Projector}
            tone="amber"
            loading={initialLoading}
          />
          <StatCard
            label="配置 / 其他"
            value={`${kindStats.config.count} / ${kindStats.other.count}`}
            hint={`${formatBytes(kindStats.config.size)} · ${formatBytes(kindStats.other.size)}`}
            icon={FileCog}
            tone="emerald"
            loading={initialLoading}
          />
        </div>

        {/* 扫描根目录管理（v0.2.0：downloadDir 固定 + 附加 libraryRoots） */}
        <LibraryRootsPanel
          roots={rootEntries}
          scanning={status === 'loading'}
          adding={addingRoot}
          onAdd={() => void handleAddRoot()}
          onRemove={(rootDir) => {
            if (removingRoot) return
            void handleRemoveRoot(rootDir)
          }}
          onOpen={openRootDir}
          onRescan={() => void loadLibrary()}
        />

        {/* 目录树面板 */}
        <section className="flex min-h-[300px] flex-1 flex-col overflow-hidden rounded-card border border-line bg-surface md:min-h-[180px]">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <div className="relative w-60 max-w-full">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted"
                aria-hidden="true"
              />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索文件名或路径"
                placeholder="搜索文件名或路径…"
                className="h-control w-full rounded-control border border-line-strong bg-surface pl-8 pr-8 text-secondary text-fg transition-colors duration-micro placeholder:text-fg-muted focus-visible:border-primary"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="清空搜索"
                  onClick={() => setQuery('')}
                  className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-control text-fg-muted transition-colors duration-micro hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <SegmentedControl
              size="sm"
              ariaLabel="按文件类型筛选"
              value={kindFilter}
              onChange={setKindFilter}
              options={kindOptions}
            />

            <span className="hidden items-center gap-1 text-meta text-fg-muted lg:flex">
              <FolderTree className="h-3.5 w-3.5" aria-hidden="true" />
              {configuredRoots.length} 个扫描根
              {totals.latest > 0 ? ` · 最近写入 ${formatRelativeTime(totals.latest)}` : ''}
              {tree.externalCount > 0 ? ` · 其他位置 ${tree.externalCount} 个` : ''}
            </span>

            {filterActive ? (
              <>
                <Badge tone="blue">命中 {filteredTree.matchedCount} 个文件</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  leftIcon={<X className="h-3.5 w-3.5" />}
                >
                  清除筛选
                </Button>
              </>
            ) : null}

            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={expandAll}
                disabled={filterActive}
                title={filterActive ? '筛选时自动展开命中目录' : '展开全部目录'}
                leftIcon={<ChevronsDown className="h-3.5 w-3.5" />}
              >
                展开全部
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={collapseAll}
                disabled={filterActive}
                title={filterActive ? '筛选时自动展开命中目录' : '折叠全部目录'}
                leftIcon={<ChevronsUp className="h-3.5 w-3.5" />}
              >
                折叠全部
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadLibrary()}
                loading={status === 'loading'}
                leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
              >
                刷新
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={openDownloadDir}
                disabled={!downloadDir}
                leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
              >
                打开下载目录
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {initialLoading ? (
                <div className="flex-1 overflow-hidden" aria-busy="true">
                  <div className="flex items-center gap-3 border-b border-line bg-surface-2 px-3 py-2.5">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-10" />
                    <Skeleton className="ml-auto h-3 w-12" />
                    <Skeleton className="h-3 w-14" />
                  </div>
                  <div className="space-y-2 p-3">
                    {Array.from({ length: 12 }).map((_, index) => (
                      <div key={index} className="flex items-center gap-3 py-1">
                        <Skeleton className="h-4 w-4 rounded" />
                        <Skeleton
                          className={
                            index % 3 === 0
                              ? 'h-3.5 w-1/3'
                              : index % 3 === 1
                                ? 'h-3.5 w-1/2'
                                : 'h-3.5 w-2/5'
                          }
                        />
                        <Skeleton className="ml-auto h-3 w-12" />
                        <Skeleton className="h-3 w-16" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : status === 'error' ? (
                <div className="flex flex-1 items-center justify-center">
                  <EmptyState
                    icon={FolderTree}
                    title="无法读取本地模型库"
                    description="请检查扫描根目录是否存在、是否有读取权限，然后重试。"
                    action={
                      <Button
                        variant="primary"
                        onClick={() => void loadLibrary()}
                        leftIcon={<RefreshCw className="h-4 w-4" />}
                      >
                        重新扫描
                      </Button>
                    }
                  />
                </div>
              ) : showEmptyLibrary ? (
                <div className="flex flex-1 items-center justify-center">
                  <EmptyState
                    icon={Inbox}
                    title="本地模型库为空"
                    description={`在 ${configuredRoots.length} 个扫描根目录中还没有发现模型文件。可以先浏览仓库并下载，或添加其他模型目录后重新扫描。当前下载目录：${downloadDir || '未设置'}`}
                    action={
                      <>
                        <Button
                          variant="primary"
                          onClick={() => setPage('browse')}
                          leftIcon={<FolderOpen className="h-4 w-4" />}
                        >
                          去浏览仓库
                        </Button>
                        <Button variant="secondary" onClick={() => void handleAddRoot()}>
                          添加模型目录
                        </Button>
                      </>
                    }
                  />
                </div>
              ) : showEmptyFilter ? (
                <div className="flex flex-1 items-center justify-center">
                  <EmptyState
                    icon={SearchX}
                    title="没有匹配的文件"
                    description={
                      query.trim()
                        ? `没有找到文件名或路径包含“${query.trim()}”的文件。试试其他关键词或更换类型筛选。`
                        : '当前类型筛选下没有文件，试试切换为其他类型。'
                    }
                    action={
                      <Button variant="secondary" onClick={clearFilters}>
                        清除筛选
                      </Button>
                    }
                  />
                </div>
              ) : (
                <LibraryTreeTable
                  rows={rows}
                  downloadDir={downloadDir}
                  selectedFilePath={selectedFile?.path ?? null}
                  onToggleDir={toggleDir}
                  onSelectFile={setSelectedFile}
                  onRevealDir={revealDir}
                  onRevealFile={revealFile}
                  onDeleteFile={requestDelete}
                  resetScrollKey={`${query}|${kindFilter}`}
                />
              )}

              <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2/60 px-3 py-1.5 text-meta text-fg-muted">
                <div className="flex min-w-0 items-center gap-1.5">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate" title={configuredRoots.join('; ')}>
                    {downloadDir || '下载目录未设置'}
                    {configuredRoots.length > 1 ? ` 等 ${configuredRoots.length} 个根` : ''}
                  </span>
                  {lastScanAt ? (
                    <span className="shrink-0">· 扫描于 {formatRelativeTime(lastScanAt)}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-3 tabular-nums">
                  {filterActive ? (
                    <span className="text-primary">命中 {filteredTree.matchedCount} 个文件</span>
                  ) : null}
                  <span>共 {files.length} 个文件</span>
                  {configuredRoots.length > 1 ? (
                    <span>{configuredRoots.length} 个扫描根</span>
                  ) : null}
                  {files.length > 0 ? (
                    <>
                      <span>{formatBytes(totals.totalSize)}</span>
                      <span>{dirNodeCount} 个目录节点</span>
                      <span>当前显示 {rows.length} 行</span>
                    </>
                  ) : null}
                </div>
              </footer>
            </div>

            {selectedFile ? (
              <LibraryDetailPanel
                file={selectedFile}
                onClose={() => setSelectedFile(null)}
                onReveal={() => revealFile(selectedFile)}
                onDelete={() => requestDelete(selectedFile)}
              />
            ) : null}
          </div>
        </section>
      </div>

      {selectedFile ? (
        <div
          aria-hidden="true"
          onClick={() => setSelectedFile(null)}
          className="fixed inset-0 z-30 bg-slate-950/20 backdrop-blur-[1px] xl:hidden"
        />
      ) : null}

      {/* 删除本地文件确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除本地文件？"
        description={
          deleteTarget ? (
            <>
              将从磁盘永久删除{' '}
              <span className="break-all font-mono text-meta text-fg">{deleteTarget.path}</span>
              ，此操作无法撤销。
            </>
          ) : null
        }
        confirmLabel="删除文件"
        busy={deleting}
        onClose={() => {
          if (!deleting) setDeleteTarget(null)
        }}
        onConfirm={() => void confirmDelete()}
      >
        <label className="flex cursor-pointer items-start gap-2 rounded-control border border-line bg-surface-2/60 px-3 py-2 text-body text-fg-secondary">
          <Checkbox
            checked={removeTask}
            onChange={setRemoveTask}
            ariaLabel="同时删除下载记录"
            className="mt-0.5"
          />
          <span>
            同时删除对应的下载任务记录
            <span className="mt-0.5 block text-meta leading-4 text-fg-muted">
              不勾选时仅删除磁盘上的文件，任务历史仍保留。
            </span>
          </span>
        </label>
      </ConfirmDialog>
    </div>
  )
}
