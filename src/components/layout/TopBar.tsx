import { FlaskConical, Keyboard } from '../icons'
import { IS_MOCK_MODE } from '../../lib/ipc'
import { Button } from '../ui/Button'

export interface TopBarProps { title: string; subtitle: string; onShowHelp?: () => void }

export function TopBar({ title, subtitle, onShowHelp }: TopBarProps) {
  return (
    <header className="flex min-h-[88px] shrink-0 items-center justify-between gap-4 px-4 py-5 md:px-8">
      <div className="min-w-0">
        <h1 className="truncate text-page text-fg">{title}</h1>
        <p className="mt-1 hidden truncate text-secondary text-fg-muted md:block">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {IS_MOCK_MODE ? (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-meta text-fg-secondary" title="Mock 预览，不写入磁盘">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" /><span className="hidden sm:inline">演示数据</span>
          </span>
        ) : null}
        {onShowHelp ? (
          <Button variant="ghost" size="icon" aria-label="查看键盘快捷键（按 ? 打开）" title="键盘快捷键（?）" onClick={onShowHelp}>
            <Keyboard className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </header>
  )
}
