import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CheckCheck,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import type {
  DownloadTask,
  FileKind,
  RepoDetail,
  RepoFile,
  RepoSummary,
  RevisionList,
} from '../../types'
import {
  getRepoDetail,
  listRevisions,
  pickDirectory,
  startDownloads,
  toErrorText,
} from '../../lib/ipc'
import { defaultRevisionFor, formatBytes } from '../../lib/format'
import { isTerminalStatus } from '../../lib/labels'
import { taskMatchesDestination } from '../../lib/downloadPaths'
import { useAppStore } from '../../store/appStore'
import { cx } from '../../lib/cx'
import {
  APP_FOCUS_SEARCH_EVENT,
  APP_REFRESH_PAGE_EVENT,
} from '../layout/useGlobalShortcuts'
import { Button } from '../ui/Button'
import { ErrorBanner } from '../ui/ErrorBanner'
import { PathText } from '../ui/PathText'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Skeleton } from '../ui/Skeleton'
import { RepoDetailHeader, type FileStateInfo } from './RepoDetailHeader'
import { RevisionSelector } from './RevisionSelector'
import { FileTable } from './FileTable'

type LoadStatus = 'loading' | 'ready' | 'error'
type KindFilter = 'all' | FileKind

const KIND_OPTIONS: Array<{ value: KindFilter; label: string; title?: string }> = [
  { value: 'all', label: '全部' },
  { value: 'weight', label: '权重', title: '模型权重（weight）' },
  { value: 'mmproj', label: '投影器', title: '多模态投影器（mmproj）' },
  { value: 'imatrix', label: '矩阵', title: '权重矩阵（imatrix）' },
  { value: 'config', label: '配置', title: '配置文件（config）' },
  { value: 'other', label: '其他', title: '其他文件（other）' },
]

function findTask(
  tasks: DownloadTask[],
  source: RepoSummary['source'],
  repoId: string,
  remotePath: string,
  revision: string,
  saveDir: string,
): DownloadTask | undefined {
  return tasks.find(
    (task) =>
      task.remotePath === remotePath && taskMatchesDestination(task, source, repoId, revision, saveDir),
  )
}

export interface RepoDetailViewProps {
  repo: RepoSummary
  onBack: () => void
}

