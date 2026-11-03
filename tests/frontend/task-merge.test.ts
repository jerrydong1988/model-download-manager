import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyProgressToTask,
  isStaleStatusRegression,
  mergeTask,
  mergeTaskLists,
} from '../../src/lib/taskMerge.ts'
import type { DownloadTask, TaskStatus } from '../../src/types.ts'

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    taskId: 'task-1',
    source: 'modelscope',
    repoId: 'example-org/demo-model-GGUF',
    remotePath: 'demo-model-Q8_0.gguf',
    fileName: 'demo-model-Q8_0.gguf',
    savePath: 'C:\\models\\example-org\\demo-model-Q8_0.gguf',
    tempPath: 'C:\\models\\example-org\\demo-model-Q8_0.gguf.part',
    totalSize: 37_802_150_112,
    downloaded: 1_460_000_000,
    status: 'active',
    speed: 18_840_532,
    retries: 0,
    addedAt: 1_793_712_791_123,
    ...overrides,
  }
}

const statusCases: Array<[TaskStatus, TaskStatus, TaskStatus, string]> = [
  ['active', 'queued', 'active', 'active 不会被过期的 queued 响应降级（本次线上 bug）'],
  ['pausing', 'queued', 'pausing', 'pausing 不会被 queued 降级'],
  ['completed', 'queued', 'completed', 'completed 终态不会被 queued 回退'],
  ['completed', 'active', 'completed', 'completed 终态不会被 active 回退'],
  ['queued', 'active', 'active', 'queued→active 正常'],
  ['active', 'completed', 'completed', 'active→completed 正常'],
  ['active', 'paused', 'paused', 'active→paused 正常'],
  ['paused', 'queued', 'queued', '暂停后继续（paused→queued）正常'],
  ['error', 'queued', 'queued', '失败重试（error→queued）正常'],
  ['cancelled', 'queued', 'queued', '取消后继续（cancelled→queued）正常'],
  ['queued', 'queued', 'queued', '相同状态幂等'],
]

for (const [previous, incoming, expected, name] of statusCases) {
  test(`status: ${name}`, () => {
    const merged = mergeTask(makeTask({ status: previous, speed: 0 }), makeTask({ status: incoming, speed: 0 }))
    assert.equal(merged.status, expected)
  })
}

test('过期 queued 响应不会回退下载进度（进度事件已领先）', () => {
  const previous = makeTask({ status: 'active', downloaded: 5_653_936_912, speed: 18_840_532 })
  const staleResponse = makeTask({ status: 'queued', downloaded: 0, speed: 0 })
  const merged = mergeTask(previous, staleResponse)
  assert.equal(merged.status, 'active')
  assert.equal(merged.downloaded, 5_653_936_912)
  assert.equal(merged.speed, 18_840_532)
})

test('active 状态下 speed=0 的状态事件不闪烁', () => {
  const previous = makeTask({ status: 'active', speed: 12_000_000 })
  const merged = mergeTask(previous, makeTask({ status: 'active', speed: 0 }))
  assert.equal(merged.speed, 12_000_000)
})

test('isStaleStatusRegression 判定矩阵', () => {
  assert.equal(isStaleStatusRegression('active', 'queued'), true)
  assert.equal(isStaleStatusRegression('pausing', 'queued'), true)
  assert.equal(isStaleStatusRegression('completed', 'active'), true)
  assert.equal(isStaleStatusRegression('active', 'completed'), false)
  assert.equal(isStaleStatusRegression('paused', 'queued'), false)
  assert.equal(isStaleStatusRegression('error', 'queued'), false)
  assert.equal(isStaleStatusRegression('queued', 'queued'), false)
})

test('mergeTaskLists 对过期 queued 快照整体合并后仍保持 active', () => {
  const active = makeTask({ status: 'active', downloaded: 5_653_936_912, speed: 18_840_532 })
  const completed = makeTask({ taskId: 'task-2', status: 'completed', speed: 0 })
  const merged = mergeTaskLists([active, completed], [
    makeTask({ status: 'queued', downloaded: 0, speed: 0 }),
    makeTask({ taskId: 'task-2', status: 'queued', speed: 0 }),
  ])
  assert.equal(merged.find((t) => t.taskId === 'task-1')?.status, 'active')
  assert.equal(merged.find((t) => t.taskId === 'task-2')?.status, 'completed')
})

test('applyProgressToTask 自愈：queued 任务收到前进进度 → active + speed', () => {
  const queued = makeTask({ status: 'queued', downloaded: 1_460_000_000, speed: 0 })
  const next = applyProgressToTask(queued, {
    taskId: queued.taskId,
    downloaded: 1_600_000_000,
    totalSize: queued.totalSize,
    speed: 20_000_000,
  })
  assert.equal(next.status, 'active')
  assert.equal(next.speed, 20_000_000)
  assert.equal(next.downloaded, 1_600_000_000)
})

test('applyProgressToTask：queued 任务仅 totalSize 变化（无前进进度）不自愈', () => {
  const queued = makeTask({ status: 'queued', downloaded: 1_460_000_000, speed: 0 })
  const next = applyProgressToTask(queued, {
    taskId: queued.taskId,
    downloaded: 1_460_000_000,
    totalSize: 38_000_000_000,
    speed: 0,
  })
  assert.equal(next.status, 'queued')
  assert.equal(next.totalSize, 38_000_000_000)
})

test('applyProgressToTask：paused 任务保持 paused（不误自愈）', () => {
  const paused = makeTask({ status: 'paused', downloaded: 2_000_000, speed: 0 })
  const next = applyProgressToTask(paused, {
    taskId: paused.taskId,
    downloaded: 2_100_000,
    totalSize: paused.totalSize,
    speed: 9_000_000,
  })
  assert.equal(next.status, 'paused')
  assert.equal(next.speed, 0)
})

test('applyProgressToTask：completed 任务忽略进度', () => {
  const completed = makeTask({ status: 'completed', speed: 0 })
  const next = applyProgressToTask(completed, {
    taskId: completed.taskId,
    downloaded: 1,
    totalSize: 2,
    speed: 3,
  })
  assert.equal(next, completed)
})

test('applyProgressToTask：active 任务进度不回退', () => {
  const active = makeTask({ status: 'active', downloaded: 5_000_000, speed: 10_000_000 })
  const next = applyProgressToTask(active, {
    taskId: active.taskId,
    downloaded: 4_000_000,
    totalSize: active.totalSize,
    speed: 8_000_000,
  })
  assert.equal(next.downloaded, 5_000_000)
  assert.equal(next.speed, 8_000_000)
})
