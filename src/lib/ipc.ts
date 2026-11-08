/**
 * 唯一 IPC 出口。
 *
 * - 生产 / Tauri：调用 @tauri-apps/api 的真实 invoke / listen；
 * - 仅当 URL 带 `?mock=1` 或 `VITE_MOCK=1` 时切换到 src/mocks（浏览器视觉验证）。
 * 页面与 store 不得直接 import @tauri-apps/api。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  AppEventHandlers,
  AppSnapshot,
  CancelDownloadArgs,
  DeleteLocalFileArgs,
  DiskSpace,
  DownloadRequest,
  DownloadTask,
  ListRevisionsArgs,
  RepoDetail,
  RepoSearchPage,
  RevisionList,
  SaveSettingsArgs,
  SearchReposArgs,
  Settings,
  Source,
  UpdateInfo,
  UpdateProgressEvent,
} from '../types'
import { createMockBridge } from '../mocks/mockIpc'

const MOCK_QUERY_KEY = 'mock'

function detectMockMode(): boolean {
  if (import.meta.env.VITE_MOCK === '1') return true
  if (typeof window === 'undefined') return false
  try {
    return new URL(window.location.href).searchParams.get(MOCK_QUERY_KEY) === '1'
  } catch {
    return false
  }
}

/** 当前是否运行在 mock 数据模式（UI 会显示标识）。 */
export const IS_MOCK_MODE = detectMockMode()

const mockBridge = IS_MOCK_MODE ? createMockBridge() : null

/** 把任意异常统一成可展示的中文错误。 */
export function toErrorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return '操作失败：未知错误'
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(toErrorText(error))
}

/** 底层 invoke 封装；仅本文件允许直接调用 Tauri API。 */
export async function invokeCmd<Result>(
  command: string,
  args?: Record<string, unknown>,
): Promise<Result> {
  if (mockBridge) {
    try {
      return await mockBridge.invoke<Result>(command, args)
    } catch (error) {
      throw normalizeError(error)
    }
  }
  try {
    return await invoke<Result>(command, args)
  } catch (error) {
    throw normalizeError(error)
  }
}

/* ------------------------------------------------------------------ */
/* 21 个命令的类型化封装                                                */
/* ------------------------------------------------------------------ */

export function getSnapshot(): Promise<AppSnapshot> {
  return invokeCmd<AppSnapshot>('get_snapshot')
}

export function searchRepos(args: SearchReposArgs): Promise<RepoSearchPage> {
  return invokeCmd<RepoSearchPage>('search_repos', { ...args })
}

export function getRepoDetail(
  source: Source,
  repoId: string,
  revision?: string,
): Promise<RepoDetail> {
  return invokeCmd<RepoDetail>('get_repo_detail', { source, repoId, revision })
}

/** v0.2.0：仓库可下载 revision 列表（分支/标签；失败时由调用方降级为自定义输入）。 */
export function listRevisions(source: Source, repoId: string): Promise<RevisionList> {
  return invokeCmd<RevisionList>('list_revisions', {
    source,
    repoId,
  } satisfies ListRevisionsArgs)
}

export function startDownloads(requests: DownloadRequest[]): Promise<DownloadTask[]> {
  return invokeCmd<DownloadTask[]>('start_downloads', { requests })
}

export function pauseDownload(taskId: string): Promise<void> {
  return invokeCmd<void>('pause_download', { taskId })
}

export function resumeDownload(taskId: string): Promise<void> {
  return invokeCmd<void>('resume_download', { taskId })
}

export function pauseAll(): Promise<void> {
  return invokeCmd<void>('pause_all')
}

export function resumeAll(): Promise<void> {
  return invokeCmd<void>('resume_all')
}

export function cancelDownload(taskId: string, deletePartial: boolean): Promise<void> {
  return invokeCmd<void>('cancel_download', {
    taskId,
    deletePartial,
  } satisfies CancelDownloadArgs)
}

export function retryDownload(taskId: string): Promise<void> {
  return invokeCmd<void>('retry_download', { taskId })
}

export function removeTasks(taskIds: string[]): Promise<void> {
  return invokeCmd<void>('remove_tasks', { taskIds })
}

export function clearFinished(): Promise<void> {
  return invokeCmd<void>('clear_finished')
}

export function getSettings(): Promise<Settings> {
  return invokeCmd<Settings>('get_settings')
}

export function saveSettings(settings: Settings): Promise<Settings> {
  return invokeCmd<Settings>('save_settings', {
    settings,
  } satisfies SaveSettingsArgs)
}

