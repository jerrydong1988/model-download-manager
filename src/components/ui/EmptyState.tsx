import type { LucideIcon } from '../icons'
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'

export interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
  className?: string
}

/** 空状态：图标 + 说明 + 可选操作（语义 token + 暗色）。 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 py-8' : 'gap-3 py-16',
        className,
      )}
    >
      <div
        className={cx(
          'grid place-items-center rounded-card bg-surface-2 text-fg-muted',
          compact ? 'h-10 w-10' : 'h-14 w-14',
        )}
      >
        <Icon className={compact ? 'h-5 w-5' : 'h-7 w-7'} aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <h3 className={cx('font-medium text-fg', compact ? 'text-body' : 'text-section')}>
          {title}
        </h3>
        {description ? (
          <p className="mx-auto max-w-md text-secondary leading-6 text-fg-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
    </div>
  )
}
