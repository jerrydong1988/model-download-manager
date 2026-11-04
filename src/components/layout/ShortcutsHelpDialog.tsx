import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Command, Keyboard, X } from '../icons'
import { Button } from '../ui/Button'

export interface ShortcutsHelpDialogProps {
  open: boolean
  onClose: () => void
}

interface ShortcutRow {
  keys: string[]
  label: string
}

const SHORTCUTS: ShortcutRow[] = [
  { keys: ['Ctrl', '1'], label: '切换到「浏览仓库」' },
  { keys: ['Ctrl', '2'], label: '切换到「下载队列」' },
  { keys: ['Ctrl', '3'], label: '切换到「本地模型库」' },
  { keys: ['Ctrl', '4'], label: '切换到「设置」' },
  { keys: ['Ctrl', 'F'], label: '聚焦当前页面搜索框' },
  { keys: ['F5'], label: '刷新当前页面数据' },
  { keys: ['Ctrl', ','], label: '打开设置' },
  { keys: ['?'], label: '打开 / 关闭本帮助' },
  { keys: ['Esc'], label: '关闭弹层；在文件表中取消选择' },
  { keys: ['Enter / Space'], label: '在文件表、目录树中执行默认操作' },
]

const MAC_HINT = 'macOS 上使用 Command（⌘）替代 Ctrl'

/** 全局快捷键帮助浮层（? 打开；Esc / 点击遮罩关闭；Tab 焦点限制在浮层内）。 */
export function ShortcutsHelpDialog({ open, onClose }: ShortcutsHelpDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, open])

  if (!open) return null

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[2px] animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-dialog-title"
        onKeyDown={trapFocus}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-overlay border border-line bg-surface shadow-overlay animate-slide-up"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-control bg-surface-2 text-primary">
              <Keyboard className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h2 id="shortcuts-dialog-title" className="text-section text-fg">
                键盘快捷键
              </h2>
              <p className="mt-0.5 text-meta text-fg-muted">{MAC_HINT}</p>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭快捷键帮助"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-control text-fg-muted transition-colors duration-micro hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <ul className="divide-y divide-line px-5 py-2">
          {SHORTCUTS.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-4 py-2.5">
              <span className="text-secondary text-fg-secondary">{row.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {row.keys.map((key) => (
                  <kbd
                    key={key}
                    className="inline-flex min-w-7 items-center justify-center rounded-control border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-meta text-fg-secondary"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="flex items-center gap-1.5 text-meta text-fg-muted">
            <Command className="h-3.5 w-3.5" aria-hidden="true" />
            未选中任务或输入框时快捷键生效
          </p>
          <Button variant="secondary" size="sm" onClick={onClose}>
            关闭
          </Button>
        </footer>
      </div>
    </div>
  )
}
