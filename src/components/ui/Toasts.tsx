import { useEffect, useLayoutEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from '../icons'
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
  { icon: typeof CheckCircle2; iconClass: string }
> = {
  success: {
    icon: CheckCircle2,
    iconClass: 'text-success',
  },
  error: {
    icon: AlertCircle,
    iconClass: 'text-danger',
  },
  info: {
    icon: Info,
    iconClass: 'text-primary',
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
        'glass-overlay pointer-events-auto flex w-80 max-w-[calc(100vw-32px)] items-start gap-2.5 rounded-card p-4 shadow-toast animate-slide-up',
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

/** 跟随当前可见操作栏和窗口尺寸，防止通知遮挡下载/保存按钮。 */
function useToastBottomOffset() {
  const [offset, setOffset] = useState(48)
  useLayoutEffect(() => {
    const main = document.getElementById('main')
    if (!main) return
    let frame = 0
    let watched: Element[] = []
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const resize = new ResizeObserver(schedule)
    const measure = () => {
      frame = 0
      const shelves = Array.from(main.querySelectorAll('[data-action-shelf]'))
        .filter((element) => element.getClientRects().length > 0)
      if (shelves.length !== watched.length || shelves.some((element, index) => element !== watched[index])) {
        resize.disconnect()
        resize.observe(main)
        shelves.forEach((element) => resize.observe(element))
        watched = shelves
      }
      setOffset(Math.max(48, ...shelves.map((element) =>
        window.innerHeight - element.getBoundingClientRect().top + 12,
      )))
    }
    const mutations = new MutationObserver(schedule)
    mutations.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
    main.addEventListener('scroll', schedule, true)
    resize.observe(main)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      resize.disconnect()
      main.removeEventListener('scroll', schedule, true)
    }
  }, [])
  return offset
}

/** 全局轻提示：最多 3 条，4.6s 自动消失；堆叠区域始终避开底部操作栏。 */
export function ToastViewport() {
  const toasts = useAppStore((state) => state.toasts)
  const visibleToasts = toasts.slice(-3)
  const bottomOffset = useToastBottomOffset()
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed right-4 z-toast flex flex-col gap-2 overflow-y-auto"
      style={{ bottom: bottomOffset, maxHeight: `calc(100dvh - ${bottomOffset + 16}px)` }}
    >
      {visibleToasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
