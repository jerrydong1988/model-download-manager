#!/usr/bin/env node
/**
 * tests/e2e/segment-v020-e2e.mjs — v0.2.0 多连接分段下载正确性真机验收
 *
 * 覆盖：
 *   A. 确定性本地 HTTP 服务（无需外网）：
 *      A1. Range 支持：48MB 文件、connectionsPerFile=4 → 实际并发 Range 请求 ≥2、sha256 正确；
 *      A2. 不支持 Range（始终 200 全量）：自动回退单流、sha256 正确、分段元数据清理；
 *      A3. 慢速 Range 下载：中途暂停（.part.json chunks 保留）→ 继续 → 完成 sha256 正确；
 *   B. 真实网络（ModelScope 7MB tokenizer.json）：
 *      B1. connectionsPerFile=4 完成，sha256 与 curl 独立下载一致；
 *      B2. connectionsPerFile=1 vs 4 速度对比（记录实测）。
 *
 * 安全：临时下载目录；应用数据（settings/tasks）备份→还原；只结束本脚本 spawn 的进程；不改源码。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, createResults, listTargets, PORT_WEBVIEW2, sleep, waitForEndpoint } from './cdp.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..', '..')

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next
      index += 1
    } else options[key] = true
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const PORT = Number(options.port || PORT_WEBVIEW2)
const EXE = resolve(options.exe || join(ROOT, 'src-tauri', 'target', 'debug', 'model-download-manager.exe'))
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `segment-v020-e2e-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'segment-v020-e2e-result.json')
const APP_DATA_DIR = join(process.env.APPDATA, 'com.modeldownload.manager')
const WEBVIEW_DATA_DIR = join(EVIDENCE_DIR, 'ebwebview')
const DOWNLOAD_DIR = join(process.env.LOCALAPPDATA, 'Temp', 'mdm-qa', `seg-${STAMP}`)
const SETTINGS_FILE = join(APP_DATA_DIR, 'settings.json')
const TASKS_FILE = join(APP_DATA_DIR, 'tasks.json')

const FILE_SIZE = 48 * 1024 * 1024
const CHUNK = 16 * 1024 * 1024
const MS_REPO = 'Qwen/Qwen2.5-0.5B-Instruct'
const MS_FILE = 'tokenizer.json'
const MS_SIZE = 7031645

const results = createResults()
const notes = []
const state = { client: null, proc: null, spawnedPid: null, appExitCode: null, screenshots: [], settings: null, server: null, serverPort: 0, stats: { requests: 0, rangeRequests: 0, fullRequests: 0, maxConcurrent: 0, active: 0, inflight: [] }, fixtureSha: null }

const screenshot = (client, name) =>
  client.screenshot(join(EVIDENCE_DIR, 'shots', `${name}.png`)).then((info) => {
    state.screenshots.push(info.path)
    return info.path
  }).catch(() => null)

/* ---------------- 本地 HTTP 测试服务器 ---------------- */

