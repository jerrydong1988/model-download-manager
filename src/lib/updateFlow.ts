/**
 * v0.5.0 在线升级的纯逻辑（可 Node 单元测试，无 Tauri 依赖）：
 * UpdateStatus 状态机迁移、进度百分比、Toast 文案与事件应用守卫。
 * store 只负责调用 ipc 与编排，状态语义统一收敛在这里。
 */

import type { UpdateInfo, UpdateProgressEvent } from '../types'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'upToDate'
  | 'downloading'
  | 'installed'
  | 'failed'

export interface UpdateSlice {
  status: UpdateStatus
  info: UpdateInfo | null
  progress: UpdateProgressEvent | null
  error: string | null
}

export const INITIAL_UPDATE_SLICE: UpdateSlice = {
  status: 'idle',
  info: null,
  progress: null,
  error: null,
}

export function validUpdateEndpoint(value: string): boolean {
  const endpoint = value.trim()
  if (!endpoint) return true
  try {
    return /^https:\/\//i.test(endpoint) && Boolean(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

export function statusChecking(): UpdateSlice {
  return { status: 'checking', info: null, progress: null, error: null }
}

/** 检查成功：有 info → available；无更新时手动检查显示 upToDate，自动检查保持 idle（不打扰）。 */
export function statusAfterCheck(manual: boolean, info: UpdateInfo | null): UpdateSlice {
  if (info) return { status: 'available', info, progress: null, error: null }
  return {
    status: manual ? 'upToDate' : 'idle',
    info: null,
    progress: null,
    error: null,
  }
}

export function statusCheckFailed(error: string): UpdateSlice {
  return { status: 'failed', info: null, progress: null, error }
}

export function statusDownloading(): UpdateSlice {
  return { status: 'downloading', info: null, progress: null, error: null }
}

export function statusInstalled(info: UpdateInfo | null): UpdateSlice {
  return { status: 'installed', info, progress: null, error: null }
}

/** 下载进度百分比；total 未知（null/0）返回 null（UI 显示不确定态）。 */
export function updateProgressPercent(progress: UpdateProgressEvent | null): number | null {
  if (!progress || !progress.total || progress.total <= 0) return null
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
}

/** 仅 available 状态允许点「立即更新」；下载失败后需重新检查（待装更新已被取出）。 */
export function canInstallUpdate(status: UpdateStatus): boolean {
  return status === 'available'
}

/** Sidebar/入口的「有新版本」可见提示：available/downloading/installed 期间保留。 */
export function hasVisibleUpdate(status: UpdateStatus): boolean {
  return status === 'available' || status === 'downloading' || status === 'installed'
}

/** 检查/下载进行中不被 update-available 事件覆盖（检查中会自行给出结果）。 */
export function shouldApplyAvailableEvent(status: UpdateStatus): boolean {
  return status === 'idle' || status === 'upToDate'
}

/** 进度事件仅在 downloading 期间应用，防止过期 tick 污染其他状态。 */
export function shouldApplyProgressEvent(status: UpdateStatus): boolean {
  return status === 'downloading'
}

/** 自动检查发现新版的 Toast 描述文案。 */
export function autoUpdateToastDescription(info: UpdateInfo): string {
  return `v${info.version} 可用，可在设置页「关于与更新」一键升级。`
}
