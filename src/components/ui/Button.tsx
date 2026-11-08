import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from '../icons'
import { cx } from '../../lib/cx'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'dangerGhost'
  | 'subtle'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'icon' | 'icon-sm'

const BASE =
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control border font-medium transition-colors duration-micro disabled:cursor-not-allowed disabled:opacity-50'

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'border-primary/25 bg-primary-soft text-primary hover:border-primary/40 hover:bg-primary/10 active:bg-primary/15',
  secondary:
    'border-line bg-surface text-fg hover:bg-surface-2 active:bg-surface-3',
  ghost:
    'border-transparent bg-transparent text-fg-secondary hover:bg-surface-2 hover:text-fg active:bg-surface-3',
  danger:
    'border-transparent bg-danger text-white hover:bg-danger/90 active:bg-danger/80 dark:text-bg',
  dangerGhost:
    'border-transparent bg-transparent text-danger hover:bg-danger/10 active:bg-danger/15',
  subtle:
    'border-transparent bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg active:bg-surface-3',
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-xs px-2.5 text-meta',
  sm: 'h-sm px-3 text-meta',
  md: 'h-md px-3.5 text-body',
  lg: 'h-lg px-4 text-body',
  xl: 'h-12 px-6 text-body',
  icon: 'h-9 w-9 p-0',
  'icon-sm': 'h-9 w-9 p-0',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(BASE, VARIANT[variant], SIZE[size], className)}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  )
})
