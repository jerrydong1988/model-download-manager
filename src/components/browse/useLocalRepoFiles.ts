import { useEffect, useMemo, useState } from 'react'
import { inspectRepoFiles, toErrorText } from '../../lib/ipc'
import type { DownloadTask, LocalRepoMatch, RepoDetail } from '../../types'

const EMPTY = new Map<string, LocalRepoMatch>()

export function useLocalRepoFiles(detail: RepoDetail | null, saveDir: string, tasks: DownloadTask[]) {
  // 只有任务归属或状态变化才需要重新检查磁盘，下载速度和字节进度不影响结果。
  const taskStates = tasks.map(task => [task.taskId, task.status, task.verifyStatus].join('/')).join('|')
  const scope = useMemo(() => ({ detail, saveDir }), [detail, saveDir, taskStates])
  const [snapshot, setSnapshot] = useState<{
    scope: typeof scope
    matches: Map<string, LocalRepoMatch>
    error?: string
  } | null>(null)

  useEffect(() => {
    const { detail: repo, saveDir: dir } = scope
    if (!repo || !dir) return
    let active = true
    async function inspect(repo: RepoDetail) {
      const initial = await inspectRepoFiles(repo, dir, repo.files)
      if (!active) return
      let matches = new Map(initial.map(item => [item.path, item]))
      setSnapshot({ scope, matches })
      // 先展示全部轻量检查结果，再逐个确认有远端摘要且缓存未命中的本地文件。
      for (const file of repo.files) {
        const prior = matches.get(file.path)
        if (prior?.status !== 'needsHash') continue
        let result: LocalRepoMatch | undefined
        try {
          const checked = await inspectRepoFiles(repo, dir, [file], true)
          result = checked[0]
        } catch {
          result = { ...prior, status: 'unreadable' }
        }
        if (!active) return
        matches = new Map(matches)
        if (result) matches.set(file.path, result)
        else matches.delete(file.path)
        setSnapshot({ scope, matches })
      }
    }
    void inspect(repo).catch(error => {
      if (active) setSnapshot({ scope, matches: EMPTY, error: toErrorText(error) })
    })
    return () => { active = false }
  }, [scope])

  const current = snapshot?.scope === scope ? snapshot : null
  return {
    matches: current?.matches ?? EMPTY,
    inspecting: Boolean(detail && saveDir && !current),
    error: current?.error,
  }
}
