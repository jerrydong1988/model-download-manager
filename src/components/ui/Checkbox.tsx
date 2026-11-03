import { useEffect, useRef } from 'react'
import { cx } from '../../lib/cx'

export interface CheckboxProps {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** 无可见文本时必填，供读屏使用 */
  ariaLabel: string
  className?: string
}

/** 原生 checkbox（保留键盘与读屏语义），支持 indeterminate 半选态。 */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  disabled = false,
  ariaLabel,
  className,
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className={cx(
        'h-4 w-4 shrink-0 cursor-pointer rounded-[4px] border border-line-strong bg-surface accent-primary transition-colors duration-micro disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    />
  )
}
