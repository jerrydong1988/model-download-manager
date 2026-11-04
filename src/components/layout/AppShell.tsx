import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FolderOpen } from '../icons'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ShortcutsHelpDialog } from './ShortcutsHelpDialog'
import { useGlobalShortcuts } from './useGlobalShortcuts'
import { useAppStore, type PageKey } from '../../store/appStore'
import { openDataDir } from '../../lib/ipc'
import { formatRelativeTime } from '../../lib/format'
import { cx } from '../../lib/cx'
import { PathText } from '../ui/PathText'

export const PAGE_META: Record<PageKey, { title: string; subtitle: string }> = {
  browse: {
    title: '浏览仓库',
    subtitle: '查找模型，选择文件，下载到你的设备。',
  },
  downloads: {
    title: '下载队列',
    subtitle: '查看进度与速度，暂停、继续、重试或清理任务记录',
  },
  library: {
    title: '本地模型库',
    subtitle: '浏览已下载的模型文件，管理磁盘占用与下载记录',
  },
  settings: {
    title: '设置',
    subtitle: '外观、存储与扫描根、访问凭据、网络与下载引擎参数',
  },
}

function StatusBar() {
  const settings = useAppStore((state) => state.settings)
  const dataDir = useAppStore((state) => state.dataDir)
  const eventsStatus = useAppStore((state) => state.eventsStatus)
  const eventsError = useAppStore((state) => state.eventsError)
  const lastSnapshotAt = useAppStore((state) => state.lastSnapshotAt)
  const pushToast = useAppStore((state) => state.pushToast)
  // v0.1.3：节流后的读屏播报（完成/失败摘要），不播报进度。
  const announcement = useAppStore((state) => state.announcement)
  const announcementSeq = useAppStore((state) => state.announcementSeq)

  const eventMeta =
    eventsStatus === 'ready'
      ? { dot: 'bg-success', label: '状态已同步' }
      : eventsStatus === 'error'
        ? { dot: 'bg-danger', label: '同步异常' }
        : { dot: 'bg-warning', label: '正在连接…' }

  const handleOpenDataDir = async () => {
    try {
      await openDataDir()
      pushToast('success', '已打开应用数据目录', dataDir || undefined)
    } catch (error) {
      pushToast('error', '无法打开数据目录', error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-4 border-t border-line bg-surface px-4 text-meta text-fg-muted md:px-8">
      <div className="flex shrink-0 items-center gap-3">
        <span
          className="inline-flex items-center gap-1.5"
          title={
            eventsError ??
            (lastSnapshotAt ? `快照同步于 ${formatRelativeTime(lastSnapshotAt)}` : '')
          }
        >
          <span className={cx('h-1.5 w-1.5 rounded-full', eventMeta.dot)} aria-hidden="true" />
          {eventMeta.label}
        </span>
      </div>

      <div className="hidden min-w-0 flex-1 items-center justify-end gap-1.5 md:flex">
        <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {settings?.downloadDir ? (
          <PathText path={settings.downloadDir} copyable={false} className="max-w-xl" />
        ) : (
          <span className="truncate">正在加载下载目录…</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => void handleOpenDataDir()}
          className="cursor-pointer rounded-control px-1.5 py-0.5 transition-colors duration-micro hover:bg-surface-2 hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          title={dataDir}
        >
          打开数据目录
        </button>
      </div>

      {/* 节流完成/失败播报：每 ≥2.2s 一条聚合摘要，避免进度事件刷屏（P1-4）。 */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement ? <span key={announcementSeq}>{announcement}</span> : null}
      </div>
    </footer>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const page = useAppStore((state) => state.page)
  const meta = PAGE_META[page]
  const mainRef = useRef<HTMLElement>(null)
  const previousPage = useRef<PageKey>(page)
  const [announcedPage, setAnnouncedPage] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)

  // 路由切换焦点管理：焦点移到 main（tabIndex=-1），并播报新页面标题（P1-6）。
  useEffect(() => {
    if (previousPage.current === page) return
    previousPage.current = page
    setAnnouncedPage(`已切换到${PAGE_META[page].title}页面`)
    mainRef.current?.focus({ preventScroll: true })
  }, [page])

  useGlobalShortcuts({
    helpOpen,
    onToggleHelp: () => setHelpOpen((previous) => !previous),
    onCloseHelp: () => setHelpOpen(false),
  })

  return (
    <div className="flex h-full min-h-0 bg-bg text-fg">
      <a href="#main" className="skip-link">
        跳到主要内容
      </a>
      <Sidebar />
      <div className="app-workspace my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-card bg-surface">
        <TopBar title={meta.title} subtitle={meta.subtitle} onShowHelp={() => setHelpOpen(true)} />
        <main
          id="main"
          ref={mainRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-hidden outline-none"
        >
          {children}
        </main>
        <StatusBar />
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcedPage}
      </div>
      <ShortcutsHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
