import { Activity, CheckCircle2, FlaskConical, Keyboard } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { formatSpeed } from '../../lib/format'
import { isRunningStatus } from '../../lib/labels'
import { IS_MOCK_MODE } from '../../lib/ipc'
import { cx } from '../../lib/cx'
import { Button } from '../ui/Button'

export interface TopBarProps {
  title: string
  subtitle: string
  onShowHelp?: () => void
}

/** 顶栏 60px：页面标题 + 副标题（窄窗隐藏）+ 下载概况 + 快捷键帮助。 */
export function TopBar({ title, subtitle, onShowHelp }: TopBarProps) {
  const tasks = useAppStore((state) => state.tasks)
  const setPage = useAppStore((state) => state.setPage)
  const runningTasks = tasks.filter((task) => isRunningStatus(task.status))
  const runningCount = runningTasks.length
  const totalSpeed = runningTasks.reduce((sum, task) => sum + task.speed, 0)

  return (
    <header className="flex h-[60px] shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-6">
      <div className="min-w-0">
        <h1 className="truncate text-page text-fg">{title}</h1>
        <p className="mt-0.5 hidden truncate text-meta text-fg-muted xl:block">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {IS_MOCK_MODE ? (
          <span className="inline-flex items-center gap-1.5 rounded-control border border-amber-200 bg-amber-50 px-2 py-0.5 text-meta font-medium text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
            Mock 预览
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setPage('downloads')}
          className={cx(
            'inline-flex cursor-pointer items-center gap-2 rounded-control border px-3 py-1.5 text-meta font-medium transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            runningCount > 0
              ? 'border-primary/30 bg-primary-soft text-primary hover:border-primary/50'
              : 'border-line bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg-secondary',
          )}
        >
          {runningCount > 0 ? (
            <>
              <Activity className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="tabular-nums">
                {runningCount} 个下载中 · {formatSpeed(totalSpeed)}
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              <span>暂无进行中任务</span>
            </>
          )}
        </button>
        {onShowHelp ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="查看键盘快捷键（按 ? 打开）"
            title="键盘快捷键（?）"
            onClick={onShowHelp}
          >
            <Keyboard className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </header>
  )
}