function startFixtureServer(fixturePath) {
  const fixtureSize = statSync(fixturePath).size
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/qa-stats') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(state.stats))
        return
      }
      if (!url.pathname.endsWith('/data.bin')) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      state.stats.requests += 1
      state.stats.active += 1
      state.stats.maxConcurrent = Math.max(state.stats.maxConcurrent, state.stats.active)
      const finish = () => {
        state.stats.active = Math.max(0, state.stats.active - 1)
      }
      const supportsRange = url.pathname.startsWith('/range/') || url.pathname.startsWith('/slow-range/')
      const slow = url.pathname.startsWith('/slow-range/')
      const range = supportsRange ? req.headers.range : null
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fixtureSize, 'accept-ranges': supportsRange ? 'bytes' : 'none', etag: '"qa-fixture-v1"' })
        res.end()
        finish()
        return
      }
      if (range && supportsRange) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
        if (!match) {
          res.writeHead(416, { 'content-range': `bytes */${fixtureSize}` })
          res.end()
          finish()
          return
        }
        let start = Number(match[1])
        let end = match[2] ? Number(match[2]) : fixtureSize - 1
        if (end >= fixtureSize) end = fixtureSize - 1
        if (start > end || start >= fixtureSize) {
          res.writeHead(416, { 'content-range': `bytes */${fixtureSize}` })
          res.end()
          finish()
          return
        }
        state.stats.rangeRequests += 1
        if (!slow) awaitDelay(25)
        res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${fixtureSize}`, 'accept-ranges': 'bytes', etag: '"qa-fixture-v1"' })
        const stream = createReadStreamSlice(fixturePath, start, end, slow)
        stream.on('end', finish)
        stream.on('error', () => { res.destroy(); finish() })
        stream.pipe(res)
        return
      }
      state.stats.fullRequests += 1
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fixtureSize, 'accept-ranges': 'none', etag: '"qa-fixture-v1"' })
      const stream = createReadStreamSlice(fixturePath, 0, fixtureSize - 1, false)
      stream.on('end', finish)
      stream.on('error', () => { res.destroy(); finish() })
      stream.pipe(res)
    })
    server.listen(0, '127.0.0.1', () => {
      state.server = server
      state.serverPort = server.address().port
      resolveServer(state.serverPort)
    })
  })
}

/** 分片读取（8KB 一块；slow 模式每块延迟 3ms ≈ 2.6MB/s 单连接，用于暂停/续传测试）。 */
function createReadStreamSlice(path, start, end, slow) {
  const fd = openSync(path, 'r')
  let offset = start
  let pending = false
  let closed = false
  const readable = new Readable({
    read() {
      if (pending) return
      if (offset > end) {
        this.push(null)
        return
      }
      const size = Math.min(8 * 1024, end - offset + 1)
      const buffer = Buffer.alloc(size)
      let bytesRead = 0
      try {
        bytesRead = readSync(fd, buffer, 0, size, offset)
      } catch {
        this.destroy()
        return
      }
      if (bytesRead <= 0) {
        this.push(null)
        return
      }
      offset += bytesRead
      const chunk = buffer.subarray(0, bytesRead)
      if (slow) {
        pending = true
        setTimeout(() => {
          pending = false
          this.push(chunk)
          if (offset > end) this.push(null)
        }, 3)
      } else {
        this.push(chunk)
      }
    },
    destroy(error, callback) {
      if (!closed) { closed = true; try { closeSync(fd) } catch { /* ignore */ } }
      callback(error)
    },
  })
  return readable
}

/* ---------------- 进程/连接 ---------------- */

function appPids() {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', "(Get-Process -Name 'model-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"], { encoding: 'utf8', timeout: 15000 })
  return (r.stdout || '').split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0)
}

function backupAppData() {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  mkdirSync(join(EVIDENCE_DIR, 'appdata-backup'), { recursive: true })
  for (const name of ['settings.json', 'tasks.json']) copyFileSync(join(APP_DATA_DIR, name), join(EVIDENCE_DIR, 'appdata-backup', name))
}
function restoreAppData() {
  try {
    for (const name of ['settings.json', 'tasks.json']) copyFileSync(join(EVIDENCE_DIR, 'appdata-backup', name), join(APP_DATA_DIR, name))
    return true
  } catch (error) {
    console.warn(`还原应用数据失败：${error.message}`)
    return false
  }
}

async function launchApp() {
  const existing = appPids()
  if (existing.length > 0) throw new Error(`检测到已有应用实例 ${existing.join(',')}，不 kill；中止`)
  try {
    await listTargets(PORT, 1500)
    throw new Error(`端口 ${PORT} 已被占用，中止`)
  } catch (error) {
    if (String(error.message).startsWith(`端口 ${PORT}`)) throw error
  }
  mkdirSync(WEBVIEW_DATA_DIR, { recursive: true })
  const logFd = openSync(join(EVIDENCE_DIR, 'app.log'), 'a')
  state.proc = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=*`, WEBVIEW2_USER_DATA_FOLDER: WEBVIEW_DATA_DIR },
    stdio: ['ignore', logFd, logFd],
    windowsHide: false,
  })
  state.spawnedPid = state.proc.pid
  state.proc.on('exit', (code) => { state.appExitCode = code })
  await waitForEndpoint(PORT, { timeoutMs: 60000, label: 'DevTools' })
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const targets = await listTargets(PORT).catch(() => [])
    const target = targets.find((item) => /tauri\.localhost|tauri:\/\/|localhost:1420/.test(item.url || ''))
    if (target) return target
    if (state.appExitCode !== null) throw new Error(`应用启动后退出 code=${state.appExitCode}`)
    await sleep(300)
  }
  throw new Error('无页面 target')
}
async function connectApp(target) {
  const client = await connect(PORT, (item) => item.id === target.id, { timeoutMs: 30000 })
  await client.startCapture()
  await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'IPC' })
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照' })
  return client
}
function killOwnApp() {
  if (!state.spawnedPid) return
  try { spawnSync('taskkill', ['/PID', String(state.spawnedPid), '/T', '/F'], { timeout: 20000 }) } catch { /* ignore */ }
  state.spawnedPid = null
}

