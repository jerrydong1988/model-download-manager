import { useEffect, useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import { ToastViewport } from './components/ui/Toasts'
import { useAppStore, type PageKey } from './store/appStore'
import { applyTheme, applyThemeSetting, cacheTheme, subscribeSystemTheme } from './lib/theme'
import BrowsePage from './pages/BrowsePage'
import DownloadsPage from './pages/DownloadsPage'
import LibraryPage from './pages/LibraryPage'
import SettingsPage from './pages/SettingsPage'

const PAGE_KEYS: PageKey[] = ['browse', 'downloads', 'library', 'settings']

const PAGE_COMPONENTS: Record<PageKey, () => JSX.Element> = {
  browse: BrowsePage,
  downloads: DownloadsPage,
  library: LibraryPage,
  settings: SettingsPage,
}

function pageFromHash(): PageKey | null {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return (PAGE_KEYS as string[]).includes(raw) ? (raw as PageKey) : null
}

export default function App() {
  const page = useAppStore((state) => state.page)
  const themeSetting = useAppStore((state) => state.settings?.theme)

  // KeepAlive：页面首次访问后保持挂载，之后仅用 hidden 切换，
  // 保留搜索词/筛选/树展开/选中仓库等局部状态（P1-3）。
  const [mountedPages, setMountedPages] = useState<Set<PageKey>>(
    () => new Set<PageKey>([page]),
  )

  // 事件订阅 + 启动快照：仅在 App 挂载时执行一次，卸载时清理订阅。
  useEffect(() => {
    const state = useAppStore.getState()
    const cleanup = state.connectEvents()
    return cleanup
  }, [])

  // 轻量 hash 路由，刷新/前进后退保持页面。
  useEffect(() => {
    const handleHashChange = () => {
      const next = pageFromHash()
      if (next) useAppStore.getState().setPage(next)
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    const target = `#/${page}`
    if (window.location.hash !== target) {
      window.history.replaceState(null, '', target)
    }
    setMountedPages((previous) => {
      if (previous.has(page)) return previous
      const next = new Set(previous)
      next.add(page)
      return next
    })
  }, [page])

  // 主题：settings.theme（light/dark/system）→ 立即应用到 <html data-theme> 并缓存，
  // system 模式跟随 prefers-color-scheme 实时切换（暗色落地见 DESIGN-TOKENS §5）。
  useEffect(() => {
    if (!themeSetting) return
    cacheTheme(themeSetting)
    applyThemeSetting(themeSetting)
    if (themeSetting !== 'system') return
    return subscribeSystemTheme((resolved) => applyTheme(resolved))
  }, [themeSetting])

  return (
    <>
      <AppShell>
        {PAGE_KEYS.filter((key) => mountedPages.has(key)).map((key) => {
          const PageComponent = PAGE_COMPONENTS[key]
          const active = page === key
          return (
            <div
              key={key}
              data-page={key}
              className="h-full min-h-0"
              hidden={!active}
              aria-hidden={active ? undefined : true}
            >
              <PageComponent />
            </div>
          )
        })}
      </AppShell>
      <ToastViewport />
    </>
  )
}
