import type { TaskStatus } from '../../types'
import { TASK_STATUS_STYLE } from '../../lib/labels'
import { cx } from '../../lib/cx'

export interface ProgressBarProps {
  /** 0-100；total 未知时传 0 并置 indeterminate */
  value: number
  status?: TaskStatus
  indeterminate?: boolean
  /** 兼容旧调用；进度条统一 8px 高 */
  size?: 'sm' | 'md'
  /** 读屏名称（任务名 + 状态），优先于 label */
  ariaLabel?: string
  /** ariaLabel 的别名 */
  label?: string
  className?: string
}

/**
 * 进度条（DESIGN-TOKENS §4.6）：
 * 8px 高、轨道 surface-2、填充 primary/状态色、transform: scaleX 动画、可访问名称。
 */
export function ProgressBar({
  value,
  status = 'active',
  indeterminate = false,
  size = 'sm',
  ariaLabel,
  label,
  className,
}: ProgressBarProps) {
  const style = TASK_STATUS_STYLE[status]
  const percentage = Math.max(0, Math.min(100, value))
  const accessibleName = ariaLabel ?? label
  const heightClass = size === 'sm' ? 'h-2' : 'h-2'

  return (
    <div
      role="progressbar"
      aria-label={accessibleName}
      aria-busy={indeterminate || undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percentage)}
      aria-valuetext={indeterminate ? `${accessibleName ?? '进度'}：正在下载` : `${Math.round(percentage)}%`}
      className={cx(
        'w-full overflow-hidden rounded-full bg-surface-2',
        heightClass,
        className,
      )}
    >
      {indeterminate ? (
        <div
          className="h-full w-full animate-shimmer rounded-full bg-gradient-to-r from-surface-3 via-primary to-surface-3 bg-[length:200%_100%]"
          aria-hidden="true"
        />
      ) : (
        <div
          className={cx(
            'h-full w-full origin-left rounded-full transition-transform duration-state ease-out will-change-transform',
            style.bar,
          )}
          style={{ transform: `scaleX(${percentage / 100})` }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