async function getSettings(client) { return client.tauriInvoke('get_settings') }
async function saveSettings(client, patch) {
  const current = await getSettings(client)
  const next = { ...current, ...patch }
  await client.tauriInvoke('save_settings', { settings: next })
  await sleep(300)
  state.settings = await getSettings(client)
  return state.settings
}
async function taskById(client, taskId) {
  const snap = await client.tauriInvoke('get_snapshot')
  return (snap.tasks || []).find((task) => task.taskId === taskId) || null
}
async function waitTask(client, taskId, statuses, timeoutMs = 180000) {
  const wanted = new Set(statuses)
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await taskById(client, taskId)
    if (last && wanted.has(last.status)) return last
    await sleep(200)
  }
  return last
}
async function startDownload(client, request) {
  const tasks = await client.tauriInvoke('start_downloads', { requests: [request] })
  const taskId = tasks?.[0]?.taskId
  if (!taskId) throw new Error(`start_downloads 未返回 taskId：${JSON.stringify(tasks)}`)
  return taskId
}
const sha256File = (path) => new Promise((resolveHash, rejectHash) => {
  try {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', rejectHash)
  } catch (error) { rejectHash(error) }
})

function formatMB(bytes) { return `${(bytes / 1024 / 1024).toFixed(2)} MB/s` }
const awaitDelay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
function readPartMeta(partPath) { try { return JSON.parse(readFileSync(`${partPath}.json`, 'utf8')) } catch { return null } }

/* ---------------- 用例 ---------------- */

async function caseRange(client) {
  console.log('\n--- A1：本地 Range 服务 4 连接 48MB ---')
  await saveSettings(client, { downloadDir: DOWNLOAD_DIR, connectionsPerFile: 4, hfEndpoint: `http://127.0.0.1:${state.serverPort}/range`, bandwidthLimit: 0, maxRetries: 2 })
  state.stats = { requests: 0, rangeRequests: 0, fullRequests: 0, maxConcurrent: 0, active: 0, inflight: [] }
  const repoId = 'QA/local-range'
  const request = { source: 'huggingface', repoId, remotePath: 'data.bin', size: FILE_SIZE, saveDir: DOWNLOAD_DIR }
  const taskId = await startDownload(client, request)
  const done = await waitTask(client, taskId, ['completed', 'error'], 240000)
  const expectedPath = join(DOWNLOAD_DIR, ...repoId.split('/'), 'data.bin')
  const actualSha = existsSync(expectedPath) ? await sha256File(expectedPath) : null
  const maxSpeed = Number(done?.speed) || 0
  results.record('[A1] 本地 Range 4 连接下载完成', done?.status === 'completed', JSON.stringify(done ? { status: done.status, downloaded: done.downloaded, error: done.error } : null))
  results.record('[A1] 内容 sha256 正确（48MB）', actualSha === state.fixtureSha, `actual=${actualSha}`)
  results.record('[A1] 实际使用多连接（并发 Range 请求 ≥2）', state.stats.maxConcurrent >= 2 && state.stats.rangeRequests >= 2, `maxConcurrent=${state.stats.maxConcurrent} rangeRequests=${state.stats.rangeRequests} fullRequests=${state.stats.fullRequests}`)
  notes.push(`[A1] 本地 Range 服务：rangeRequests=${state.stats.rangeRequests}，maxConcurrent=${state.stats.maxConcurrent}，完成 speed=${maxSpeed} B/s。`)
  await screenshot(client, '01-local-range-completed')
}

