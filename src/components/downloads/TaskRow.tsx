import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertCircle,
  ArrowDown,
  Boxes,
  CheckCircle2,
  Clock,
  FileCog,
  FileText,
  FolderOpen,
  Grid3x3,
  Pause,
  Play,
  Projector,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import type { DownloadTask } from '../../types'
import {
  defaultRevisionFor,
  formatBytes,
  formatEta,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
} from '../../lib/format'
import { TASK_STATUS_LABEL, isRunningStatus } from '../../lib/labels'
import { Badge, StatusBadge, SourceBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { PathText } from '../ui/PathText'
import { ProgressBar } from '../ui/ProgressBar'
import { cx } from '../../lib/cx'

const WEIGHT_EXTENSIONS = new Set([
  '.safetensors',
  '.bin',
  '.pt',
  '.pth',
  '.gguf',
  '.onnx',
  '.ckpt',
  '.h5',
  '.msgpack',
  '.npz',
  '.engine',
  '.tflite',
  '.pkl',
  '.hgn',
])

const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.md',
  '.model',
  '.tiktoken',
  '.py',
  '.jinja',
  '.cfg',
  '.ini',
  '.toml',
])

function fileVisual(fileName: string): {
  icon: LucideIcon
  tone: string
  label: string
} {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot) : ''
  const base = lower.split('/').pop() ?? lower
  if (base.includes('imatrix')) {
    return {
      icon: Grid3x3,
      tone: 'border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300',
      label: '权重矩阵文件',
    }
  }
  if (
    WEIGHT_EXTENSIONS.has(ext) &&
    (base.includes('mmproj') || base.includes('clip'))
  ) {
    return {
      icon: Projector,
      tone: 'border-violet-200 bg-violet-50 text-violet-600 dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-300',
      label: '投影器文件',
    }
  }
  if (WEIGHT_EXTENSIONS.has(ext)) {
    return {
      icon: Boxes,
      tone: 'border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-300',
      label: '权重文件',
    }
  }
  if (CONFIG_EXTENSIONS.has(ext)) {
    return {
      icon: FileCog,
      tone: 'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300',
      label: '配置文件',
    }
  }
  return {
    icon: FileText,
    tone: 'border-line bg-surface-2 text-fg-muted',
    label: '其他文件',
  }
}

export interface TaskRowProps {
  task: DownloadTask
  busy?: boolean
  onPause: (task: DownloadTask) => void
  onResume: (task: DownloadTask) => void
  onCancel: (task: DownloadTask) => void
  onRetry: (task: DownloadTask) => void
  onOpenLocation: (task: DownloadTask) => void
  onRemove: (task: DownloadTask) => void
}

