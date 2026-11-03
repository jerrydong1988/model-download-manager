/**
 * 全局快捷键（v0.1.3，UI-AUDIT P3-6）。
 *
 * 绑定在 window 上，由 AppShell 统一挂载（内部页面通过自定义事件响应）：
 * - Ctrl/Cmd + 1..4：切换到 浏览仓库 / 下载队列 / 本地模型库 / 设置
 * - Ctrl/Cmd + F：聚焦当前页搜索框（派发 app:focus-search）
 * - F5：刷新当前页数据（派发 app:refresh-page，不触发浏览器整页刷新）
 * - Ctrl/Cmd + ,：打开设置
 * - `?`（Shift+/）：打开快捷键帮助浮层；Esc 关闭浮层
 *
 * 输入框内：Ctrl/Cmd 组合键仍然生效（避免浏览器默认行为），单独 `?` 不拦截。
 */

import { useEffect } from 'react'
import { useAppStore, type PageKey } from '../../store/appStore'

export const APP_FOCUS_SEARCH_EVENT = 'app:focus-search'
export const APP_REFRESH_PAGE_EVENT = 'app:refresh-page'

const PAGE_BY_DIGIT: Record<string, PageKey> = {
  '1': 'browse',
  '2': 'downloads',
  '3': 'library',
  '4': 'settings',
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

export function dispatchAppEvent(name: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export interface GlobalShortcutsOptions {
  helpOpen: boolean
  onToggleHelp: () => void
  onCloseHelp: () => void
}

export function useGlobalShortcuts({
  helpOpen,
  onToggleHelp,
  onCloseHelp,
}: GlobalShortcutsOptions): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Esc 优先关闭帮助浮层（弹窗自身也会处理，这里兜底）。
      if (event.key === 'Escape' && helpOpen) {
        event.preventDefault()
        onCloseHelp()
        return
      }

      const modifier = event.ctrlKey || event.metaKey
      if (modifier && !event.altKey) {
        const digitPage = PAGE_BY_DIGIT[event.key]
        if (digitPage) {
          event.preventDefault()
          useAppStore.getState().setPage(digitPage)
          return
        }
        if (event.key === 'f' || event.key === 'F') {
          event.preventDefault()
          dispatchAppEvent(APP_FOCUS_SEARCH_EVENT)
          return
        }
        if (event.key === ',') {
          event.preventDefault()
          useAppStore.getState().setPage('settings')
        }
        return
      }

      if (event.key === 'F5') {
        event.preventDefault()
        dispatchAppEvent(APP_REFRESH_PAGE_EVENT, { page: useAppStore.getState().page })
        return
      }

      if (event.key === '?' && !isEditableTarget(event.target)) {
        event.preventDefault()
        onToggleHelp()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [helpOpen, onCloseHelp, onToggleHelp])
}