async function caseFallback(client) {
  console.log('\n--- A2：不支持 Range → 单流回退 ---')
  await saveSettings(client, { downloadDir: DOWNLOAD_DIR, connectionsPerFile: 4, hfEndpoint: `http://127.0.0.1:${state.serverPort}/norange` })
  state.stats = { requests: 0, rangeRequests: 0, fullRequests: 0, maxConcurrent: 0, active: 0, inflight: [] }
  const repoId = 'QA/no-range'
  const taskId = await startDownload(client, { source: 'huggingface', repoId, remotePath: 'data.bin', size: FILE_SIZE, saveDir: DOWNLOAD_DIR })
  const done = await waitTask(client, taskId, ['completed', 'error'], 240000)
  const expectedPath = join(DOWNLOAD_DIR, ...repoId.split('/'), 'data.bin')
  const actualSha = existsSync(expectedPath) ? await sha256File(expectedPath) : null
  results.record('[A2] 不支持 Range 时完成下载（回退单流）', done?.status === 'completed', JSON.stringify(done ? { status: done.status, downloaded: done.downloaded, error: done.error } : null))
  results.record('[A2] 回退内容 sha256 正确', actualSha === state.fixtureSha, `actual=${actualSha}`)
  results.record('[A2] 服务端未发生 206（回退路径未强行走分段）', state.stats.rangeRequests === 0 && state.stats.fullRequests >= 1, `rangeRequests=${state.stats.rangeRequests} fullRequests=${state.stats.fullRequests}`)
  const leftoverMeta = existsSync(`${expectedPath}.part.json`)
  results.record('[A2] 完成后无分段/单流元数据残留', !leftoverMeta && !existsSync(`${expectedPath}.part`), `partMeta=${leftoverMeta}`)
  notes.push(`[A2] 回退单流：fullRequests=${state.stats.fullRequests}、rangeRequests=${state.stats.rangeRequests}。`)
  await screenshot(client, '02-fallback-completed')
}

async function casePauseResume(client) {
  console.log('\n--- A3：慢速 Range 暂停→继续→完成 ---')
  await saveSettings(client, { downloadDir: DOWNLOAD_DIR, connectionsPerFile: 4, hfEndpoint: `http://127.0.0.1:${state.serverPort}/slow-range` })
  state.stats = { requests: 0, rangeRequests: 0, fullRequests: 0, maxConcurrent: 0, active: 0, inflight: [] }
  const repoId = 'QA/slow-range'
  const taskId = await startDownload(client, { source: 'huggingface', repoId, remotePath: 'data.bin', size: FILE_SIZE, saveDir: DOWNLOAD_DIR })
  // 等待下载过 ~6MB
  const deadline = Date.now() + 60000
  let task = null
  while (Date.now() < deadline) {
    task = await taskById(client, taskId)
    if (task && Number(task.downloaded) >= 6 * 1024 * 1024) break
    if (task && ['completed', 'error'].includes(task.status)) break
    await sleep(150)
  }
  let pauseError = null
  try {
    await client.tauriInvoke('pause_download', { taskId })
  } catch (error) {
    pauseError = String(error.message || error)
  }
  const paused = await waitTask(client, taskId, ['paused'], 60000)
  const partPath = paused?.tempPath || `${paused?.savePath}.part`
  const metaAtPause = readPartMeta(partPath)
  const chunksAtPause = Array.isArray(metaAtPause?.chunks) ? metaAtPause.chunks.reduce((sum, value) => sum + Number(value || 0), 0) : null
  results.record('[A3] 慢速下载中途暂停成功', paused?.status === 'paused', JSON.stringify({ paused: paused ? { status: paused.status, downloaded: paused.downloaded } : null, pauseError }))
  results.record('[A3] 暂停时 .part.json 分段元数据存在且 chunksSum > 0', Boolean(metaAtPause?.chunkSize) && chunksAtPause > 0, `chunkSize=${metaAtPause?.chunkSize} chunksSum=${chunksAtPause}`)
  try {
    await client.tauriInvoke('resume_download', { taskId })
  } catch (error) {
    results.record('[A3] resume_download 调用', false, String(error.message || error).slice(0, 300))
  }
  const done = await waitTask(client, taskId, ['completed', 'error'], 240000)
  const expectedPath = join(DOWNLOAD_DIR, ...repoId.split('/'), 'data.bin')
  const actualSha = existsSync(expectedPath) ? await sha256File(expectedPath) : null
  results.record('[A3] 暂停→继续后完成', done?.status === 'completed', JSON.stringify(done ? { status: done.status, downloaded: done.downloaded, error: done.error } : null))
  results.record('[A3] 续传后 sha256 正确', actualSha === state.fixtureSha, `actual=${actualSha}`)
  notes.push(`[A3] 暂停时 downloaded=${paused?.downloaded}B，chunksSum=${chunksAtPause}B；继续完成 downloaded=${done?.downloaded}B。`)
  await screenshot(client, '03-pause-resume-completed')
}

