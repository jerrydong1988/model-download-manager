import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoUpdateToastDescription,
  canInstallUpdate,
  hasVisibleUpdate,
  shouldApplyAvailableEvent,
  shouldApplyProgressEvent,
  statusAfterCheck,
  statusCheckFailed,
  statusInstalled,
  updateProgressPercent,
  validUpdateEndpoint,
} from '../../src/lib/updateFlow.ts'
import type { UpdateInfo } from '../../src/types.ts'

const info: UpdateInfo = { version: '0.5.0', notes: '更新说明' }

test('custom update feeds must use HTTPS in release builds', () => {
  assert.ok(validUpdateEndpoint(''))
  assert.ok(validUpdateEndpoint(' HTTPS://mirror.example.com/latest.json '))
  assert.ok(!validUpdateEndpoint('http://mirror.example.com/latest.json'))
  assert.ok(!validUpdateEndpoint('https://'))
})

test('statusAfterCheck：有新版 → available；无新版手动 upToDate / 自动 idle', () => {
  const available = statusAfterCheck(true, info)
  assert.equal(available.status, 'available')
  assert.equal(available.info?.version, '0.5.0')

  assert.equal(statusAfterCheck(true, null).status, 'upToDate')
  assert.equal(statusAfterCheck(false, null).status, 'idle')
})

test('updateProgressPercent：total 未知返回 null，越界钳制到 100', () => {
  assert.equal(updateProgressPercent(null), null)
  assert.equal(updateProgressPercent({ downloaded: 50, total: 0 }), null)
  assert.equal(updateProgressPercent({ downloaded: 50, total: null }), null)
  assert.equal(updateProgressPercent({ downloaded: 50, total: 200 }), 25)
  assert.equal(updateProgressPercent({ downloaded: 300, total: 200 }), 100)
})

test('canInstallUpdate：仅 available 允许立即更新', () => {
  assert.ok(canInstallUpdate('available'))
  for (const status of [
    'idle',
    'checking',
    'upToDate',
    'downloading',
    'installed',
    'failed',
  ] as const) {
    assert.ok(!canInstallUpdate(status), `${status} 不应允许安装`)
  }
})

test('hasVisibleUpdate：available/downloading/installed 显示提示，failed 不残留', () => {
  assert.ok(hasVisibleUpdate('available'))
  assert.ok(hasVisibleUpdate('downloading'))
  assert.ok(hasVisibleUpdate('installed'))
  assert.ok(!hasVisibleUpdate('idle'))
  assert.ok(!hasVisibleUpdate('upToDate'))
  assert.ok(!hasVisibleUpdate('failed'))
})

test('事件守卫：checking/downloading 期间不被 update-available 覆盖', () => {
  assert.ok(shouldApplyAvailableEvent('idle'))
  assert.ok(shouldApplyAvailableEvent('upToDate'))
  assert.ok(!shouldApplyAvailableEvent('checking'))
  assert.ok(!shouldApplyAvailableEvent('available'))
  assert.ok(!shouldApplyAvailableEvent('downloading'))
})

test('进度守卫：仅 downloading 应用 update-progress（过期 tick 不污染）', () => {
  assert.ok(shouldApplyProgressEvent('downloading'))
  assert.ok(!shouldApplyProgressEvent('idle'))
  assert.ok(!shouldApplyProgressEvent('installed'))
})

test('失败与完成切片保留必要信息', () => {
  const failed = statusCheckFailed('检查更新失败：网络超时')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, '检查更新失败：网络超时')

  const installed = statusInstalled(info)
  assert.equal(installed.status, 'installed')
  assert.equal(installed.info?.version, '0.5.0')
})

test('自动检查 Toast 文案含版本号', () => {
  assert.match(autoUpdateToastDescription(info), /0\.5\.0/)
})
