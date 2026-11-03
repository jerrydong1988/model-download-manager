import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from './Skeleton'
import { cx } from '../../lib/cx'

export type StatTone = 'blue' | 'emerald' | 'amber' | 'slate' | 'red' | 'violet'

const TONE: Record<StatTone, string> = {
  blue: 'bg-primary-soft text-primary',
  emerald:
    'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300',
  slate: 'bg-surface-2 text-fg-muted',
  red: 'bg-red-50 text-red-500 dark:bg-red-950/40 dark:text-red-300',
  violet:
    'bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300',
}

export interface StatCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon: LucideIcon
  tone?: StatTone
  loading?: boolean
}

/** 指标卡（下载队列 / 本地库汇总，12/24/12 字号阶梯 + 暗色）。 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'blue',
  loading = false,
}: StatCardProps) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-card border border-line bg-surface p-4">
      <div className="min-w-0">
        <p className="text-meta font-medium text-fg-secondary">{label}</p>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-16" />
        ) : (
          <p className="mt-1 truncate text-metric tabular-nums tracking-tight text-fg">
            {value}
          </p>
        )}
        <p className="mt-1 min-h-8 line-clamp-2 text-meta leading-4 text-fg-muted">
          {hint}
        </p>
      </div>
      <div className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-control', TONE[tone])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
    </div>
  )
}
