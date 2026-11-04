import type { ReactNode } from 'react'
import type { FileKind, Source, TaskStatus } from '../../types'
import {
  FILE_KIND_LABEL,
  FILE_KIND_STYLE,
  SOURCE_LABEL,
  SOURCE_SHORT,
  SOURCE_STYLE,
  TASK_STATUS_LABEL,
  TASK_STATUS_STYLE,
} from '../../lib/labels'
import { cx } from '../../lib/cx'
import { AlertCircle, CheckCircle2, CircleArrowDown, CirclePause, CircleX, Clock, type LucideIcon } from '../icons'

export type BadgeTone =
  | 'slate'
  | 'blue'
  | 'emerald'
  | 'amber'
  | 'red'
  | 'violet'
  | 'sky'
  | 'indigo'

const TONE: Record<BadgeTone, string> = {
  slate: 'border-line bg-surface-2 text-fg-secondary',
  blue: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/60 dark:bg-blue-950/40 dark:text-blue-300',
  emerald:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  amber:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300',
  red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300',
  violet:
    'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-300',
  sky: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-300',
  indigo:
    'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-300',
}

const BADGE_BASE =
  'inline-flex max-w-full items-center gap-1 truncate rounded-control border px-1.5 py-0.5 text-meta font-medium leading-4'

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  className?: string
  title?: string
}

/** 通用小徽章（12px token，含 dark: 变体）。 */
export function Badge({ tone = 'slate', children, className, title }: BadgeProps) {
  return (
    <span title={title} className={cx(BADGE_BASE, TONE[tone], className)}>
      {children}
    </span>
  )
}

/** 数据来源徽章（dark: 变体见 labels.ts）。 */
export function SourceBadge({ source, short = false }: { source: Source; short?: boolean }) {
  const style = SOURCE_STYLE[source]
  return (
    <span className={cx(BADGE_BASE, 'shrink-0', style.chip)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', style.dot)} aria-hidden="true" />
      {short ? SOURCE_SHORT[source] : SOURCE_LABEL[source]}
    </span>
  )
}

/** 文件分类徽章（权重 / 投影器 / 权重矩阵 / 配置 / 其他）。 */
export function FileKindBadge({ kind }: { kind: FileKind }) {
  return (
    <span className={cx(BADGE_BASE, 'shrink-0', FILE_KIND_STYLE[kind])}>
      {FILE_KIND_LABEL[kind]}
    </span>
  )
}

const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  queued: Clock,
  active: CircleArrowDown,
  pausing: Clock,
  paused: CirclePause,
  completed: CheckCircle2,
  error: AlertCircle,
  cancelled: CircleX,
}

/** 状态同时由文字、图形和语义色表达。 */
export function StatusBadge({ status }: { status: TaskStatus }) {
  const style = TASK_STATUS_STYLE[status]
  const Icon = STATUS_ICON[status]
  return (
    <span className={cx(BADGE_BASE, 'shrink-0 px-2', style.badge)}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {TASK_STATUS_LABEL[status]}
    </span>
  )
}
