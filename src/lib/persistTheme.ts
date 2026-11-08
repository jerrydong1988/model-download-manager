/**
 * 把主题写入已保存设置。顶栏一键切换和设置页共用同一条串行保存链，
 * 避免连续点击时后发的请求被先返回的结果覆盖。
 */

import { saveSettings, toErrorText } from './ipc'
import { useAppStore } from '../store/appStore'
import { applyThemeSetting, cacheTheme, type ThemeSetting } from './theme'
import { setPendingTheme } from './themeIntent'

let chain: Promise<void> = Promise.resolve()
/** 用户最后一次选择；过期的保存结果不再写回。 */
let latest: ThemeSetting | null = null

export function persistThemeSetting(
  value: ThemeSetting,
  options?: { announce?: boolean },
): Promise<void> {
  const current = useAppStore.getState().settings
  if (!current) return Promise.resolve()
  if (current.theme === value) {
    applyThemeSetting(value)
    cacheTheme(value)
    return Promise.resolve()
  }

  const previous = current.theme
  latest = value
  setPendingTheme(value)
  applyThemeSetting(value)
  cacheTheme(value)
  useAppStore.getState().setSettings({ ...current, theme: value })

  const requested = value
  const announce = options?.announce ?? false
  const run = chain.then(async () => {
    if (latest !== requested) return
    try {
      const saved = await saveSettings({ ...current, theme: requested })
      if (latest !== requested) return
      setPendingTheme(null)
      latest = null
      cacheTheme(saved.theme)
      applyThemeSetting(saved.theme)
      useAppStore.getState().setSettings(saved)
      if (announce) {
        useAppStore.getState().pushToast('success', '外观主题已保存', '主题更改已立即应用。')
      }
    } catch (error) {
      if (latest !== requested) return
      latest = previous
      setPendingTheme(previous)
      applyThemeSetting(previous)
      cacheTheme(previous)
      const now = useAppStore.getState().settings
      if (now) useAppStore.getState().setSettings({ ...now, theme: previous })
      setPendingTheme(null)
      latest = null
      useAppStore.getState().pushToast('error', '保存主题失败', toErrorText(error))
      throw error
    }
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
