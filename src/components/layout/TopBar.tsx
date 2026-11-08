import { useEffect, useState } from 'react'
import { FlaskConical, Keyboard, Moon, Sun } from '../icons'
import { IS_MOCK_MODE } from '../../lib/ipc'
import { persistThemeSetting } from '../../lib/persistTheme'
import { resolveTheme, subscribeSystemTheme, type ResolvedTheme } from '../../lib/theme'
import { useAppStore } from '../../store/appStore'
import { Button } from '../ui/Button'

export interface TopBarProps { title: string; subtitle: string; onShowHelp?: () => void }

function ThemeToggle() {
  const themeSetting = useAppStore((state) => state.settings?.theme)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(themeSetting ?? 'system'))

  useEffect(() => {
    const setting = themeSetting ?? 'system'
    setResolved(resolveTheme(setting))
    if (setting !== 'system') return
    return subscribeSystemTheme(setResolved)
  }, [themeSetting])

  const next: ResolvedTheme = resolved === 'dark' ? 'light' : 'dark'
  const label = next === 'dark' ? '切换到深色' : '切换到浅色'
  const Icon = next === 'dark' ? Moon : Sun

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={themeSetting == null}
      onClick={() => {
        void persistThemeSetting(next)
      }}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </Button>
  )
}

export function TopBar({ title, subtitle, onShowHelp }: TopBarProps) {
  return (
    <header className="flex min-h-[88px] shrink-0 items-center justify-between gap-4 px-4 py-5 md:px-8">
      <div className="min-w-0">
        <h1 className="truncate text-page text-fg">{title}</h1>
        <p className="mt-1 hidden truncate text-secondary text-fg-muted md:block">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {IS_MOCK_MODE ? (
          <span className="mr-2 inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-meta text-fg-secondary" title="Mock 预览，不写入磁盘">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" /><span className="hidden sm:inline">演示数据</span>
          </span>
        ) : null}
        <ThemeToggle />
        {onShowHelp ? (
          <Button variant="ghost" size="icon" aria-label="查看键盘快捷键（按 ? 打开）" title="键盘快捷键（?）" onClick={onShowHelp}>
            <Keyboard className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </header>
  )
}
