import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Gauge,
  Inbox,
  ListTree,
  Pause,
  Play,
  SearchX,
  Trash2,
} from '../components/icons'
import type { DownloadTask, TaskStatus } from '../types'
import {
  cancelDownload,
  clearFinished,
  openPath,
  pauseAll,
  pauseDownload,
  removeTasks,
  resumeAll,
  resumeDownload,
  retryDownload,
  toErrorText,
} from '../lib/ipc'
import { formatPercent, formatSpeed } from '../lib/format'
import {
  SOURCE_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
  TASK_STATUS_STYLE,
  isRunningStatus,
  isTerminalStatus,
} from '../lib/labels'
import { useAppStore } from '../store/appStore'
import { APP_REFRESH_PAGE_EVENT } from '../components/layout/useGlobalShortcuts'
import { TaskRow } from '../components/downloads/TaskRow'
import { Button } from '../components/ui/Button'
import { Checkbox } from '../components/ui/Checkbox'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorBanner } from '../components/ui/ErrorBanner'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { StatCard } from '../components/ui/StatCard'
import { TaskRowSkeleton } from '../components/ui/Skeleton'
import { cx } from '../lib/cx'
import { countBatch, groupTaskBatches, type TaskBatch } from '../lib/taskBatches'

type FilterKey =
  | 'all'
  | 'running'
  | 'queued'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

const FILTER_LABELS: Record<FilterKey, string> = {
  all: '全部',
  running: '进行中',
  queued: '排队中',
  paused: '已暂停',
  completed: '已完成',
  error: '失败',
  cancelled: '已取消',
}

const STATUS_RANK: Record<TaskStatus, number> = {
  active: 0,
  pausing: 1,
  queued: 2,
  paused: 3,
  error: 4,
  completed: 5,
  cancelled: 6,
}

/** 任务数 > 300 时的「已完成」渲染上限（P2-2：避免上千行同时挂载掉帧）。 */
const HEAVY_TASK_THRESHOLD = 300
const COMPLETED_RENDER_STEP = 80

function matchesFilter(task: DownloadTask, filter: FilterKey): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'running':
      return isRunningStatus(task.status)
    case 'queued':
      return task.status === 'queued'
    case 'paused':
      return task.status === 'paused'
    case 'completed':
      return task.status === 'completed'
    case 'error':
      return task.status === 'error'
    case 'cancelled':
      return task.status === 'cancelled'
  }
}

