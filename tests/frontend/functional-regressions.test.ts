import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDownloadDir, taskMatchesDestination } from '../../src/lib/downloadPaths.ts'
import { applyProgressToTask, mergeTask, reconcileTaskSnapshot } from '../../src/lib/taskMerge.ts'
import type { DownloadTask } from '../../src/types.ts'

const task: DownloadTask = {
  taskId: 't1', source: 'huggingface', repoId: 'org/model', remotePath: 'model.bin',
  fileName: 'model.bin', savePath: 'C:\\Models\\org\\model\\model.bin', tempPath: 'C:\\Models\\org\\model\\model.bin.part',
  revision: 'main', status: 'active', totalSize: 100, downloaded: 90, speed: 10, retries: 0, addedAt: 1, updateSeq: 10,
}

test('任务匹配包含 revision 与实际保存目录', () => {
  assert.equal(taskMatchesDestination(task, 'huggingface', 'org/model', 'main', 'c:/models/'), true)
  assert.equal(taskMatchesDestination(task, 'huggingface', 'org/model', 'dev', 'C:\\Models'), false)
  assert.equal(taskMatchesDestination(task, 'huggingface', 'org/model', 'main', 'D:\\Models'), false)
  const revision = { ...task, revision: 'dev', savePath: 'C:\\Models\\.mdm-revisions\\646576\\org\\model\\model.bin' }
  assert.equal(taskMatchesDestination(revision, 'huggingface', 'org/model', 'dev', 'C:\\Models'), true)
  assert.equal(taskMatchesDestination({ ...revision, savePath: 'C:\\Models\\org\\model\\dev\\model.bin' }, 'huggingface', 'org/model', 'dev', 'C:\\Models'), true)
})

test('Windows 盘符根、UNC 共享根保持绝对路径语义', () => {
  assert.equal(normalizeDownloadDir(' D:\\ '), 'D:\\')
  assert.equal(normalizeDownloadDir('D:/'), 'D:\\')
  assert.equal(normalizeDownloadDir('\\\\server\\share\\'), '\\\\server\\share')
  assert.equal(normalizeDownloadDir('C:\\Models\\'), 'C:\\Models')
})

test('新进度序号允许从零重下，旧进度不能恢复旧百分比', () => {
  const reset = applyProgressToTask(task, { taskId: task.taskId, totalSize: 100, downloaded: 0, speed: 0, updateSeq: 11 })
  assert.equal(reset.downloaded, 0)
  assert.equal(reset.speed, 0)
  assert.equal(applyProgressToTask(reset, { taskId: task.taskId, totalSize: 100, downloaded: 95, speed: 20, updateSeq: 9 }), reset)
  assert.equal(mergeTask(reset, task), reset)
  assert.equal(mergeTask(task, { ...task, status: 'queued', downloaded: 0, updateSeq: 11 }).downloaded, 0)
})

test('快照替换旧状态并删除后端不存在的记录', () => {
  const backend = { ...task, status: 'paused' as const, speed: 0, updateSeq: 12 }
  assert.equal(reconcileTaskSnapshot([backend], [])[0].status, 'paused')
  assert.deepEqual(reconcileTaskSnapshot([], []), [])
})

test('快照只重放请求期间的更新、删除和未知任务进度', () => {
  const result = reconcileTaskSnapshot([task, { ...task, taskId: 'removed' }], [
    { kind: 'progress', progress: { taskId: 't1', totalSize: 100, downloaded: 0, speed: 0, updateSeq: 11 } },
    { kind: 'remove', ids: ['removed'] },
    { kind: 'tasks', tasks: [{ ...task, taskId: 'new', status: 'queued', updateSeq: 15 }] },
    { kind: 'progress', progress: { taskId: 'new', totalSize: 100, downloaded: 99, speed: 10, updateSeq: 16 } },
    { kind: 'tasks', tasks: [{ ...task, downloaded: 95, updateSeq: 9 }] },
  ])
  assert.equal(result.find(item => item.taskId === 't1')?.downloaded, 0)
  assert.equal(result.find(item => item.taskId === 'new')?.downloaded, 99)
  assert.equal(result.some(item => item.taskId === 'removed'), false)
})