/** 仓库详情：文件多选、分类筛选、下载目录、开始下载。 */
export function RepoDetailView({ repo, onBack }: RepoDetailViewProps) {
  const settings = useAppStore((state) => state.settings)
  const defaultDownloadDir = useAppStore((state) => state.defaultDownloadDir)
  const tasks = useAppStore((state) => state.tasks)
  const upsertTasks = useAppStore((state) => state.upsertTasks)
  const pushToast = useAppStore((state) => state.pushToast)

  const [detail, setDetail] = useState<RepoDetail | null>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [fileQuery, setFileQuery] = useState('')
  const [saveDir, setSaveDir] = useState('')
  const [picking, setPicking] = useState(false)
  const [starting, setStarting] = useState(false)
  // v0.2.0：revision 选择
  const [revision, setRevision] = useState(() => defaultRevisionFor(repo.source))
  const [revisions, setRevisions] = useState<RevisionList | null>(null)
  const [revisionsLoading, setRevisionsLoading] = useState(true)
  const [revisionsError, setRevisionsError] = useState<string | null>(null)
  const [switchingRevision, setSwitchingRevision] = useState(false)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const detailRef = useRef<RepoDetail | null>(null)
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  const saveDirRef = useRef(saveDir)
  saveDirRef.current = saveDir
  const detailRequestSeq = useRef(0)

  const loadDetail = useCallback(
    async (targetRevision: string): Promise<boolean> => {
      const seq = ++detailRequestSeq.current
      if (detailRef.current) setSwitchingRevision(true)
      else setStatus('loading')
      setError('')
      try {
        const result = await getRepoDetail(repo.source, repo.id, targetRevision)
        if (seq !== detailRequestSeq.current) return false
        detailRef.current = result
        setDetail(result)
        setStatus('ready')
        // 默认勾选所有尚未下载/入队的模型文件（权重 + 投影器；权重矩阵不默认选）。
        const existing = useAppStore.getState().tasks
        const nextSelected = new Set<string>()
        for (const file of result.files) {
          if (file.kind !== 'weight' && file.kind !== 'mmproj') continue
          const task = findTask(existing, repo.source, repo.id, file.path, result.revision,
            saveDirRef.current || useAppStore.getState().settings?.downloadDir || '')
          if (task && (task.status === 'completed' || !isTerminalStatus(task.status))) continue
          nextSelected.add(file.path)
        }
        setSelected(nextSelected)
        return true
      } catch (err) {
        if (seq !== detailRequestSeq.current) return false
        setStatus('error')
        setError(toErrorText(err))
        return false
      } finally {
        if (seq === detailRequestSeq.current) setSwitchingRevision(false)
      }
    },
    [repo.id, repo.source],
  )

  const loadRevisions = useCallback(async () => {
    setRevisionsLoading(true)
    setRevisionsError(null)
    try {
      const list = await listRevisions(repo.source, repo.id)
      setRevisions(list)
      // 防御：若后端默认 revision 与本地约定不同，以返回值为准并重载。
      const fallback = defaultRevisionFor(repo.source)
      if (list.defaultRevision && list.defaultRevision !== fallback) {
        setRevision(list.defaultRevision)
        void loadDetail(list.defaultRevision)
      }
    } catch (err) {
      // 分支/标签拉取失败不阻塞默认 revision 浏览，仍可自定义输入。
      setRevisionsError(toErrorText(err))
    } finally {
      setRevisionsLoading(false)
    }
  }, [loadDetail, repo.id, repo.source])

  useEffect(() => {
    void loadRevisions()
    void loadDetail(defaultRevisionFor(repo.source))
  }, [loadDetail, loadRevisions, repo.source])

  /** 切换 revision：重新拉取文件列表，清空已选文件并提示。 */
  const handleSelectRevision = (next: string) => {
    if (!next || next === revision) return
    setRevision(next)
    setSelected(new Set())
    void loadDetail(next).then((ok) => {
      if (!ok) return
      useAppStore
        .getState()
        .pushToast('info', `已切换到 revision「${next}」`, '文件列表已刷新，选择已清空。')
    })
  }

  // 下载目录默认使用设置中的目录（快照异步到达后再填充）。
  useEffect(() => {
    if (saveDir) return
    const value = settings?.downloadDir || defaultDownloadDir
    if (value) setSaveDir(value)
  }, [defaultDownloadDir, saveDir, settings])

  // 全局快捷键：Ctrl/Cmd+F 聚焦文件筛选；F5 刷新仓库文件列表。
  useEffect(() => {
    const focusSearch = () => {
      if (useAppStore.getState().page !== 'browse') return
      filterInputRef.current?.focus()
      filterInputRef.current?.select()
    }
    const refresh = (event: Event) => {
      const detailInfo = (event as CustomEvent<{ page?: string }>).detail
      if (detailInfo?.page && detailInfo.page !== 'browse') return
      if (useAppStore.getState().page !== 'browse') return
      void loadDetail(revisionRef.current).then((ok) => {
        if (ok) useAppStore.getState().pushToast('info', '已刷新仓库文件列表')
      })
    }
    window.addEventListener(APP_FOCUS_SEARCH_EVENT, focusSearch)
    window.addEventListener(APP_REFRESH_PAGE_EVENT, refresh)
    return () => {
      window.removeEventListener(APP_FOCUS_SEARCH_EVENT, focusSearch)
      window.removeEventListener(APP_REFRESH_PAGE_EVENT, refresh)
    }
  }, [loadDetail])

  const taskMap = useMemo(() => {
    const map = new Map<string, DownloadTask>()
    for (const task of tasks) {
      if (taskMatchesDestination(task, repo.source, repo.id, revision, saveDir)) {
        map.set(task.remotePath, task)
      }
    }
    return map
  }, [repo.id, repo.source, tasks, revision, saveDir])

  const resolveState = useCallback(
    (file: RepoFile): FileStateInfo | null => {
      const task = taskMap.get(file.path)
      if (!task) return null
      if (task.status === 'completed') {
        return { label: '已下载', tone: 'emerald', disabled: true }
      }
      if (task.status === 'error' || task.status === 'cancelled') {
        return {
          label: task.status === 'error' ? '下载失败' : '已取消',
          tone: task.status === 'error' ? 'red' : 'amber',
          disabled: false,
        }
      }
      return { label: '队列中', tone: 'blue', disabled: true }
    },
    [taskMap],
  )

  const kindCounts = useMemo(() => {
    const counts: Record<FileKind, number> = {
      weight: 0,
      mmproj: 0,
      imatrix: 0,
      config: 0,
      other: 0,
    }
    for (const file of detail?.files ?? []) counts[file.kind] += 1
    return counts
  }, [detail])

  const filteredFiles = useMemo(() => {
    if (!detail) return []
    const keyword = fileQuery.trim().toLowerCase()
    return detail.files.filter((file) => {
      if (kindFilter !== 'all' && file.kind !== kindFilter) return false
      if (keyword && !file.path.toLowerCase().includes(keyword)) return false
      return true
    })
  }, [detail, fileQuery, kindFilter])

  const selection = useMemo(() => {
    if (!detail) return { files: [] as RepoFile[], totalSize: 0 }
    const picked = detail.files.filter((file) => selected.has(file.path))
    return {
      files: picked,
      totalSize: picked.reduce((sum, file) => sum + file.size, 0),
    }
  }, [detail, selected])

  const toggleFile = useCallback((path: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleMany = useCallback((paths: string[], checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous)
      for (const path of paths) {
        if (checked) next.add(path)
        else next.delete(path)
      }
      return next
    })
  }, [])

  const handleToggleAll = useCallback(
    (checked: boolean) => {
      const paths = filteredFiles
        .filter((file) => !resolveState(file)?.disabled)
        .map((file) => file.path)
      toggleMany(paths, checked)
    },
    [filteredFiles, resolveState, toggleMany],
  )

  const selectModelFiles = useCallback(() => {
    if (!detail) return
    const paths = detail.files
      .filter(
        (file) =>
          (file.kind === 'weight' || file.kind === 'mmproj') &&
          !resolveState(file)?.disabled,
      )
      .map((file) => file.path)
    toggleMany(paths, true)
  }, [detail, resolveState, toggleMany])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  const handlePickDir = async () => {
    setPicking(true)
    try {
      const picked = await pickDirectory(saveDir || undefined)
      if (picked) setSaveDir(picked)
    } catch (err) {
      pushToast('error', '选择下载目录失败', toErrorText(err))
    } finally {
      setPicking(false)
    }
  }

  const handleStart = async () => {
    if (!detail || switchingRevision || detail.revision !== revision || selection.files.length === 0) return
    if (!saveDir.trim()) {
      pushToast('error', '请先选择下载目录')
      return
    }
    setStarting(true)
    try {
      const requests = selection.files.map((file) => ({
        source: detail.source,
        repoId: detail.id,
        remotePath: file.path,
        size: file.size,
        saveDir: saveDir.trim(),
        // v0.2.0：下载请求携带当前 revision（缺省时后端按来源默认值）。
        revision,
      }))
      const created = await startDownloads(requests)
      upsertTasks(created)
      if (created.length > 0) {
        const skipped = requests.length - created.length
        pushToast(
          'success',
          `已加入下载队列：${created.length} 个文件`,
          skipped > 0 ? `另有 ${skipped} 个文件未新建任务（已有记录、无效请求或保存路径冲突）。` : undefined,
        )
        setSelected(new Set())
      } else {
        pushToast('info', '所选文件均已在队列或已下载', '未创建新的下载任务。')
      }
    } catch (err) {
      pushToast('error', '创建下载任务失败', toErrorText(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="repo-detail flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="shrink-0 border-b border-line bg-surface">
        <div className="workspace-inset py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              leftIcon={<ArrowLeft className="h-4 w-4" />}
            >
              返回搜索结果
            </Button>
            <div className="flex items-center gap-2">
              {switchingRevision ? (
                <span
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-1.5 text-meta text-primary"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  正在加载 revision「{revision}」…
                </span>
              ) : null}
              {status === 'ready' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadDetail(revision)}
                  loading={switchingRevision}
                  leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                >
                  刷新文件列表
                </Button>
              ) : null}
            </div>
          </div>

          {status === 'loading' ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-6 w-2/5" />
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3.5 w-1/2" />
            </div>
          ) : status === 'error' ? (
            <ErrorBanner message={error} onRetry={() => void loadDetail(revision)} />
          ) : detail ? (
            <>
              <RepoDetailHeader
                detail={detail}
                source={repo.source}
                revisionSelector={
                  <RevisionSelector
                    source={repo.source}
                    current={revision}
                    defaultRevision={revisions?.defaultRevision ?? defaultRevisionFor(repo.source)}
                    branches={revisions?.branches ?? []}
                    tags={revisions?.tags ?? []}
                    loading={revisionsLoading}
                    error={revisionsError}
                    disabled={switchingRevision}
                    onRetry={() => void loadRevisions()}
                    onSelect={handleSelectRevision}
                  />
                }
              />
              {revisionsError ? (
                <p className="mt-2 flex flex-wrap items-center gap-2 rounded-control border border-line bg-surface-2/60 px-2.5 py-1.5 text-meta text-fg-secondary">
                  分支 / 标签列表加载失败，仍可自定义 revision：
                  <Button size="xs" variant="ghost" onClick={() => void loadRevisions()}>
                    重试
                  </Button>
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={selectModelFiles}
                  title="选择全部权重与投影器文件（权重矩阵不默认选中）"
                  leftIcon={<CheckCheck className="h-3.5 w-3.5" />}
                >
                  全选模型文件
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={clearSelection}
                  leftIcon={<X className="h-3.5 w-3.5" />}
                >
                  清空选择
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="workspace-inset flex min-h-[300px] flex-1 flex-col py-4 md:min-h-0">
        {status === 'loading' ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-surface" aria-busy="true">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <Skeleton className="h-8 w-72" />
              <Skeleton className="h-8 w-44" />
            </div>
            <div className="space-y-3 p-4">
              {Array.from({ length: 10 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3">
                  <Skeleton className="h-4 w-4" />
                  <Skeleton className="h-3.5 flex-1" />
                  <Skeleton className="h-4 w-10" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
              ))}
            </div>
          </div>
        ) : status === 'error' ? (
          <div className="flex flex-1 items-center justify-center">
            <ErrorBanner
              message={error}
              title={`加载 revision「${revision}」的文件列表失败`}
              onRetry={() => void loadDetail(revision)}
            />
          </div>
        ) : detail ? (
          <div
            aria-busy={switchingRevision}
            className={cx(
              'flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-surface transition-opacity duration-micro',
              switchingRevision && 'opacity-60',
            )}
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  size="sm"
                  ariaLabel="按文件类型筛选"
                  value={kindFilter}
                  onChange={setKindFilter}
                  options={KIND_OPTIONS.map((option) => ({
                    ...option,
                    count:
                      option.value === 'all'
                        ? detail.files.length
                        : kindCounts[option.value as FileKind],
                  }))}
                />
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted"
                    aria-hidden="true"
                  />
                  <input
                    ref={filterInputRef}
                    value={fileQuery}
                    onChange={(event) => setFileQuery(event.target.value)}
                    placeholder="筛选文件名…"
                    aria-label="筛选文件名"
                    className="h-control w-52 rounded-control border border-line-strong bg-surface pl-8 pr-2 text-secondary text-fg transition-colors duration-micro placeholder:text-fg-muted focus-visible:border-primary"
                  />
                </div>
              </div>
              <span className="hidden text-meta text-fg-muted xl:block">
                共 {filteredFiles.length} 个文件
              </span>
            </div>

            <FileTable
              files={filteredFiles}
              selected={selected}
              resolveState={resolveState}
              onToggle={toggleFile}
              onToggleAll={handleToggleAll}
              emptyHint={
                detail.files.length === 0 ? '该仓库没有可下载的文件' : '没有匹配筛选条件的文件'
              }
            />

            <div className={cx('selection-shelf flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4', selection.files.length > 0 ? 'bg-primary-soft' : 'bg-surface-2')}>
              <div className="flex min-w-0 items-center gap-2">
                <FolderOpen className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                <span className="shrink-0 text-meta text-fg-secondary">保存到</span>
                <PathText
                  path={saveDir || '未选择下载目录'}
                  copyable={false}
                  className="max-w-[280px]"
                  onCopied={(text) => pushToast('success', '路径已复制', text)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handlePickDir()}
                  loading={picking}
                >
                  更改目录
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-meta text-fg-secondary">
                  已选{' '}
                  <span className="font-semibold tabular-nums text-fg">
                    {selection.files.length}
                  </span>{' '}
                  个 · {formatBytes(selection.totalSize)}
                </span>
                <Button
                  variant="primary"
                  disabled={switchingRevision || detail.revision !== revision || selection.files.length === 0}
                  loading={starting}
                  onClick={() => void handleStart()}
                  leftIcon={<Download className="h-4 w-4" />}
                >
                  开始下载
                  {selection.files.length > 0 ? ` (${selection.files.length})` : ''}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
