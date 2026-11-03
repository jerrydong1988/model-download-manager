/**
 * 主题（light / dark / system）解析与应用。
 *
 * - <html data-theme="light|dark"> 是唯一主题开关（DESIGN-TOKENS §5），
 *   首帧由 index.html 内联脚本按 localStorage 缓存值设置，避免闪白；
 * - App 随 settings.theme 调用 applyThemeSetting；
 * - system 模式使用 subscribeSystemTheme 监听 prefers-color-scheme。
 */

export type ThemeSetting = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

/** 与 index.html 首帧脚本保持一致。 */
export const THEME_STORAGE_KEY = 'mdm.theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light'
  }
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/** 将设置值解析为实际主题；'system' 跟随系统当前偏好。 */
export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  return setting === 'system' ? getSystemTheme() : setting
}

/** 应用主题到 <html data-theme> 与 color-scheme。 */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

/** 读取 localStorage 中缓存的主题设置；缺省 light。 */
export function getStoredTheme(): ThemeSetting {
  if (typeof window === 'undefined') return 'light'
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    /* localStorage 不可用（隐私模式等）时回退 light */
  }
  return 'light'
}

/** 缓存主题设置供 index.html 首帧脚本读取。 */
export function cacheTheme(setting: ThemeSetting): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, setting)
  } catch {
    /* 忽略存储失败 */
  }
}

/** 解析 + 应用主题，返回实际生效的主题。 */
export function applyThemeSetting(setting: ThemeSetting): ResolvedTheme {
  const resolved = resolveTheme(setting)
  applyTheme(resolved)
  return resolved
}

/**
 * 监听系统主题变化；仅在需要跟随系统时使用。
 * 返回值是幂等的取消订阅函数。
 */
export function subscribeSystemTheme(callback: (resolved: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const mediaQuery = window.matchMedia(DARK_QUERY)
  const handleChange = (event: MediaQueryListEvent) => {
    callback(event.matches ? 'dark' : 'light')
  }
  mediaQuery.addEventListener('change', handleChange)
  return () => mediaQuery.removeEventListener('change', handleChange)
}

/** 应用启动时调用（main.tsx）：读取缓存设置并应用主题。 */
export function initTheme(): ResolvedTheme {
  return applyThemeSetting(getStoredTheme())
}
