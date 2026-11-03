import { cx } from '../../lib/cx'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel: string
  className?: string
}

/** 开关（role=switch，键盘可达，24px 高触控目标）。 */
export function Switch({ checked, onChange, disabled = false, ariaLabel, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-micro disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-surface-3 hover:bg-line-strong',
        className,
      )}
    >
      <span
        className={cx(
          'inline-block h-5 w-5 transform rounded-full border border-line bg-surface transition-transform duration-state',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
        aria-hidden="true"
      />
    </button>
  )
}