export function scanLibrary(): Promise<import('../types').LocalFile[]> {
  return invokeCmd<import('../types').LocalFile[]>('scan_library')
}

export function listPartials(): Promise<import('../types').LocalFile[]> {
  return invokeCmd<import('../types').LocalFile[]>('list_partials')
}

export function openPath(path: string, reveal: boolean): Promise<void> {
  return invokeCmd<void>('open_path', { path, reveal })
}

export function deleteLocalFile(path: string, removeTask: boolean): Promise<void> {
  return invokeCmd<void>('delete_local_file', {
    path,
    removeTask,
  } satisfies DeleteLocalFileArgs)
}

export function testConnection(source: Source): Promise<string> {
  return invokeCmd<string>('test_connection', { source })
}

export function getDefaultDownloadDir(): Promise<string> {
  return invokeCmd<string>('get_default_download_dir')
}

export function openDataDir(): Promise<void> {
  return invokeCmd<void>('open_data_dir')
}

/** 读取保存目录所在卷的可用空间。 */
export function getDiskSpace(path: string): Promise<DiskSpace> {
  return invokeCmd<DiskSpace>('disk_space', { path })
}

/* ------------------------------------------------------------------ */
/* 在线升级（v0.5.0）                                                   */
/* ------------------------------------------------------------------ */

/** 检查更新；返回新版本信息（并已缓存待装）或 null（已是最新）。 */
export function checkUpdate(): Promise<UpdateInfo | null> {
  return invokeCmd<UpdateInfo | null>('check_update')
}

/** 下载并安装已缓存的新版本；进度经 update-progress 事件上报。 */
export function installUpdate(): Promise<void> {
  return invokeCmd<void>('install_update')
}

/** 重启应用（更新安装后）。走 process 插件 JS API（pickDirectory 同款动态导入模式）。 */
export async function restartApp(): Promise<void> {
  if (mockBridge) return
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    throw new Error(`无法重启应用：${toErrorText(error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 事件订阅                                                            */
/* ------------------------------------------------------------------ */

/**
 * 订阅 8 个后端事件（含 v0.1.3 的 window-hidden-to-tray 与 v0.5.0 的 update-* 三个）；
 * 返回幂等的取消订阅函数。
 * 注意：监听注册是异步的，调用方必须在组件卸载时同时处理“注册完成前已取消”的情况。
 */
export async function subscribeAppEvents(handlers: AppEventHandlers): Promise<() => void> {
  if (mockBridge) {
    return mockBridge.subscribe(handlers)
  }

  const unlisteners: Array<() => void> = []
  try {
    unlisteners.push(
      await listen<{
        taskId: string
        downloaded: number
        totalSize: number
        speed: number
      }>('download-progress', (event) => handlers.onProgress(event.payload)),
      await listen<{ task: DownloadTask }>('task-updated', (event) =>
        handlers.onTaskUpdated(event.payload.task),
      ),
      await listen<{ taskIds: string[] }>('tasks-removed', (event) =>
        handlers.onTasksRemoved(event.payload.taskIds),
      ),
      await listen<{ settings: Settings }>('settings-updated', (event) =>
        handlers.onSettingsUpdated(event.payload.settings),
      ),
      await listen<Record<string, never>>('window-hidden-to-tray', (event) =>
        handlers.onWindowHiddenToTray(event.payload as Record<string, never>),
      ),
      await listen<UpdateInfo>('update-available', (event) =>
        handlers.onUpdateAvailable(event.payload),
      ),
      await listen<UpdateProgressEvent>('update-progress', (event) =>
        handlers.onUpdateProgress(event.payload),
      ),
      await listen<Record<string, never>>('update-installed', () => handlers.onUpdateInstalled()),
    )
  } catch (error) {
    unlisteners.forEach((unlisten) => {
      try {
        unlisten()
      } catch {
        /* 忽略二次取消订阅错误 */
      }
    })
    throw normalizeError(error)
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unlisteners.forEach((unlisten) => {
      try {
        unlisten()
      } catch {
        /* 忽略二次取消订阅错误 */
      }
    })
  }
}

/* ------------------------------------------------------------------ */
/* 系统目录选择（settings 页专用）                                      */
/* ------------------------------------------------------------------ */

export async function pickDirectory(currentPath?: string): Promise<string | null> {
  if (mockBridge) {
    return mockBridge.pickDirectory(currentPath)
  }
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: currentPath,
      title: '选择下载目录',
    })
    return typeof selected === 'string' ? selected : null
  } catch (error) {
    throw new Error(`无法打开系统目录选择器：${toErrorText(error)}`)
  }
}
