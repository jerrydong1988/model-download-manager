import { useRef, type KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from '../../lib/cx'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** 悬停/读屏用的完整名称（label 使用短词时补充） */
  title?: string
  icon?: LucideIcon
  count?: number
}

export interface SegmentedControlProps<T extends string> {
  options: Array<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 分段控件（来源切换 / 筛选）。
 * WAI-ARIA 工具栏模式：←/→/↑/↓ 移动并选中、Home/End 跳转，roving tabindex。
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  const selectAt = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    requestAnimationFrame(() => buttonRefs.current[index]?.focus())
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % options.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + options.length) % options.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = options.length - 1
    }
    if (nextIndex === null) return
    event.preventDefault()
    selectAt(nextIndex)
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cx(
        'inline-flex shrink-0 items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5',
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttonRefs.current[index] = element
            }}
            type="button"
            aria-pressed={active}
            tabIndex={active ? 0 : -1}
            title={option.title}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cx(
              'inline-flex cursor-pointer items-center gap-1.5 rounded-[4px] border font-medium transition-colors duration-micro',
              size === 'sm' ? 'h-sm px-2.5 text-meta' : 'h-md px-3 text-meta',
              active
                ? 'border-line bg-surface text-fg'
                : 'border-transparent text-fg-secondary hover:bg-surface/60 hover:text-fg',
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            {option.label}
            {option.count !== undefined ? (
              <span
                className={cx(
                  'rounded px-1 text-meta tabular-nums',
                  active ? 'bg-surface-2 text-fg-secondary' : 'text-fg-muted',
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
