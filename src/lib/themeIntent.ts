import type { ThemeSetting } from './theme'

/** 用户刚选择、后端尚未确认的主题。设置回写若带着旧值，不能把它盖掉。 */
let pending: ThemeSetting | null = null

export function setPendingTheme(value: ThemeSetting | null): void {
  pending = value
}

export function getPendingTheme(): ThemeSetting | null {
  return pending
}
