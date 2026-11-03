import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import {
  useAppStore,
  type ToastAction,
  type ToastItem,
  type ToastKind,
} from '../../store/appStore'
import { Button } from './Button'
import { cx } from '../../lib/cx'

const KIND_META: Record<
  ToastKind,
  { icon: typeof CheckCircle2; iconClass: string; accent: string }
> = {
  success: {
    icon: CheckCircle2,
    iconClass: 'text-success',
    accent: 'border-l-2 border-l-success',
  },
  error: {
    icon: AlertCircle,
    iconClass: 'text-danger',
    accent: 'border-l-2 border-l-danger',
  },
  info: {
    icon: Info,
    iconClass: 'text-primary',
    accent: 'border-l-2 border-l-primary',
  },
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const dismissToast = useAppStore((state) => state.dismissToast)
  const meta = KIND_META[toast.kind]
  const Icon = meta.icon
  const action: ToastAction | undefined = toast.action

  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), 4600)
    return () => window.clearTimeout(timer)
  }, [toast.id, dismissToast])

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={cx(
        'pointer-events-auto flex w-80 items-start gap-2.5 rounded-control border border-line bg-surface p-3 shadow-toast animate-slide-up',
        meta.accent,
      )}
    >
      <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', meta.iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium leading-5 text-fg">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 break-words text-meta leading-5 text-fg-secondary">
            {toast.description}
          </p>
        ) : null}
        {action ? (
          <Button
            variant="ghost"
            size="xs"
            className="mt-1.5 px-0 text-primary hover:bg-transparent hover:text-primary-hover hover:underline"
            onClick={() => {
              action.onClick()
              dismissToast(toast.id)
            }}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="关闭提示"
        className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-control text-fg-muted transition-colors duration-micro hover:bg-surface-2 hover:text-fg"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}

/** 全局轻提示（固定右下角；最多同时显示 3 条，4.6s 自动消失）。 */
export function ToastViewport() {
  const toasts = useAppStore((state) => state.toasts)
  const visibleToasts = toasts.slice(-3)
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-12 right-4 z-toast flex flex-col gap-2"
    >
      {visibleToasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