export function TaskRow({
  task,
  busy = false,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onOpenLocation,
  onRemove,
}: TaskRowProps) {
  const visual = fileVisual(task.fileName)
  const FileIcon = visual.icon
  const totalKnown = task.totalSize > 0
  const running = isRunningStatus(task.status)
  const percent = formatPercent(task.downloaded, task.totalSize)
  const remaining = totalKnown ? Math.max(0, task.totalSize - task.downloaded) : 0
  const eta = formatEta(remaining, task.speed)
  const indeterminate =
    !totalKnown &&
    (task.status === 'active' || task.status === 'queued' || task.status === 'pausing')
  const speedVisible = running && task.speed > 0

  /** 行内操作按钮：36×36，相邻间距 ≥4px（P2-7）。 */
  const iconButton = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    options?: { danger?: boolean; disabled?: boolean },
  ) => (
    <Button
      variant={options?.danger ? 'dangerGhost' : 'ghost'}
      size="icon"
      title={label}
      aria-label={`${label}：${task.fileName}`}
      disabled={busy || options?.disabled}
      onClick={onClick}
    >
      {icon}
    </Button>
  )

  const actions = (() => {
    if (task.status === 'active' || task.status === 'pausing' || task.status === 'queued') {
      return (
        <>
          {iconButton(
            '暂停下载',
            <Pause className="h-4 w-4" aria-hidden="true" />,
            () => onPause(task),
            { disabled: task.status === 'pausing' },
          )}
          {task.status !== 'queued'
            ? iconButton(
                '打开所在位置',
                <FolderOpen className="h-4 w-4" aria-hidden="true" />,
                () => onOpenLocation(task),
              )
            : null}
          {iconButton(
            '取消下载',
            <X className="h-4 w-4" aria-hidden="true" />,
            () => onCancel(task),
            { danger: true },
          )}
        </>
      )
    }
    if (task.status === 'paused') {
      return (
        <>
          {iconButton(
            '继续下载',
            <Play className="h-4 w-4" aria-hidden="true" />,
            () => onResume(task),
          )}
          {iconButton(
            '打开所在位置',
            <FolderOpen className="h-4 w-4" aria-hidden="true" />,
            () => onOpenLocation(task),
          )}
          {iconButton(
            '取消下载',
            <X className="h-4 w-4" aria-hidden="true" />,
            () => onCancel(task),
            { danger: true },
          )}
        </>
      )
    }
    if (task.status === 'error') {
      return (
        <>
          {iconButton(
            '重试下载',
            <RotateCcw className="h-4 w-4" aria-hidden="true" />,
            () => onRetry(task),
          )}
          {iconButton(
            '打开所在位置',
            <FolderOpen className="h-4 w-4" aria-hidden="true" />,
            () => onOpenLocation(task),
          )}
          {iconButton(
            '删除任务记录',
            <Trash2 className="h-4 w-4" aria-hidden="true" />,
            () => onRemove(task),
          )}
        </>
      )
    }
    if (task.status === 'cancelled') {
      return (
        <>
          {iconButton(
            '重新开始',
            <Play className="h-4 w-4" aria-hidden="true" />,
            () => onResume(task),
          )}
          {iconButton(
            '删除任务记录',
            <Trash2 className="h-4 w-4" aria-hidden="true" />,
            () => onRemove(task),
          )}
        </>
      )
    }
    // completed
    return (
      <>
        {iconButton(
          '打开所在位置',
          <FolderOpen className="h-4 w-4" aria-hidden="true" />,
          () => onOpenLocation(task),
        )}
        {iconButton(
          '删除任务记录',
          <Trash2 className="h-4 w-4" aria-hidden="true" />,
          () => onRemove(task),
        )}
      </>
    )
  })()

  return (
    <div
      role="listitem"
      className={cx(
        'border-b border-line px-4 py-4 last:border-b-0',
        task.status === 'error' && 'bg-danger/5',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cx(
            'grid h-9 w-9 shrink-0 place-items-center rounded-control bg-surface-2 text-fg-muted',
          )}
          title={visual.label}
        >
          <FileIcon className="h-4 w-4" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="max-w-full truncate text-body font-medium text-fg" title={task.remotePath}>
              {task.fileName}
            </p>
            <StatusBadge status={task.status} />
            {task.retries > 0 && task.status !== 'completed' ? (
              <span className="rounded-control border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-meta font-medium text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
                重试 {task.retries} 次
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-meta text-fg-muted">
            <span className="truncate text-fg-secondary" title={task.repoId}>
              {task.repoId}
            </span>
            <SourceBadge source={task.source} short />
            {task.revision && task.revision !== defaultRevisionFor(task.source) ? (
              <Badge tone="indigo" title={`下载使用的 revision：${task.revision}`}>
                revision {task.revision}
              </Badge>
            ) : null}
            <PathText
              path={task.savePath}
              copyable={false}
              className="hidden min-w-0 flex-1 md:flex"
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>

      <div className="mt-2 pl-12">
        <ProgressBar
          value={percent}
          status={task.status}
          indeterminate={indeterminate}
          ariaLabel={`${task.fileName}，${TASK_STATUS_LABEL[task.status]}${
            indeterminate ? '' : `，${percent}%`
          }`}
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-meta text-fg-muted">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {task.status === 'completed' ? (
              <span className="inline-flex items-center gap-1 text-success">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                已下载 {formatBytes(task.downloaded)}
              </span>
            ) : (
              <span>
                已下载{' '}
                <span className="font-medium tabular-nums text-fg-secondary">
                  {formatBytes(task.downloaded)}
                </span>
                {totalKnown ? ` / ${formatBytes(task.totalSize)}` : ' / 大小未知'}
              </span>
            )}
            {task.status === 'active' && totalKnown ? (
              <span className="font-medium tabular-nums text-primary">{percent}%</span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {speedVisible ? (
              <span className="inline-flex items-center gap-1 font-medium tabular-nums text-primary">
                <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                {formatSpeed(task.speed)}
              </span>
            ) : null}
            {running && totalKnown ? (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                剩余 {eta}
              </span>
            ) : null}
            {task.status === 'queued' ? <span>等待空闲并发槽…</span> : null}
            {task.status === 'pausing' ? <span className="text-warning">正在保存临时文件…</span> : null}
            {task.status === 'paused' ? (
              <span className="text-warning">已暂停 · 支持断点续传</span>
            ) : null}
            {task.status === 'completed' && task.completedAt ? (
              <span>完成于 {formatRelativeTime(task.completedAt)}</span>
            ) : null}
            {task.status === 'cancelled' ? <span>已取消</span> : null}
            {task.status === 'error' ? (
              <span className="text-danger">已重试 {task.retries} 次</span>
            ) : null}
            <span className="sr-only">{TASK_STATUS_LABEL[task.status]}</span>
          </div>
        </div>

        {task.error ? (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 rounded-control border border-danger/40 bg-danger/5 px-2.5 py-2 text-meta leading-5 text-danger"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="break-words">{task.error}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
