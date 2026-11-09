import { BrandMark, Compass, Download, DownloadQueue, Library, Settings } from '../icons'
import type { LucideIcon } from '../icons'
import { useAppStore, type PageKey } from '../../store/appStore'
import { formatSpeed } from '../../lib/format'
import { isRunningStatus } from '../../lib/labels'
import { updateProgressPercent } from '../../lib/updateFlow'
import { cx } from '../../lib/cx'

const NAV: Array<{ page: PageKey; label: string; icon: LucideIcon }> = [
  { page: 'browse', label: '浏览仓库', icon: Compass },
  { page: 'downloads', label: '下载队列', icon: DownloadQueue },
  { page: 'library', label: '本地模型库', icon: Library },
  { page: 'settings', label: '设置', icon: Settings },
]

export function Sidebar() {
  const page = useAppStore((state) => state.page)
  const setPage = useAppStore((state) => state.setPage)
  const tasks = useAppStore((state) => state.tasks)
  const appVersion = useAppStore((state) => state.appVersion)
  const update = useAppStore((state) => state.update)
  const installUpdate = useAppStore((state) => state.installUpdate)
  const updatePercent = updateProgressPercent(update.progress)
  const running = tasks.filter((task) => isRunningStatus(task.status))
  const totalSpeed = running.reduce((sum, task) => sum + task.speed, 0)

  return (
    <aside className="glass-sidebar flex h-full w-[68px] shrink-0 flex-col px-2 py-6 md:w-[208px] md:px-4">
      <div className="mb-9 px-2 md:px-3">
        <div className="mb-4 grid h-10 w-10 place-items-center rounded-card border border-primary/25 bg-primary-soft text-primary">
          <BrandMark className="h-7 w-7" strokeWidth={1.8} aria-hidden="true" />
        </div>
        <p className="hidden text-body font-semibold text-fg md:block">模型下载管理器</p>
        <p className="mt-1 hidden text-meta leading-5 text-fg-muted md:block">Model Download Manager</p>
      </div>
      <nav className="space-y-1.5" aria-label="主导航">
        {NAV.map(({ page: key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            title={label}
            aria-label={label}
            aria-current={page === key ? 'page' : undefined}
            onClick={() => setPage(key)}
            className={cx(
              'flex h-11 w-full items-center justify-center gap-3 rounded-control px-3 text-body transition-colors duration-micro md:justify-start',
              page === key ? 'bg-surface font-semibold text-fg shadow-sm' : 'text-fg-secondary hover:bg-surface/60 hover:text-fg',
              key === 'settings' && 'mt-6',
            )}
          >
            <Icon className={cx('h-[18px] w-[18px] shrink-0', page === key && 'text-primary')} strokeWidth={1.75} aria-hidden="true" />
            <span className="hidden flex-1 text-left md:block">{label}</span>
            {key === 'downloads' && running.length > 0 ? (
              <span className="hidden rounded-md bg-primary-soft px-1.5 text-meta tabular-nums text-primary md:block">{running.length}</span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="mt-auto hidden px-3 pt-6 md:block">
        {running.length > 0 ? (
          <button type="button" onClick={() => setPage('downloads')} className="mb-5 w-full rounded-control py-2 text-left hover:text-primary">
            <span className="flex items-center gap-2 text-meta text-fg-secondary"><Download className="h-3.5 w-3.5" aria-hidden="true" />下载中</span>
            <span className="mt-1 block text-body font-medium tabular-nums">{totalSpeed > 0 ? formatSpeed(totalSpeed) : '正在连接…'}</span>
          </button>
        ) : null}
        <p className="text-meta text-fg-muted">
          v{appVersion || '—'} · 桌面版
        </p>
        {update.status === 'available' && update.info ? (
          <button
            type="button"
            onClick={() => void installUpdate()}
            title="下载安装后将自动重启应用"
            className="mt-1 inline-flex min-h-8 items-center gap-1 rounded-control text-meta font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            立即升级到 v{update.info.version}
          </button>
        ) : null}
        {update.status === 'downloading' || update.status === 'installed' ? (
          <p role="status" className="mt-2 text-meta tabular-nums text-fg-secondary">
            {update.status === 'installed' ? '正在重启…'
              : updatePercent === null ? '正在下载更新…'
              : updatePercent === 100 ? '正在安装更新…' : `正在下载更新 ${updatePercent}%`}
          </p>
        ) : null}
      </div>
    </aside>
  )
}
