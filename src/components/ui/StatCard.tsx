import type { LucideIcon } from '../icons'
import type { ReactNode } from 'react'
import { Skeleton } from './Skeleton'
import { cx } from '../../lib/cx'

export type StatTone = 'blue' | 'emerald' | 'amber' | 'slate' | 'red' | 'violet'

const TONE: Record<StatTone, string> = {
  blue: 'text-primary',
  emerald:
    'text-success',
  amber: 'text-warning',
  slate: 'text-fg-muted',
  red: 'text-danger',
  violet:
    'text-primary',
}

export interface StatCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon: LucideIcon
  tone?: StatTone
  loading?: boolean
}

/** 开放式汇总项，供下载和模型库页面的连续统计栏使用。 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'blue',
  loading = false,
}: StatCardProps) {
  return (
    <div className="flex min-w-0 items-start gap-3 px-3 first:pl-0">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-meta font-medium text-fg-secondary"><Icon className={cx('h-3.5 w-3.5', TONE[tone])} aria-hidden="true" />{label}</p>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-16" />
        ) : (
          <p className="mt-2 truncate text-metric tabular-nums tracking-tight text-fg">
            {value}
          </p>
        )}
        <p className="mt-1 line-clamp-2 text-meta leading-4 text-fg-muted">
          {hint}
        </p>
      </div>
    </div>
  )
}
