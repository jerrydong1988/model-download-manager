import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import { cx } from '../../lib/cx'

export const inputClass =
  'h-control w-full rounded-control border border-line-strong bg-surface px-3 text-body text-fg transition-colors duration-micro placeholder:text-fg-muted focus-visible:border-primary disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-disabled'

/** 统一文本输入框（36px，实色焦点边框 + 全局 focus ring）。 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(inputClass, className)} {...rest} />
  },
)

export interface FieldProps {
  label: string
  htmlFor?: string
  hint?: ReactNode
  error?: string
  optional?: boolean
  children: ReactNode
  className?: string
}

/**
 * 表单字段：可见 label + 控件 + 帮助/错误信息。
 * hint/error 使用 12px token；error 带 role="alert" 与 aria-describedby。
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional = false,
  children,
  className,
}: FieldProps) {
  const autoId = useId()
  const hintId = `${autoId}-hint`
  const errorId = `${autoId}-error`
  const descriptionId = error ? errorId : hint ? hintId : undefined

  let control = children
  if (descriptionId && isValidElement(children) && typeof children.type !== 'string') {
    control = cloneElement(
      children as ReactElement<{
        'aria-describedby'?: string
        'aria-invalid'?: boolean
      }>,
      {
        'aria-describedby': descriptionId,
        ...(error ? { 'aria-invalid': true } : {}),
      },
    )
  }

  return (
    <div className={cx('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-meta font-medium text-fg-secondary">
          {label}
        </label>
        {optional ? <span className="text-meta text-fg-muted">可选</span> : null}
      </div>
      {control}
      {error ? (
        <p id={errorId} className="text-meta leading-5 text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-meta leading-5 text-fg-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