async function caseRealMs(client) {
  console.log('\n--- B：真实网络 ModelScope 7MB（4 连接 vs 1 连接）---')
  await saveSettings(client, { downloadDir: DOWNLOAD_DIR, connectionsPerFile: 4, hfEndpoint: 'https://hf-mirror.com', bandwidthLimit: 0 })
  const expectedPath = join(DOWNLOAD_DIR, ...MS_REPO.split('/'), MS_FILE)
  rmSync(expectedPath, { force: true })
  rmSync(`${expectedPath}.part`, { force: true })
  rmSync(`${expectedPath}.part.json`, { force: true })
  const t0 = Date.now()
  const taskId4 = await startDownload(client, { source: 'modelscope', repoId: MS_REPO, remotePath: MS_FILE, size: MS_SIZE, saveDir: DOWNLOAD_DIR })
  let maxSpeed4 = 0
  const poll4 = setInterval(async () => {
    const task = await taskById(client, taskId4).catch(() => null)
    if (task?.speed) maxSpeed4 = Math.max(maxSpeed4, Number(task.speed))
  }, 300)
  const done4 = await waitTask(client, taskId4, ['completed', 'error'], 180000)
  clearInterval(poll4)
  const elapsed4 = (Date.now() - t0) / 1000
  const avgSpeed4 = (Number(done4?.downloaded) || MS_SIZE) / Math.max(0.1, elapsed4)
  const sha4 = existsSync(expectedPath) ? await sha256File(expectedPath) : null

  // curl 独立下载对照
  const curlOut = join(EVIDENCE_DIR, 'curl-ms-tokenizer.json')
  const curl = spawnSync('curl.exe', ['-sL', '--max-time', '120', '-o', curlOut, `https://www.modelscope.cn/models/${MS_REPO}/resolve/master/${MS_FILE}`], { encoding: 'utf8', timeout: 150000 })
  const curlSha = existsSync(curlOut) ? await sha256File(curlOut) : null
  results.record('[B1] MS tokenizer.json 4 连接下载完成', done4?.status === 'completed', JSON.stringify(done4 ? { status: done4.status, downloaded: done4.downloaded, total: done4.totalSize, error: done4.error } : null))
  results.record('[B1] 4 连接完成内容 sha256 与 curl 一致', Boolean(sha4) && sha4 === curlSha && Number(done4?.totalSize) === MS_SIZE, `app=${sha4} curl=${curlSha}`)
  const meta4 = readPartMeta(`${expectedPath}.part.json`)
  notes.push(`[B1] 4 连接：平均 ${formatMB(avgSpeed4)}，耗时 ${elapsed4.toFixed(2)}s，SHA256=${sha4}。`)

  // 单连接对照
  rmSync(expectedPath, { force: true })
  rmSync(`${expectedPath}.part`, { force: true })
  rmSync(`${expectedPath}.part.json`, { force: true })
  await client.tauriInvoke('clear_finished')
  await sleep(500)
  await saveSettings(client, { downloadDir: DOWNLOAD_DIR, connectionsPerFile: 1 })
  const t1 = Date.now()
  const taskId1 = await startDownload(client, { source: 'modelscope', repoId: MS_REPO, remotePath: MS_FILE, size: MS_SIZE, saveDir: DOWNLOAD_DIR })
  let maxSpeed1 = 0
  const poll1 = setInterval(async () => {
    const task = await taskById(client, taskId1).catch(() => null)
    if (task?.speed) maxSpeed1 = Math.max(maxSpeed1, Number(task.speed))
  }, 300)
  const done1 = await waitTask(client, taskId1, ['completed', 'error'], 180000)
  clearInterval(poll1)
  const elapsed1 = (Date.now() - t1) / 1000
  const avgSpeed1 = (Number(done1?.downloaded) || MS_SIZE) / Math.max(0.1, elapsed1)
  const sha1 = existsSync(expectedPath) ? await sha256File(expectedPath) : null
  results.record('[B2] 单连接完成且 sha256 一致', done1?.status === 'completed' && sha1 === curlSha, `status=${done1?.status} sha=${sha1}`)
  results.record(
    '[B2] 4 连接 vs 1 连接速度对比已记录',
    true,
    `4连接平均=${formatMB(avgSpeed4)}（峰值采样=${formatMB(maxSpeed4)}，耗时 ${elapsed4.toFixed(2)}s）；1连接平均=${formatMB(avgSpeed1)}（峰值采样=${formatMB(maxSpeed1)}，耗时 ${elapsed1.toFixed(2)}s）；7MB 小文件受 CDN/冷启动影响，仅记录`,
  )
  notes.push(`[B2] 4 连接平均 ${formatMB(avgSpeed4)}（${elapsed4.toFixed(2)}s）；1 连接平均 ${formatMB(avgSpeed1)}（${elapsed1.toFixed(2)}s）；小文件，仅供趋势记录。`)
  await saveSettings(client, { connectionsPerFile: 4 })
  await screenshot(client, '04-real-ms-comparison')
}