export default function DownloadsPage() {
  const tasks = useAppStore((state) => state.tasks)
  const snapshotStatus = useAppStore((state) => state.snapshotStatus)
  const snapshotError = useAppStore((state) => state.snapshotError)
  const loadSnapshot = useAppStore((state) => state.loadSnapshot)
  const setPage = useAppStore((state) => state.setPage)
  const pushToast = useAppStore((state) => state.pushToast)

  const [filter, setFilter] = useState<FilterKey>('all')
  const [groupMode, setGroupMode] = useState<'flat' | 'status' | 'repo'>('repo')
  const [batchBusy, setBatchBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState<'pause' | 'resume' | 'clear' | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<DownloadTask | null>(null)
  const [cancelDeletePartial, setCancelDeletePartial] = useState(true)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [completedLimit, setCompletedLimit] = useState(COMPLETED_RENDER_STEP)

  // F5：重新拉取快照（不整页刷新）。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: string }>).detail
      if (detail?.page && detail.page !== 'downloads') return
      void loadSnapshot(true)
    }
    window.addEventListener(APP_REFRESH_PAGE_EVENT, handler)
    return () => window.removeEventListener(APP_REFRESH_PAGE_EVENT, handler)
  }, [loadSnapshot])

  const counts = useMemo(() => {
    const base = {
      all: tasks.length,
      running: 0,
      queued: 0,
      paused: 0,
      completed: 0,
      error: 0,
      cancelled: 0,
    }
    for (const task of tasks) {
      if (task.status === 'active' || task.status === 'pausing') base.running += 1
      else if (task.status === 'queued') base.queued += 1
      else if (task.status === 'paused') base.paused += 1
      else if (task.status === 'completed') base.completed += 1
      else if (task.status === 'error') base.error += 1
      else if (task.status === 'cancelled') base.cancelled += 1
    }
    return base
  }, [tasks])

  const runningTasks = useMemo(
    () => tasks.filter((task) => isRunningStatus(task.status)),
    [tasks],
  )
  const totalSpeed = runningTasks.reduce((sum, task) => sum + task.speed, 0)
  const terminalCount = counts.completed + counts.error + counts.cancelled
  const resumableCount = counts.paused + counts.error + counts.cancelled

  const visibleTasks = useMemo(() => {
    return tasks
      .filter((task) => matchesFilter(task, filter))
      .sort(
        (a, b) =>
          STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.addedAt - a.addedAt,
      )
  }, [filter, tasks])

  // 大量历史任务：只渲染最近 N 条「已完成」，其余按需展开（P2-2）。
  const heavyList = tasks.length > HEAVY_TASK_THRESHOLD
  const renderedTasks = useMemo(() => {
    if (!heavyList) return visibleTasks
    let completedRendered = 0
    return visibleTasks.filter((task) => {
      if (task.status !== 'completed') return true
      completedRendered += 1
      return completedRendered <= completedLimit
    })
  }, [completedLimit, heavyList, visibleTasks])

  const hiddenCompleted = heavyList ? visibleTasks.length - renderedTasks.length : 0

  const groupedSections = useMemo(() => {
    if (groupMode !== 'status') return []
    return TASK_STATUS_ORDER.map((status) => ({
      status,
      tasks: renderedTasks.filter((task) => task.status === status),
    })).filter((section) => section.tasks.length > 0)
  }, [groupMode, renderedTasks])

  const repoBatches = useMemo(
    () => (groupMode === 'repo' ? groupTaskBatches(renderedTasks) : []),
    [groupMode, renderedTasks],
  )

  const runTaskAction = async (
    task: DownloadTask,
    action: () => Promise<void>,
    successTitle?: string,
  ) => {
    setPending((previous) => {
      const next = new Set(previous)
      next.add(task.taskId)
      return next
    })
    try {
      await action()
      if (successTitle) pushToast('success', successTitle)
    } catch (err) {
      pushToast('error', '操作失败', toErrorText(err))
    } finally {
      setPending((previous) => {
        const next = new Set(previous)
        next.delete(task.taskId)
        return next
      })
    }
  }

  const handlePause = (task: DownloadTask) => {
    void runTaskAction(task, () => pauseDownload(task.taskId), '已请求暂停')
  }
  const handleResume = (task: DownloadTask) => {
    void runTaskAction(task, () => resumeDownload(task.taskId), '已加入继续队列')
  }
  const handleRetry = (task: DownloadTask) => {
    void runTaskAction(task, () => retryDownload(task.taskId), '已重新加入下载队列')
  }
  const handleRemove = (task: DownloadTask) => {
    void runTaskAction(task, async () => {
      await removeTasks([task.taskId])
      useAppStore.getState().removeTasks([task.taskId])
    }, '已删除任务记录')
  }
  const handleOpenLocation = (task: DownloadTask) => {
    const target = task.status === 'completed' ? task.savePath : task.tempPath
    void openPath(target, true).catch((err: unknown) => {
      pushToast('error', '无法打开所在位置', toErrorText(err))
    })
  }
  const handleCancelRequest = (task: DownloadTask) => {
    setCancelDeletePartial(true)
    setCancelTarget(task)
  }

  const handleConfirmCancel = async () => {
    if (!cancelTarget) return
    setCancelBusy(true)
    try {
      await cancelDownload(cancelTarget.taskId, cancelDeletePartial)
      pushToast(
        'success',
        '已取消下载',
        cancelDeletePartial
          ? '已删除已下载的临时文件。'
          : '已保留临时文件，之后可继续断点续传。',
      )
      setCancelTarget(null)
    } catch (err) {
      pushToast('error', '取消下载失败', toErrorText(err))
    } finally {
      setCancelBusy(false)
    }
  }

  const handleBatch = async (batch: TaskBatch, action: 'pause' | 'resume' | 'retry') => {
    const targets = batch.tasks.filter((task) => {
      if (action === 'pause') return isRunningStatus(task.status) || task.status === 'queued'
      if (action === 'resume') return task.status === 'paused'
      return task.status === 'error'
    })
    if (targets.length === 0) return
    setBatchBusy(batch.key)
    try {
      for (const task of targets) {
        if (action === 'pause') await pauseDownload(task.taskId)
        else if (action === 'resume') await resumeDownload(task.taskId)
        else await retryDownload(task.taskId)
      }
      const title =
        action === 'pause' ? '已暂停这一批' : action === 'resume' ? '已继续这一批' : '已重试失败文件'
      pushToast('success', title, `${batch.repoId} · ${targets.length} 个文件`)
    } catch (err) {
      pushToast('error', '批次操作失败', toErrorText(err))
    } finally {
      setBatchBusy(null)
    }
  }

  const handlePauseAll = async () => {
    setBulkBusy('pause')
    try {
      await pauseAll()
      pushToast('success', '已暂停全部任务')
    } catch (err) {
      pushToast('error', '暂停全部失败', toErrorText(err))
    } finally {
      setBulkBusy(null)
    }
  }

  const handleResumeAll = async () => {
    setBulkBusy('resume')
    try {
      await resumeAll()
      pushToast('success', '已继续全部可恢复任务')
    } catch (err) {
      pushToast('error', '继续全部失败', toErrorText(err))
    } finally {
      setBulkBusy(null)
    }
  }

  const handleClearFinished = async () => {
    setBulkBusy('clear')
    try {
      await clearFinished()
      useAppStore
        .getState()
        .removeTasks(tasks.filter((task) => isTerminalStatus(task.status)).map((t) => t.taskId))
      setClearOpen(false)
      pushToast('success', '已清除已结束的任务记录')
    } catch (err) {
      pushToast('error', '清除失败', toErrorText(err))
    } finally {
      setBulkBusy(null)
    }
  }

  const filterOptions = (Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => ({
    value: key,
    label: FILTER_LABELS[key],
    count: counts[key],
  }))

  const renderTask = (task: DownloadTask) => (
    <TaskRow
      key={task.taskId}
      task={task}
      busy={pending.has(task.taskId)}
      onPause={handlePause}
      onResume={handleResume}
      onCancel={handleCancelRequest}
      onRetry={handleRetry}
      onOpenLocation={handleOpenLocation}
      onRemove={handleRemove}
    />
  )

  const initialLoading = snapshotStatus === 'loading' && tasks.length === 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-container space-y-6 pb-8">
        {snapshotStatus === 'error' ? (
          <ErrorBanner
            title="无法加载下载任务"
            message={snapshotError ?? '未知错误'}
            onRetry={() => void loadSnapshot(true)}
          />
        ) : null}

        {/* 连续汇总栏 */}
        <div className="summary-strip">
          <StatCard
            label="进行中"
            value={counts.running}
            hint={`队列中 ${counts.queued} 个任务`}
            icon={Activity}
            tone="blue"
            loading={initialLoading}
          />
          <StatCard
            label="总速度"
            value={totalSpeed > 0 ? formatSpeed(totalSpeed) : '0 B/s'}
            hint={`${counts.running} 个任务并行下载`}
            icon={Gauge}
            tone="violet"
            loading={initialLoading}
          />
          <StatCard
            label="已完成"
            value={counts.completed}
            hint={`累计完成 ${counts.completed} 个文件`}
            icon={CheckCircle2}
            tone="emerald"
            loading={initialLoading}
          />
          <StatCard
            label="已暂停"
            value={counts.paused}
            hint={`失败 ${counts.error} · 已取消 ${counts.cancelled}`}
            icon={Pause}
            tone="amber"
            loading={initialLoading}
          />
        </div>

        {/* 筛选与全局操作 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            ariaLabel="按状态筛选下载任务"
            value={filter}
            onChange={setFilter}
            options={filterOptions}
            size="sm"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <SegmentedControl
              size="sm"
              ariaLabel="任务分组方式"
              value={groupMode}
              onChange={setGroupMode}
              options={[
                { value: 'flat', label: '列表' },
                { value: 'status', label: '状态' },
                { value: 'repo', label: '仓库' },
              ]}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void handlePauseAll()}
              loading={bulkBusy === 'pause'}
              disabled={counts.running + counts.queued === 0 || bulkBusy !== null}
              leftIcon={<Pause className="h-3.5 w-3.5" />}
            >
              全部暂停
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void handleResumeAll()}
              loading={bulkBusy === 'resume'}
              disabled={resumableCount === 0 || bulkBusy !== null}
              leftIcon={<Play className="h-3.5 w-3.5" />}
            >
              全部继续
            </Button>
            <Button
              size="sm"
              variant="dangerGhost"
              onClick={() => setClearOpen(true)}
              disabled={terminalCount === 0 || bulkBusy !== null}
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            >
              清除已完成
            </Button>
          </div>
        </div>

        {/* 任务列表 */}
        {initialLoading ? (
          <div className="overflow-hidden rounded-card border border-line bg-surface" aria-busy="true">
            {Array.from({ length: 4 }).map((_, index) => (
              <TaskRowSkeleton key={index} />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-card border border-line bg-surface">
            <EmptyState
              icon={Inbox}
              title="下载队列为空"
              description="去浏览仓库挑选模型文件，下载进度、速度与断点续传状态都会显示在这里。"
              action={
                <Button
                  variant="primary"
                  onClick={() => setPage('browse')}
                  leftIcon={<Activity className="h-4 w-4" />}
                >
                  去浏览仓库
                </Button>
              }
            />
          </div>
        ) : visibleTasks.length === 0 ? (
          <div className="rounded-card border border-line bg-surface">
            <EmptyState
              icon={SearchX}
              title={`没有“${FILTER_LABELS[filter]}”的任务`}
              description="试试切换筛选条件，或查看全部任务。"
              action={
                <Button variant="secondary" onClick={() => setFilter('all')}>
                  查看全部任务
                </Button>
              }
            />
          </div>
        ) : groupMode === 'repo' ? (
          <div className="space-y-3">
            {repoBatches.map((batch) => {
              const counts = countBatch(batch.tasks)
              const summary = [
                counts.running > 0 ? `进行中 ${counts.running}` : '',
                counts.queued > 0 ? `排队 ${counts.queued}` : '',
                counts.paused > 0 ? `暂停 ${counts.paused}` : '',
                counts.completed > 0 ? `完成 ${counts.completed}` : '',
                counts.failed > 0 ? `失败 ${counts.failed}` : '',
                counts.cancelled > 0 ? `取消 ${counts.cancelled}` : '',
              ].filter(Boolean)
              return (
                <section
                  key={batch.key}
                  className="overflow-hidden rounded-card border border-line bg-surface"
                >
                  <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2">
                    <ListTree className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
                    <h3 className="min-w-0 truncate text-secondary font-semibold text-fg" title={batch.repoId}>
                      {batch.repoId}
                    </h3>
                    <span className="text-meta text-fg-muted">
                      {SOURCE_LABEL[batch.source]} · {batch.revision || '默认'} · {summary.join(' · ')}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={counts.running + counts.queued === 0 || batchBusy !== null}
                        loading={batchBusy === batch.key}
                        onClick={() => void handleBatch(batch, 'pause')}
                      >
                        暂停本批
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={counts.paused === 0 || batchBusy !== null}
                        onClick={() => void handleBatch(batch, 'resume')}
                      >
                        继续本批
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={counts.failed === 0 || batchBusy !== null}
                        onClick={() => void handleBatch(batch, 'retry')}
                      >
                        重试失败
                      </Button>
                    </div>
                  </header>
                  <div role="list" aria-label={`${batch.repoId} 的下载任务`}>
                    {batch.tasks.map(renderTask)}
                  </div>
                </section>
              )
            })}
          </div>
        ) : groupMode === 'status' ? (
          <div className="space-y-3">
            {groupedSections.map((section) => (
              <section
                key={section.status}
                className="overflow-hidden rounded-card border border-line bg-surface"
              >
                <header className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2">
                  <span
                    className={cx(
                      'h-2 w-2 rounded-full',
                      TASK_STATUS_STYLE[section.status].dot,
                    )}
                    aria-hidden="true"
                  />
                  <h3 className="text-secondary font-semibold text-fg">
                    {TASK_STATUS_LABEL[section.status]}
                  </h3>
                  <span className="text-meta text-fg-muted">
                    {section.tasks.length} 个任务
                  </span>
                </header>
                <div role="list" aria-label={`${TASK_STATUS_LABEL[section.status]}任务`}>
                  {section.tasks.map(renderTask)}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div
            role="list"
            aria-label="下载任务列表"
            className="overflow-hidden rounded-card border border-line bg-surface"
          >
            {renderedTasks.map(renderTask)}
          </div>
        )}

        {/* 大量历史任务：按需展开更多「已完成」 */}
        {hiddenCompleted > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-card border border-dashed border-line px-3 py-2">
            <span className="text-meta text-fg-muted">
              为保持流畅，已折叠 {hiddenCompleted} 个已完成任务（共 {tasks.length} 个任务）
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setCompletedLimit((limit) => limit + COMPLETED_RENDER_STEP)
              }
            >
              再显示 {Math.min(COMPLETED_RENDER_STEP, hiddenCompleted)} 个
            </Button>
          </div>
        ) : null}

        {tasks.length > 0 ? (
          <p className="flex flex-wrap items-center justify-end gap-3 text-meta text-fg-muted">
            <span>共 {tasks.length} 个任务</span>
            <span>进行中 {counts.running}</span>
            <span>已完成 {counts.completed}</span>
            <span>
              完成度{' '}
              {tasks.length > 0 ? formatPercent(counts.completed, tasks.length) : 0}%
            </span>
          </p>
        ) : null}
      </div>

      {/* 取消下载确认 */}
      <ConfirmDialog
        open={cancelTarget !== null}
        title="取消下载任务？"
        description={
          cancelTarget ? (
            <>
              将停止下载{' '}
              <span className="font-medium text-fg">{cancelTarget.fileName}</span>
              ，任务状态会变为“已取消”。
            </>
          ) : null
        }
        confirmLabel="取消下载"
        cancelLabel="返回"
        busy={cancelBusy}
        onClose={() => {
          if (!cancelBusy) setCancelTarget(null)
        }}
        onConfirm={() => void handleConfirmCancel()}
      >
        <label className="flex cursor-pointer items-start gap-2 rounded-control border border-line bg-surface-2/60 px-3 py-2 text-body text-fg-secondary">
          <Checkbox
            checked={cancelDeletePartial}
            onChange={setCancelDeletePartial}
            ariaLabel="同时删除已下载的临时文件"
            className="mt-0.5"
          />
          <span>
            同时删除已下载的临时文件（.part）
            <span className="mt-0.5 block text-meta leading-4 text-fg-muted">
              不勾选则保留断点数据，之后可继续下载。
            </span>
          </span>
        </label>
      </ConfirmDialog>

      {/* 清除已完成确认 */}
      <ConfirmDialog
        open={clearOpen}
        title="清除已结束的任务记录？"
        description="将移除已完成、失败和已取消的任务记录；磁盘上已下载的文件不会被删除。"
        confirmLabel="清除记录"
        busy={bulkBusy === 'clear'}
        onClose={() => {
          if (bulkBusy !== 'clear') setClearOpen(false)
        }}
        onConfirm={() => void handleClearFinished()}
      />
    </div>
  )
}
