import {
  Boxes,
  Compass,
  Download,
  FlaskConical,
  FolderOpen,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAppStore, type PageKey } from '../../store/appStore'
import { formatSpeed } from '../../lib/format'
import { isRunningStatus } from '../../lib/labels'
import { IS_MOCK_MODE } from '../../lib/ipc'
import { cx } from '../../lib/cx'

interface NavItem {
  page: PageKey
  label: string
  icon: LucideIcon
}

const WORKSPACE_NAV: NavItem[] = [
  { page: 'browse', label: '浏览仓库', icon: Compass },
  { page: 'downloads', label: '下载队列', icon: Download },
  { page: 'library', label: '本地模型库', icon: FolderOpen },
]

const APP_NAV: NavItem[] = [{ page: 'settings', label: '设置', icon: Settings }]

export function Sidebar() {
  const page = useAppStore((state) => state.page)
  const setPage = useAppStore((state) => state.setPage)
  const tasks = useAppStore((state) => state.tasks)
  const settings = useAppStore((state) => state.settings)
  const appVersion = useAppStore((state) => state.appVersion)

  const runningTasks = tasks.filter((task) => isRunningStatus(task.status))
  const runningCount = runningTasks.length
  const totalSpeed = runningTasks.reduce((sum, task) => sum + task.speed, 0)

  const renderNavItem = (item: NavItem) => {
    const active = page === item.page
    const Icon = item.icon
    const badge = item.page === 'downloads' && runningCount > 0 ? runningCount : undefined
    return (
      <button
        key={item.page}
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => setPage(item.page)}
        className={cx(
          'group flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-control px-2.5 text-body transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          active
            ? 'bg-primary-soft font-medium text-primary'
            : 'text-fg-secondary hover:bg-surface-2 hover:text-fg',
        )}
      >
        <Icon
          className={cx(
            'h-4 w-4 shrink-0',
            active ? 'text-primary' : 'text-fg-muted group-hover:text-fg-secondary',
          )}
          aria-hidden="true"
        />
        <span className="flex-1 text-left">{item.label}</span>
        {badge !== undefined ? (
          <span className="rounded-control bg-primary px-1.5 text-meta font-semibold tabular-nums text-primary-on">
            {badge}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary text-primary-on">
          <Boxes className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-body font-semibold tracking-tight text-fg">模型下载管理器</p>
          <p className="truncate text-meta font-medium uppercase tracking-wider text-fg-muted">
            Model Download Manager
          </p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 pt-1" aria-label="主导航">
        <p className="px-2 pb-1 pt-2 text-meta font-medium text-fg-muted">工作区</p>
        {WORKSPACE_NAV.map(renderNavItem)}
        <p className="px-2 pb-1 pt-4 text-meta font-medium text-fg-muted">应用</p>
        {APP_NAV.map(renderNavItem)}
      </nav>

      <div className="space-y-2 border-t border-line p-3">
        {runningCount > 0 ? (
          <button
            type="button"
            onClick={() => setPage('downloads')}
            className="w-full cursor-pointer rounded-card border border-primary/25 bg-primary-soft/60 p-2.5 text-left transition-colors duration-micro hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              <span className="text-secondary font-medium text-primary">
                {runningCount} 个任务下载中
              </span>
            </div>
            <p className="mt-1 pl-4 text-meta tabular-nums text-primary/80">
              {totalSpeed > 0 ? formatSpeed(totalSpeed) : '等待数据…'}
            </p>
          </button>
        ) : null}

        <div
          className={cx(
            'rounded-card border p-2.5',
            IS_MOCK_MODE
              ? 'border-amber-200 bg-amber-50/70 dark:border-amber-800/60 dark:bg-amber-950/40'
              : 'border-line bg-surface-2',
          )}
        >
          <div className="flex items-center gap-2">
            {IS_MOCK_MODE ? (
              <FlaskConical className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            )}
            <p
              className={cx(
                'text-meta font-medium',
                IS_MOCK_MODE ? 'text-amber-700 dark:text-amber-300' : 'text-fg-secondary',
              )}
            >
              {IS_MOCK_MODE ? 'Mock 数据模式' : '本地存储'}
            </p>
          </div>
          <p
            className={cx(
              'mt-1 truncate text-meta',
              IS_MOCK_MODE
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-fg-muted',
            )}
            title={IS_MOCK_MODE ? '浏览器预览不会写入磁盘' : settings?.downloadDir}
          >
            {IS_MOCK_MODE ? '浏览器预览，不写入磁盘' : settings?.downloadDir ?? '正在加载…'}
          </p>
        </div>
        <p className="px-1 text-meta text-fg-muted">v{appVersion || '0.2.0'} · 桌面版</p>
      </div>
    </aside>
  )
}
