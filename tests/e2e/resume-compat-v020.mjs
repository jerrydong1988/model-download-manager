#!/usr/bin/env node
/**
 * tests/e2e/resume-compat-v020.mjs — v0.2.0 **显式指定任务的旧单流断点兼容**真机验收（最高优先，保护用户数据）
 *
 * 使用前必须显式传入 --repo、--file、--total 和 --baseline-mbps。
 * 只应选择已备份的专用测试任务；会实际续传并更新该任务。
 *
 * 本脚本（严格保护数据）：
 *   1) 前置备份与校验：tasks.json / settings.json / .part.json 已备份；远端 Range 探测 total 必须一致；
 *      记录 .part 头/1GiB/尾指纹；
 *   2) 启动 v0.2.0 debug exe → 「继续」→ 断言：不从头下载（downloaded 只增不减、旧前缀指纹不变）、
 *      `.part` 预分配为 total、`.part.json` 出现 chunkSize=16MiB + chunks 且 chunksSum≈已下载、
 *      UI 状态/进度/速度正确（记录实测速度 vs 指定的单连接基线）；
 *   3) 增量下载约 256–512MB 后点「暂停」→ 断言 paused、tasks.json paused、`.part` 只增不减、
 *      chunk 元数据保留；再「继续」一次验证不从 0 开始，再暂停；
 *   4) 结束：确保用户任务最终 paused、数据完好；仅还原 settings.json（tasks.json 保留更新后的 paused 状态）。
 *
 * 只结束本脚本 spawn 的进程；不 kill 其他实例；WebView2 数据目录隔离。
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `resume-compat-v020-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'resume-compat-v020-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const WEBVIEW_DATA_DIR = join(EVIDENCE_DIR, 'ebwebview')
const TASKS_FILE = join(APP_DATA_DIR, 'tasks.json')
const SETTINGS_FILE = join(APP_DATA_DIR, 'settings.json')

const TARGET_REPO = typeof options.repo === 'string' ? options.repo.trim() : ''
const TARGET_FILE = typeof options.file === 'string' ? options.file.trim() : ''
const EXPECT_TOTAL = Number(options.total)
const CHUNK = 16 * 1024 * 1024
const SINGLE_STREAM_BASELINE = Number(options['baseline-mbps']) * 1024 * 1024
if (!TARGET_REPO || !TARGET_FILE || typeof options.total !== 'string' || typeof options['baseline-mbps'] !== 'string' || !Number.isSafeInteger(EXPECT_TOTAL) || EXPECT_TOTAL <= 0 || !Number.isFinite(SINGLE_STREAM_BASELINE) || SINGLE_STREAM_BASELINE <= 0) {
  throw new Error('请显式指定已备份的测试任务：--repo <owner/repo> --file <remote-path> --total <bytes> --baseline-mbps <positive-number>')
}

const results = createResults()
const notes = []
const state = { client: null, proc: null, spawnedPid: null, appExitCode: null, screenshots: [], consoleErrors: [], pageErrors: [] }

const screenshot = (client, name) =>
  client
    .screenshot(join(EVIDENCE_DIR, 'shots', `${name}.png`))
    .then((info) => {
      state.screenshots.push(info.path)
      return info.path
    })
    .catch(() => null)

function readTasks() {
  return JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
}
function findUserTask() {
  const tasks = readTasks().tasks || []
  return tasks.find((task) => task.repoId === TARGET_REPO && task.remotePath === TARGET_FILE)
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
function fingerprint(path, size) {
  const fd = openSync(path, 'r')
  const hashAt = (offset) => {
    const len = 1024 * 1024
    const buffer = Buffer.alloc(len)
    const read = readSync(fd, buffer, 0, len, Math.max(0, Math.min(offset, size - len)))
    return createHash('sha256').update(buffer.subarray(0, read)).digest('hex')
  }
  const result = { size, head: hashAt(0), mid1G: hashAt(1024 * 1024 * 1024), tail: hashAt(size - 1024 * 1024) }
  closeSync(fd)
  return result
}
function backupAppData() {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  mkdirSync(join(EVIDENCE_DIR, 'appdata-backup'), { recursive: true })
  for (const name of ['settings.json', 'tasks.json']) {
    copyFileSync(join(APP_DATA_DIR, name), join(EVIDENCE_DIR, 'appdata-backup', name))
  }
}
function restoreSettings() {
  try {
    copyFileSync(join(EVIDENCE_DIR, 'appdata-backup', 'settings.json'), SETTINGS_FILE)
    return true
  } catch (error) {
    console.warn(`还原 settings.json 失败：${error.message}`)
    return false
  }
}

function appPids() {
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process -Name 'model-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
    { encoding: 'utf8', timeout: 15000 },
  )
  return (result.stdout || '').split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0)
}

async function launchApp() {
  if (!existsSync(EXE)) throw new Error(`debug exe 不存在：${EXE}`)
  const existing = appPids()
  if (existing.length > 0) throw new Error(`检测到已有应用实例 ${existing.join(',')}；为保证用户数据安全，本脚本不 kill 其他实例，请先确认`)
  try {
    await listTargets(PORT, 1500)
    throw new Error(`端口 ${PORT} 已被占用，按安全约束不结束任何进程`)
  } catch (error) {
    if (String(error.message).startsWith(`端口 ${PORT}`)) throw error
  }
  mkdirSync(WEBVIEW_DATA_DIR, { recursive: true })
  const logFd = openSync(join(EVIDENCE_DIR, 'app.log'), 'a')
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=*`,
    WEBVIEW2_USER_DATA_FOLDER: WEBVIEW_DATA_DIR,
  }
  state.proc = spawn(EXE, [], { env, stdio: ['ignore', logFd, logFd], windowsHide: false })
  state.spawnedPid = state.proc.pid
  state.proc.on('exit', (code) => {
    state.appExitCode = code
    console.log(`应用实例退出：code=${code}`)
  })
  await waitForEndpoint(PORT, { timeoutMs: 60000, label: 'WebView2 DevTools' })
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const targets = await listTargets(PORT).catch(() => [])
    const target = targets.find((item) => /tauri\.localhost|tauri:\/\/|localhost:1420/.test(item.url || ''))
    if (target) return target
    if (state.appExitCode !== null) throw new Error(`应用启动后退出（code=${state.appExitCode}）`)
    await sleep(300)
  }
  throw new Error('未找到应用页面 target')
}
function killOwnApp() {
  if (!state.spawnedPid) return
  try {
    spawnSync('taskkill', ['/PID', String(state.spawnedPid), '/T', '/F'], { encoding: 'utf8', timeout: 20000 })
    console.log(`已结束本脚本启动的实例 PID=${state.spawnedPid}`)
  } catch (error) {
    console.warn(`结束实例失败：${error.message}`)
  }
  state.spawnedPid = null
}
async function connectApp(target) {
  const client = await connect(PORT, (item) => item.id === target.id, { timeoutMs: 30000 })
  await client.startCapture()
  await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'Tauri IPC' })
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照加载' })
  return client
}

async function snapshot(client) {
  return client.tauriInvoke('get_snapshot')
}
async function taskOf(client) {
  const snap = await snapshot(client)
  return (snap.tasks || []).find((task) => task.repoId === TARGET_REPO && task.remotePath === TARGET_FILE) || null
}
async function clickDownloads(client) {
  await client.clickByText('下载队列', 'aside nav button, aside button')
  await sleep(500)
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(TARGET_FILE)})`, { timeoutMs: 30000, description: '任务行出现' })
}
async function clickTaskAction(client, label, fileName) {
  const selector = `button[aria-label=${JSON.stringify(`${label}：${fileName}`)}]`
  const clicked = await client.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`)
  return clicked
}
async function waitStatus(client, statuses, timeoutMs = 60000) {
  const wanted = new Set(statuses)
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await taskOf(client)
    if (last && wanted.has(last.status)) return last
    await sleep(300)
  }
  return last
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)

  // ---------- 0) 前置：读取并校验用户任务 ----------
  const taskBefore = findUserTask()
  results.record('发现用户 paused 任务', Boolean(taskBefore), taskBefore ? JSON.stringify({ status: taskBefore.status, downloaded: taskBefore.downloaded, totalSize: taskBefore.totalSize }) : '未找到')
  if (!taskBefore || taskBefore.status !== 'paused') {
    throw new Error('用户任务不存在或不是 paused —— 为保护数据中止测试')
  }
  const partPath = taskBefore.tempPath
  const metaPath = `${partPath}.json`
  results.record('totalSize 与显式期望值一致', Number(taskBefore.totalSize) === EXPECT_TOTAL, `task.totalSize=${taskBefore.totalSize}；expected=${EXPECT_TOTAL}`)
  results.record('.part 存在且为旧单流断点（长度 == downloaded、无 chunks 元数据）', existsSync(partPath) && existsSync(metaPath), `${partPath}`)
  const partBefore = statSync(partPath).size
  const oldMeta = readJson(metaPath)
  results.record(
    '旧 .part 尺寸 == 任务 downloaded（旧单流连续前缀）',
    Number(taskBefore.downloaded) === partBefore && !oldMeta?.chunks,
    `part=${partBefore}B downloaded=${taskBefore.downloaded}B；旧 meta keys=${oldMeta ? Object.keys(oldMeta).join(',') : '缺失'}`,
  )
  const fpBefore = fingerprint(partPath, partBefore)
  writeFileSync(join(EVIDENCE_DIR, 'part-fingerprint-before.json'), JSON.stringify(fpBefore, null, 2))

  // 远端 Range 探测（total 必须一致；etag 漂移需按“旧断点保留”策略处理）
  const curlHeaders = spawnSync('curl.exe', ['-sL', '-D', '-', '-o', 'NUL', '-H', 'Range: bytes=0-15', '--max-time', '60', `https://hf-mirror.com/${TARGET_REPO}/resolve/main/${TARGET_FILE}`], { encoding: 'utf8', timeout: 90000 })
  const headers = curlHeaders.stdout || ''
  const totalMatch = headers.match(/content-range:\s*bytes\s*0-15\/(\d+)/i)
  const remoteTotal = totalMatch ? Number(totalMatch[1]) : null
  const etagMatch = headers.match(/^etag:\s*(.+)$/im)
  const remoteEtag = etagMatch ? etagMatch[1].trim() : null
  writeFileSync(join(EVIDENCE_DIR, 'remote-probe-headers.txt'), headers, 'utf8')
  results.record('远端 Range 探测 total 与旧断点 total 一致（确保未变文件）', remoteTotal === EXPECT_TOTAL, `remote=${remoteTotal}`)
  if (remoteTotal !== EXPECT_TOTAL) {
    throw new Error(`远端 total 与本地断点不一致（${remoteTotal} vs ${EXPECT_TOTAL}），为避免丢失用户数据中止测试`)
  }
  const etagChanged = Boolean(oldMeta?.etag) && Boolean(remoteEtag) && oldMeta.etag !== remoteEtag
  notes.push(
    `远端 etag 与旧 .part.json 不同（old=${oldMeta?.etag || '无'}，remote=${remoteEtag || '无'}）→ 后端 segmented.rs 对「旧单流连续前缀」明确保留已下载数据继续分段（见源码注释），本测试将验证该兼容路径。`,
  )

  backupAppData()
  try {
    const target = await launchApp()
    state.client = await connectApp(target)
    const snap = await snapshot(state.client)
    results.record('应用启动且版本为 0.2.0', snap.appVersion === '0.2.0', `appVersion=${snap.appVersion}`)
    const taskStart = await taskOf(state.client)
    results.record('启动后用户任务仍为 paused（未被自动恢复）', taskStart?.status === 'paused', JSON.stringify(taskStart ? { status: taskStart.status, downloaded: taskStart.downloaded } : null))
    await clickDownloads(state.client)
    await screenshot(state.client, '01-user-task-paused')

    // ---------- 1) 点「继续」 ----------
    const clickedResume = await clickTaskAction(state.client, '继续下载', TARGET_FILE)
    results.record('点击「继续下载」（指定大文件任务 断点续传）', clickedResume, TARGET_FILE)
    const active = await waitStatus(state.client, ['active', 'queued', 'completed'], 90000)
    results.record('任务进入下载中', active?.status === 'active', `status=${active?.status} downloaded=${active?.downloaded}`)
    if (!active || active.status !== 'active') return

    const startedAt = Date.now()
    const startDownloaded = Number(active.downloaded)
    let maxSpeed = 0
    let lastSample = null
    let chunkMeta = null
    let partAllocated = 0
    const incrementTarget = Math.min(512 * 1024 * 1024, Math.max(192 * 1024 * 1024, Math.floor(EXPECT_TOTAL * 0.006)))
    // 轮询约 20s（到达增量目标或超时）
    while (Date.now() - startedAt < 45000) {
      lastSample = await taskOf(state.client)
      if (!lastSample) break
      maxSpeed = Math.max(maxSpeed, Number(lastSample.speed) || 0)
      if (!chunkMeta && existsSync(metaPath)) {
        try {
          const parsed = readJson(metaPath)
          if (parsed && Array.isArray(parsed.chunks) && parsed.chunks.length > 0) chunkMeta = parsed
        } catch {
          /* 元数据可能正在写入 */
        }
        try {
          partAllocated = statSync(partPath).size
        } catch {
          /* ignore */
        }
      }
      if (lastSample.status !== 'active') break
      if (Number(lastSample.downloaded) >= startDownloaded + incrementTarget) break
      await sleep(400)
    }

    const endDownloaded = Number(lastSample?.downloaded || startDownloaded)
    const elapsedSec = Math.max(0.5, (Date.now() - startedAt) / 1000)
    const avgSpeed = (endDownloaded - startDownloaded) / elapsedSec
    if (!chunkMeta && existsSync(metaPath)) chunkMeta = readJson(metaPath)
    try {
      partAllocated = statSync(partPath).size
    } catch {
      // ignore
    }

    results.record(
      '不从头下载：downloaded 只增不减且非重启',
      endDownloaded > startDownloaded && endDownloaded >= partBefore,
      `start=${startDownloaded}B → now=${endDownloaded}B（+${endDownloaded - startDownloaded}B）`,
    )
    results.record(
      '.part 已预分配为 total（set_len）',
      partAllocated === EXPECT_TOTAL,
      `part size=${partAllocated}（期望 ${EXPECT_TOTAL}）`,
    )
    const chunks = Array.isArray(chunkMeta?.chunks) ? chunkMeta.chunks : null
    const chunksSum = chunks ? chunks.reduce((sum, value) => sum + Number(value || 0), 0) : null
    results.record(
      '.part.json 出现 chunks 元数据（chunkSize=16MiB）',
      Boolean(chunkMeta) && Number(chunkMeta.chunkSize) === CHUNK && Array.isArray(chunks) && chunks.length === Math.ceil(EXPECT_TOTAL / CHUNK),
      chunkMeta ? `chunkSize=${chunkMeta.chunkSize} chunks=${chunks ? chunks.length : 'n/a'}（期望 ${Math.ceil(EXPECT_TOTAL / CHUNK)}）` : '未读取到 chunks',
    )
    results.record(
      'chunksSum ≈ 转换后的已完成字节（≥ 旧断点 8.12GiB）',
      chunksSum !== null && chunksSum >= partBefore && Math.abs(chunksSum - endDownloaded) <= CHUNK * 8,
      `chunksSum=${chunksSum}B（旧断点=${partBefore}B，当前 downloaded=${endDownloaded}B）`,
    )
    results.record(
      '旧单流前缀转换：已完成整块≈floor(旧长度/16MiB)',
      chunks !== null && chunks.filter((value) => Number(value) === CHUNK).length >= Math.floor(partBefore / CHUNK),
      `完整块=${chunks ? chunks.filter((value) => Number(value) === CHUNK).length : 'n/a'}（期望 ≥${Math.floor(partBefore / CHUNK)}）`,
    )
    results.record(
      '实测速度明显高于指定的单连接基线',
      Math.max(maxSpeed, avgSpeed) > SINGLE_STREAM_BASELINE,
      `maxSpeed=${formatMB(maxSpeed)}，平均=${formatMB(avgSpeed)}，旧单流基线=${formatMB(SINGLE_STREAM_BASELINE)}（watch=${elapsedSec.toFixed(1)}s，增量=${formatMB(endDownloaded - startDownloaded)}）`,
    )
    const uiText = await state.client.evaluate('document.body.innerText.slice(0, 4000)')
    results.record(
      'UI 状态正确：下载中 + 已下载/总量 + 速度/进行中指标',
      /已下载/.test(uiText) && /(\d+(\.\d+)?\s*(MB|GB))\s*\/\s*(\d+(\.\d+)?\s*(GB|MB|TB))/.test(uiText) && /下载中|进行中/.test(uiText),
      uiText.replace(/\s+/g, ' ').slice(0, 260),
    )
    await screenshot(state.client, '02-resumed-segmented-active')

    // 下载中读取的元数据快照留证
    writeFileSync(join(EVIDENCE_DIR, 'part-meta-during-resume.json'), JSON.stringify({ chunkSize: chunkMeta?.chunkSize, chunksLen: chunks?.length, chunksSum, partAllocated, speedMax: maxSpeed, speedAvg: avgSpeed }, null, 2))

    // ---------- 2) 暂停（约 256-512MB 后） ----------
    const clickedPause = await clickTaskAction(state.client, '暂停下载', TARGET_FILE)
    results.record('点击「暂停下载」', clickedPause)
    const paused = await waitStatus(state.client, ['paused'], 90000)
    results.record('暂停成功（paused）', paused?.status === 'paused', JSON.stringify(paused ? { status: paused.status, downloaded: paused.downloaded } : null))
    const partAfter1 = statSync(partPath).size
    const metaAfter1 = readJson(metaPath)
    const chunksSum1 = Array.isArray(metaAfter1?.chunks) ? metaAfter1.chunks.reduce((sum, value) => sum + Number(value || 0), 0) : null
    const taskPaused1 = findUserTask()
    results.record('.part 数据只增不减（预分配 total，旧数据未被清空）', partAfter1 >= partBefore, `before=${partBefore}B after=${partAfter1}B`)
    results.record('暂停后 tasks.json 状态 paused 且 downloaded 已更新', taskPaused1?.status === 'paused' && Number(taskPaused1.downloaded) >= Number(taskBefore.downloaded), JSON.stringify(taskPaused1 ? { status: taskPaused1.status, downloaded: taskPaused1.downloaded } : null))
    results.record('暂停后 chunk 元数据保留', Boolean(metaAfter1?.chunks?.length) && chunksSum1 !== null, `chunks=${metaAfter1?.chunks?.length} chunksSum=${chunksSum1}`)
    await screenshot(state.client, '03-paused-after-segment')

    // ---------- 3) 再次继续 → 不从 0 开始 ----------
    const resumedAgain = await clickTaskAction(state.client, '继续下载', TARGET_FILE)
    const active2 = await waitStatus(state.client, ['active'], 60000)
    await sleep(1800)
    const sample2 = await taskOf(state.client)
    results.record(
      '暂停后再继续仍从断点继续（不从 0 开始）',
      resumedAgain && active2?.status === 'active' && Number(sample2?.downloaded) >= Number(paused?.downloaded),
      `paused=${paused?.downloaded}B → resumed=${sample2?.downloaded}B`,
    )
    await clickTaskAction(state.client, '暂停下载', TARGET_FILE)
    const paused2 = await waitStatus(state.client, ['paused'], 60000)
    results.record('第二次暂停成功（最终状态 paused）', paused2?.status === 'paused', JSON.stringify(paused2 ? { status: paused2.status, downloaded: paused2.downloaded } : null))

    // ---------- 4) 最终数据完整性 ----------
    const fpAfter = fingerprint(partPath, statSync(partPath).size)
    writeFileSync(join(EVIDENCE_DIR, 'part-fingerprint-after.json'), JSON.stringify(fpAfter, null, 2))
    results.record(
      '旧断点前缀未被重新下载（head/1GiB 指纹完全一致）',
      fpAfter.head === fpBefore.head && fpAfter.mid1G === fpBefore.mid1G,
      `head=${fpAfter.head === fpBefore.head ? '一致' : '变化'}，mid1G=${fpAfter.mid1G === fpBefore.mid1G ? '一致' : '变化'}`,
    )
    const finalMeta = readJson(metaPath)
    const finalTask = findUserTask()
    results.record(
      '最终：用户任务 paused、数据只增不减、chunk 元数据完好',
      finalTask?.status === 'paused' && statSync(partPath).size >= partBefore && Array.isArray(finalMeta?.chunks) && finalMeta.chunks.length > 0,
      `status=${finalTask?.status} downloaded=${finalTask?.downloaded} part=${statSync(partPath).size} chunks=${finalMeta?.chunks?.length}`,
    )
    writeFileSync(
      join(EVIDENCE_DIR, 'resume-data.json'),
      JSON.stringify({ before: { downloaded: taskBefore.downloaded, partSize: partBefore, fpBefore }, after: { downloaded: finalTask?.downloaded, partSize: statSync(partPath).size, chunks: finalMeta?.chunks?.length, chunksSum: Array.isArray(finalMeta?.chunks) ? finalMeta.chunks.reduce((sum, v) => sum + Number(v || 0), 0) : null }, speed: { max: maxSpeed, avg: avgSpeed, baseline: SINGLE_STREAM_BASELINE } }, null, 2),
      'utf8',
    )
    await screenshot(state.client, '04-final-paused')

    state.pageErrors = state.client.pageErrors.slice()
    state.consoleErrors = state.client.consoleErrors.slice()
    results.record('运行期无未捕获页面异常', state.pageErrors.length === 0, `${state.pageErrors.length} 个`)
  } finally {
    if (state.client) await state.client.close().catch(() => {})
    killOwnApp()
    await sleep(1500)
    // 仅还原 settings.json；tasks.json / .part / .part.json 保留测试后的 paused 状态与已完成数据
    const settingsRestored = restoreSettings()
    notes.push(`settings.json 已${settingsRestored ? '' : '未'}还原；tasks.json 保留更新后的 paused 状态（含新增 chunk 元数据）。`)
    rmSync(WEBVIEW_DATA_DIR, { recursive: true, force: true })
    console.log('已结束测试实例并清理临时 WebView2 数据目录')
    const finalTask = findUserTask()
    console.log(`用户任务最终状态：${finalTask?.status}，downloaded=${finalTask?.downloaded}，part=${existsSync(partPath) ? statSync(partPath).size : 'missing'}`)
  }

  const summary = results.summary('v0.2.0 指定大文件任务 旧断点兼容验收')
  writeFileSync(
    RESULT_JSON,
    JSON.stringify({ stamp: STAMP, exe: EXE, partBefore, etagChanged, notes, summary, screenshots: state.screenshots, consoleErrors: state.consoleErrors, pageErrors: state.pageErrors }, null, 2),
    'utf8',
  )
  console.log(`结果 JSON：${RESULT_JSON}`)
  if (notes.length > 0) {
    console.log('\n说明：')
    for (const note of notes) console.log(`  - ${note}`)
  }
  process.exitCode = summary.failed === 0 ? 0 : 1
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB/s`
}

main().catch((error) => {
  console.error(`\n断点兼容验收异常：${error.message || error}`)
  results.record('断点兼容验收主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('v0.2.0 指定大文件任务 旧断点兼容验收（异常终止）')
  try {
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, notes, fatalError: String(error.stack || error) }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  if (state.client) state.client.close().catch(() => {})
  killOwnApp()
  try {
    restoreSettings()
  } catch {
    /* ignore */
  }
  process.exitCode = 1
})
