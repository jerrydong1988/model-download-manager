import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from './Button'
import { cx } from '../../lib/cx'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: ReactNode
  children?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

/** 模态确认框：Escape 关闭、焦点初始落在取消按钮、Tab 焦点限制在框内。 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'danger',
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  onCloseRef.current = onClose
  busyRef.current = busy

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open])

  if (!open) return null

  const handleTabTrap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[2px] animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onKeyDown={handleTabTrap}
        className="w-full max-w-md rounded-overlay border border-line bg-surface shadow-overlay animate-slide-up"
      >
        <div className="flex items-start gap-3 p-5 pb-3">
          <div
            className={cx(
              'grid h-9 w-9 shrink-0 place-items-center rounded-control',
              tone === 'danger'
                ? 'bg-danger/10 text-danger'
                : 'bg-primary-soft text-primary',
            )}
          >
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-dialog-title" className="text-section font-semibold text-fg">
              {title}
            </h2>
            {description ? (
              <div className="mt-1 text-secondary leading-6 text-fg-secondary">
                {description}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭对话框"
            className="-mr-1 -mt-1 grid h-9 w-9 place-items-center rounded-control text-fg-muted transition-colors duration-micro hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {children ? <div className="px-5 pb-3 pl-[68px]">{children}</div> : null}

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <Button ref={cancelRef} variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