/* ---------------- 主流程 ---------------- */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  console.log(`临时下载目录：${DOWNLOAD_DIR}`)
  results.record('应用 exe 存在', existsSync(EXE), EXE)
  // 生成 48MB 随机 fixture
  const fixturePath = join(EVIDENCE_DIR, 'fixture-48mb.bin')
  if (!existsSync(fixturePath) || statSync(fixturePath).size !== FILE_SIZE) {
    const stream = createWriteStream(fixturePath)
    for (let offset = 0; offset < FILE_SIZE; offset += 1024 * 1024) stream.write(randomBytes(1024 * 1024))
    await new Promise((resolveFinish) => stream.end(resolveFinish))
  }
  state.fixtureSha = await sha256File(fixturePath)
  results.record('测试 fixture 生成且 sha256 记录', statSync(fixturePath).size === FILE_SIZE && Boolean(state.fixtureSha), `${statSync(fixturePath).size}B sha256=${state.fixtureSha}`)

  backupAppData()
  try {
    const serverPort = await startFixtureServer(fixturePath)
    results.record('本地 HTTP 测试服务启动（Range / no-Range / slow-Range）', serverPort > 0, `port=${serverPort}`)
    const target = await launchApp()
    state.client = await connectApp(target)
    const snap = await state.client.tauriInvoke('get_snapshot')
    results.record('应用启动且版本为 0.2.0', snap.appVersion === '0.2.0', `appVersion=${snap.appVersion}`)

    await caseRange(state.client)
    await caseFallback(state.client)
    await casePauseResume(state.client)
    await caseRealMs(state.client)

    results.record('运行期无未捕获页面异常', state.client.pageErrors.length === 0, `${state.client.pageErrors.length} 个`)
    const realConsoleErrors = state.client.consoleErrors.filter((item) => !/Failed to load resource: the server responded with a status of 404/.test(item.text) && !/favicon/i.test(item.text))
    results.record('运行期无控制台错误（忽略 favicon/404 资源提示）', realConsoleErrors.length === 0, `${realConsoleErrors.length} 个：${realConsoleErrors.map((item) => item.text).join(' | ').slice(0, 400)}`)
    await screenshot(state.client, '05-final-state')
  } finally {
    if (state.client) await state.client.close().catch(() => {})
    killOwnApp()
    await sleep(1500)
    if (state.server) state.server.close()
    const restored = restoreAppData()
    notes.push(`应用数据已${restored ? '' : '未'}还原（settings/tasks）；临时下载目录将删除。`)
    rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
    rmSync(WEBVIEW_DATA_DIR, { recursive: true, force: true })
    console.log('已清理临时目录并还原应用数据')
    console.log(`当前剩余应用实例：${appPids().join(',') || '无'}`)
    // 用户任务状态复核（应保持 paused）
    try {
      const before = readFileSync(join(EVIDENCE_DIR, 'appdata-backup', 'tasks.json'))
      const after = readFileSync(TASKS_FILE)
      results.record('测试后完整任务文件与备份逐字节一致', before.equals(after), `backupBytes=${before.length}, restoredBytes=${after.length}`)
    } catch (error) {
      results.record('测试后任务数据还原复核', false, String(error.message).slice(0, 300))
    }
  }
  const summary = results.summary('v0.2.0 多连接分段下载正确性验收')
  writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, exe: EXE, fixtureSha: state.fixtureSha, notes, summary, screenshots: state.screenshots, consoleErrors: state.client?.consoleErrors || [], pageErrors: state.client?.pageErrors || [] }, null, 2), 'utf8')
  console.log(`结果 JSON：${RESULT_JSON}`)
  for (const note of notes) console.log(`  - ${note}`)
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`\n分段下载验收异常：${error.message || error}`)
  results.record('分段下载验收主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('v0.2.0 多连接分段下载正确性验收（异常终止）')
  try { writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, notes, fatalError: String(error.stack || error) }, null, 2), 'utf8') } catch { /* ignore */ }
  if (state.client) state.client.close().catch(() => {})
  killOwnApp()
  if (state.server) state.server.close()
  restoreAppData()
  process.exitCode = 1
})
