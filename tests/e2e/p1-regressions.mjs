#!/usr/bin/env node
/**
 * tests/e2e/p1-regressions.mjs — P1 修复针对性回归验收（真实 UI / 真实后端）
 *
 * 对应 docs/BACKEND-REVIEW.md 的 3 个 P1：
 *   P1-1 队列 TOCTOU：下载接近完成时点「暂停」，任务不得永久卡在 `pausing`。
 *        用例：真实 UI 下载 ModelScope tokenizer.json（7,031,645B，限速 1MB/s），
 *        轮询到约 78% 时点击「暂停下载」，观察最终状态必须收敛为 `paused` 或 `completed`
 *        （允许暂停命令在完成之后到达），不得停留在 `pausing`；若为 paused 再点「继续下载」
 *        直至完成，最终文件 sha256 与 curl 独立下载一致。默认重复 5 轮。
 *   P1-3 陈旧 `.part` 长度 > total：预置 4KB 垃圾 `.part`（远端 config.json 仅 659B）后开始下载，
 *        任务不得把超长陈旧内容直接 rename 为最终文件；最终文件必须为 659B 且 sha256 与独立下载一致。
 *   P1-2 `retries` 恒 0：真实 UI 无法触发可重试网络错误（数据源固定），由 backend-rust 新增单元测试覆盖；
 *        本脚本仅校验任务字段 `retries` 存在且为数字（初值 0），并在报告中引用单测证据。
 *
 * 前置：npm run build && (cd src-tauri && cargo build)（debug exe 为 Tauri dev 模式时需 vite dev server 在 1420）。
 * 用法：node tests/e2e/p1-regressions.mjs [--rounds 5] [--exe <path>] [--port 9223] [--keep]
 *
 * 写域：只读应用源码；运行期写 .temp/qa/、系统临时目录，并临时备份/恢复
 * %APPDATA%\com.modeldownload.manager 下 settings.json/tasks.json。
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, createResults, listTargets, PORT_WEBVIEW2, sha256File, sleep, waitForEndpoint } from './cdp.mjs'

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
    } else {
      options[key] = true
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const PORT = Number(options.port || PORT_WEBVIEW2)
const ROUNDS = Math.max(1, Number(options.rounds || 5))
const EXE = resolve(options.exe || join(ROOT, 'src-tauri', 'target', 'debug', 'model-download-manager.exe'))
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `p1-regressions-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'p1-regressions-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const BACKUP_DIR = join(EVIDENCE_DIR, 'appdata-backup')
const TEMP_ROOT = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'Temp', 'mdm-qa')
const DOWNLOAD_DIR = join(TEMP_ROOT, `p1-${STAMP}`)

const results = createResults()
const notes = []
const rounds = []
const state = {
  client: null,
  proc: null,
  appExitCode: null,
  backupFiles: [],
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
}

const REPO_ID = 'Qwen/Qwen2.5-0.5B-Instruct'
const RESUME_FILE = 'tokenizer.json'
const RESUME_SIZE = 7031645
const STALE_FILE = 'config.json'
const STALE_SIZE = 659

const screenshot = (client, name) =>
  client
    .screenshot(join(EVIDENCE_DIR, 'shots', `${name}.png`))
    .then((info) => {
      state.screenshots.push(info.path)
      return info.path
    })
    .catch(() => null)

/* ------------------------------------------------------------------ */
/* 应用启动 / 清理                                                     */
/* ------------------------------------------------------------------ */

function killAppProcesses() {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-Process -Name 'model-download-manager' -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $_.Id }",
    ],
    { encoding: 'utf8', timeout: 20000 },
  )
  return (result.stdout || '').split(/\s+/).filter(Boolean)
}

function backupAppData() {
  mkdirSync(BACKUP_DIR, { recursive: true })
  for (const name of ['settings.json', 'tasks.json']) {
    const source = join(APP_DATA_DIR, name)
    if (existsSync(source)) {
      copyFileSync(source, join(BACKUP_DIR, name))
      state.backupFiles.push(name)
    }
  }
  rmSync(join(APP_DATA_DIR, 'tasks.json'), { force: true })
}

function restoreAppData() {
  try {
    for (const name of ['settings.json', 'tasks.json']) {
      const target = join(APP_DATA_DIR, name)
      if (state.backupFiles.includes(name)) copyFileSync(join(BACKUP_DIR, name), target)
      else rmSync(target, { force: true })
    }
  } catch (error) {
    console.warn(`恢复应用数据失败：${error.message}`)
  }
}

async function launchApp() {
  if (!existsSync(EXE)) throw new Error(`应用 exe 不存在：${EXE}`)
  killAppProcesses()
  const freeDeadline = Date.now() + 10000
  while (Date.now() < freeDeadline) {
    try {
      await listTargets(PORT, 1000)
      await sleep(300)
    } catch {
      break
    }
  }
  await sleep(800)
  const logFd = openSync(join(EVIDENCE_DIR, 'app.log'), 'a')
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=*`,
  }
  console.log(`启动应用：${EXE}`)
  state.proc = spawn(EXE, [], { env, stdio: ['ignore', logFd, logFd], windowsHide: false })
  state.proc.on('exit', (code, signal) => {
    state.appExitCode = code
    console.log(`应用进程退出：code=${code} signal=${signal}`)
  })
  await waitForEndpoint(PORT, { timeoutMs: 60000, label: 'WebView2 DevTools' })
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const targets = await listTargets(PORT).catch(() => [])
    const target = targets.find((item) => /tauri\.localhost|tauri:\/\/|localhost:1420/.test(item.url || ''))
    if (target) return target
    if (state.appExitCode !== null) {
      throw new Error(`应用启动后退出（code=${state.appExitCode}）；targets=${JSON.stringify(targets.map((t) => t.url))}`)
    }
    await sleep(300)
  }
  throw new Error('未找到应用页面 target')
}

async function connectApp(target) {
  const client = await connect(PORT, (item) => item.id === target.id, { timeoutMs: 30000 })
  await client.startCapture()
  await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'Tauri IPC 就绪' })
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照加载完成' })
  return client
}

async function snapshot(client) {
  return client.tauriInvoke('get_snapshot')
}

/* ------------------------------------------------------------------ */
/* UI 操作                                                             */
/* ------------------------------------------------------------------ */

async function clickSidebar(client, label) {
  await client.clickByText(label, 'aside nav button, aside button')
  await sleep(300)
}

async function ensureSettings(client, { downloadDir, bandwidthMbps } = {}) {
  await clickSidebar(client, '设置')
  await client.waitFor('Boolean(document.querySelector("#settings-download-dir"))', {
    timeoutMs: 20000,
    description: '设置页',
  })
  if (downloadDir) await client.type('#settings-download-dir', downloadDir)
  if (bandwidthMbps !== undefined) await client.type('#settings-bandwidth', String(bandwidthMbps))
  await client.clickByText('保存设置')
  const expectedBandwidth =
    bandwidthMbps === undefined ? null : Math.round(Number(bandwidthMbps) <= 0 ? 0 : Number(bandwidthMbps) * 1024 * 1024)
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const current = await client.tauriInvoke('get_settings')
    const dirOk = !downloadDir || current.downloadDir === downloadDir
    const bwOk = expectedBandwidth === null || Math.abs(Number(current.bandwidthLimit) - expectedBandwidth) <= 1
    if (dirOk && bwOk) {
      results.record('设置页保存生效', true, `downloadDir=${current.downloadDir} bandwidthLimit=${current.bandwidthLimit}`)
      return current
    }
    await sleep(250)
  }
  throw new Error('设置保存超时')
}

async function openRepoDetail(client, repoId, source, downloadDir) {
  const base = await client.evaluate('location.origin + location.pathname')
  await client.navigate(`${base}?repo=${encodeURIComponent(repoId)}&source=${source}`)
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(repoId)})`, {
    timeoutMs: 45000,
    description: '仓库详情加载',
  })
  await client.waitFor('document.querySelectorAll(\'input[aria-label^="选择 "]\').length > 0', {
    timeoutMs: 45000,
    description: '文件列表渲染',
  })
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(downloadDir)})`, {
    timeoutMs: 20000,
    description: '下载目录为设置目录',
  })
}

async function selectOnlyFile(client, filePath) {
  await client.clickByText('清空选择')
  await sleep(200)
  const selector = `input[aria-label=${JSON.stringify(`选择 ${filePath}`)}]`
  const ok = await client.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (!el.checked) el.click();
    return el.checked;
  })()`)
  if (!ok) throw new Error(`勾选文件失败：${filePath}`)
}

async function startDownloadAndFindTask(client, filePath) {
  await client.clickByText('开始下载')
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const snap = await snapshot(client)
    const task = (snap.tasks || []).find(
      (item) => item.repoId === REPO_ID && item.remotePath === filePath && item.source === 'modelscope',
    )
    if (task) return task
    await sleep(250)
  }
  throw new Error('未在快照中找到新建任务')
}

async function goDownloads(client, filePath) {
  await clickSidebar(client, '下载队列')
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(filePath)})`, {
    timeoutMs: 30000,
    description: '下载队列出现任务',
  })
}

async function waitForTaskSnapshot(client, taskId, predicate, { timeoutMs = 60000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const snap = await snapshot(client)
    const task = (snap.tasks || []).find((item) => item.taskId === taskId)
    if (task) {
      last = task
      if (predicate(task)) return task
    }
    await sleep(intervalMs)
  }
  return last
}

async function clickTaskAction(client, label, fileName) {
  const selector = `button[aria-label=${JSON.stringify(`${label}：${fileName}`)}]`
  return client.evaluate(`(() => {
    const btn = document.querySelector(${JSON.stringify(selector)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
}

/** 删除本轮产生的最终文件/临时文件。 */
function cleanupFiles(filePath) {
  const finalPath = join(DOWNLOAD_DIR, 'Qwen', 'Qwen2.5-0.5B-Instruct', filePath)
  for (const path of [finalPath, `${finalPath}.part`, `${finalPath}.part.json`]) {
    rmSync(path, { force: true })
  }
  return finalPath
}

async function clearTasks(client) {
  try {
    await client.tauriInvoke('clear_finished')
  } catch {
    /* 老版本无该命令时忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function curlGet(url, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  const result = spawnSync(
    'curl.exe',
    ['-sS', '-L', '--fail', '--max-time', '120', '--retry', '2', '-o', destination, url],
    { encoding: 'utf8', timeout: 150000 },
  )
  if (result.status !== 0) throw new Error(`curl 失败 exit=${result.status} ${(result.stderr || '').slice(0, 200)}`)
}

let referenceSha = null
let staleReferenceSha = null

function prepareReferences() {
  const resumeRef = join(EVIDENCE_DIR, 'reference', `ms-${RESUME_FILE}`)
  curlGet(`https://www.modelscope.cn/models/${REPO_ID}/resolve/master/${RESUME_FILE}`, resumeRef)
  const resumeSize = statSync(resumeRef).size
  if (resumeSize !== RESUME_SIZE) throw new Error(`参考文件大小异常：${resumeSize}`)
  referenceSha = sha256File(resumeRef)

  const staleRef = join(EVIDENCE_DIR, 'reference', `ms-${STALE_FILE}`)
  curlGet(`https://www.modelscope.cn/models/${REPO_ID}/resolve/master/${STALE_FILE}`, staleRef)
  staleReferenceSha = sha256File(staleRef)
  results.record('curl 独立对照文件准备完成', referenceSha.length === 64 && staleReferenceSha.length === 64, `${REG_SIZE_LABEL()}；${RESUME_FILE}=${referenceSha.slice(0, 12)}… ${STALE_FILE}=${staleReferenceSha.slice(0, 12)}…`)
}

const REG_SIZE_LABEL = () => `${RESUME_FILE} ${RESUME_SIZE}B / ${STALE_FILE} ${STALE_SIZE}B`

function verifyFinalFile(task, expectedSha, label) {
  const info = existsSync(task.savePath) ? statSync(task.savePath) : null
  const sha = info ? sha256File(task.savePath) : null
  results.record(`${label} 最终文件存在且大小正确`, Boolean(info) && info.size === Number(task.totalSize), info ? `${info.size}B` : '缺失')
  results.record(`${label} 最终文件 sha256 与独立下载一致`, sha === expectedSha, sha ? sha.slice(0, 16) + '…' : '缺失')
  results.record(`${label} 临时文件已清理`, !existsSync(`${task.savePath}.part`) && !existsSync(`${task.savePath}.part.json`), '')
  return sha
}

/* ------------------------------------------------------------------ */
/* P1-1：接近完成时暂停（队列 TOCTOU）                                  */
/* ------------------------------------------------------------------ */

async function runP1_PauseRace(client, roundIndex) {
  const label = `P1-1 第 ${roundIndex} 轮`
  // 每轮从干净状态开始：删除文件 + 清理终态任务记录
  cleanupFiles(RESUME_FILE)
  await clearTasks(client)

  await openRepoDetail(client, REPO_ID, 'modelscope', DOWNLOAD_DIR)
  await selectOnlyFile(client, RESUME_FILE)
  const task = await startDownloadAndFindTask(client, RESUME_FILE)
  await goDownloads(client, RESUME_FILE)

  // 轮询到约 85%（真实下载 7MB / 限速 1MB/s，剩余约 1MB ≈1s 窗口）
  const threshold = Math.floor(RESUME_SIZE * 0.85)
  const observedStatuses = new Set()
  const progressTask = await waitForTaskSnapshot(
    client,
    task.taskId,
    (current) => {
      observedStatuses.add(current.status)
      return current.downloaded >= threshold || !['active', 'queued', 'pausing'].includes(current.status)
    },
    { timeoutMs: 120000, intervalMs: 80 },
  )
  if (!progressTask) throw new Error(`${label} 未获取到任务进度`)

  if (progressTask.status === 'completed') {
    const sha = verifyFinalFile(progressTask, referenceSha, `${label}（暂停前已完成）`)
    rounds.push({ round: roundIndex, outcome: 'completed-before-pause', status: 'completed', downloaded: progressTask.downloaded, sha256: sha })
    results.record(`${label} 状态收敛（完成先于暂停，非 pausing）`, true, `downloaded=${progressTask.downloaded}`)
    return true
  }

  const downloadedBeforePause = progressTask.downloaded
  const clicked = await clickTaskAction(client, '暂停下载', RESUME_FILE)
  const clickedAt = Date.now()
  const settled = await waitForTaskSnapshot(
    client,
    task.taskId,
    (current) => {
      observedStatuses.add(current.status)
      return ['paused', 'completed', 'error', 'cancelled'].includes(current.status)
    },
    { timeoutMs: 20000, intervalMs: 80 },
  )
  const settleMs = Date.now() - clickedAt
  const settledStatus = settled?.status
  const stuckPausing = settledStatus === 'pausing' || !settledStatus
  results.record(
    `${label} 暂停点击后状态收敛为 paused/completed（不得卡 pausing）`,
    !stuckPausing && ['paused', 'completed'].includes(settledStatus),
    `clicked=${clicked} downloaded=${downloadedBeforePause}/${RESUME_SIZE} → status=${settledStatus} 用时=${settleMs}ms 观察到状态=${[...observedStatuses].join('→')}`,
  )
  if (stuckPausing) {
    rounds.push({ round: roundIndex, outcome: 'STUCK', status: settledStatus || 'missing', settleMs, observed: [...observedStatuses] })
    await screenshot(client, `p1-1-stuck-round-${roundIndex}`)
    return false
  }

  if (!['paused', 'completed'].includes(settledStatus)) {
    // 暂停未生效/状态异常：等待任务回到终态以保持后续轮次干净，记录为失败
    const recovered = await waitForTaskSnapshot(client, task.taskId, (current) => ['completed', 'error', 'cancelled'].includes(current.status), {
      timeoutMs: 240000,
      intervalMs: 150,
    })
    rounds.push({ round: roundIndex, outcome: 'pause-not-applied', status: settledStatus, recovered: recovered?.status, settleMs })
    results.record(`${label} 暂停命令生效`, false, `最终状态=${settledStatus}（期望 paused/completed）`)
    return false
  }

  let finalTask = settled
  if (!finalTask) {
    results.record(`${label} 任务快照可用`, false, '任务从快照中消失')
    rounds.push({ round: roundIndex, outcome: 'missing-task', status: 'missing' })
    return false
  }
  if (settledStatus === 'paused') {
    const partInfo = existsSync(`${settled.savePath}.part`) ? statSync(`${settled.savePath}.part`).size : 0
    results.record(`${label} 暂停时 .part 保留`, partInfo > 0, `${partInfo}B`)
    const resumedOk = await clickTaskAction(client, '继续下载', RESUME_FILE)
    results.record(`${label} 继续按钮可点击`, Boolean(resumedOk), '')
    finalTask = await waitForTaskSnapshot(client, task.taskId, (current) => ['completed', 'error', 'cancelled'].includes(current.status), {
      timeoutMs: 240000,
      intervalMs: 150,
    })
    results.record(`${label} 继续后完成`, finalTask?.status === 'completed', `status=${finalTask?.status}`)
  }
  const sha = verifyFinalFile(finalTask, referenceSha, label)
  rounds.push({
    round: roundIndex,
    outcome: settledStatus === 'paused' ? 'paused-then-resumed' : 'completed-after-pause',
    status: finalTask?.status,
    settleMs,
    downloadedBeforePause,
    observed: [...observedStatuses],
    sha256: sha,
  })
  if (roundIndex === 1) await screenshot(client, 'p1-1-first-round')
  return true
}

/* ------------------------------------------------------------------ */
/* P1-3：陈旧超长 .part（数据完整性）                                   */
/* ------------------------------------------------------------------ */

async function runP1_StalePart(client) {
  const label = 'P1-3 陈旧超长 .part'
  cleanupFiles(STALE_FILE)
  await clearTasks(client)
  const finalPath = join(DOWNLOAD_DIR, 'Qwen', 'Qwen2.5-0.5B-Instruct', STALE_FILE)
  mkdirSync(dirname(finalPath), { recursive: true })
  // 预置 4096B 垃圾 part（远端 config.json 仅 659B），模拟异常退出/比列表 size 更长的陈旧遗留
  writeFileSync(`${finalPath}.part`, Buffer.alloc(4096, 0x41))
  const partBefore = statSync(`${finalPath}.part`).size
  results.record('预置陈旧超长 .part', partBefore === 4096, `${finalPath}.part = ${partBefore}B > total ${STALE_SIZE}B`)

  await openRepoDetail(client, REPO_ID, 'modelscope', DOWNLOAD_DIR)
  await selectOnlyFile(client, STALE_FILE)
  const task = await startDownloadAndFindTask(client, STALE_FILE)
  await goDownloads(client, STALE_FILE)
  const completed = await waitForTaskSnapshot(client, task.taskId, (current) => ['completed', 'error', 'cancelled'].includes(current.status), {
    timeoutMs: 120000,
    intervalMs: 150,
  })
  results.record(`${label} 任务完成`, completed?.status === 'completed', `status=${completed?.status} downloaded=${completed?.downloaded}/${completed?.totalSize}`)
  if (!completed) {
    rounds.push({ check: 'P1-3', status: 'timeout' })
    return
  }

  const info = existsSync(completed.savePath) ? statSync(completed.savePath) : null
  const sha = info ? sha256File(completed.savePath) : null
  // 修复前：把 4096B 垃圾 part 直接 rename → 最终 4096B、sha 不匹配；修复后：应为 659B 正常下载
  results.record(`${label} 未把陈旧 part 直接当完成（大小）`, Boolean(info) && info.size === STALE_SIZE, info ? `${info.size}B（期望 ${STALE_SIZE}B）` : '缺失')
  results.record(`${label} 最终文件 sha256 与远端一致`, sha === staleReferenceSha, sha ? sha.slice(0, 16) + '…' : '缺失')
  results.record(`${label} .part/.part.json 已清理`, !existsSync(`${completed.savePath}.part`) && !existsSync(`${completed.savePath}.part.json`), '')
  await screenshot(client, 'p1-3-stale-part-completed')
  rounds.push({ check: 'P1-3', status: completed?.status, finalSize: info?.size ?? 0, sha256: sha, expectedSha: staleReferenceSha })
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  mkdirSync(APP_DATA_DIR, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  console.log(`临时下载目录：${DOWNLOAD_DIR}`)
  results.record('应用 exe 存在', existsSync(EXE), EXE)
  if (!existsSync(EXE)) {
    const summary = results.summary('P1 回归验收（缺少前置构建）')
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, fatalError: `缺少 exe：${EXE}` }, null, 2), 'utf8')
    process.exitCode = 1
    return
  }

  prepareReferences()
  backupAppData()
  try {
    const target = await launchApp()
    state.client = await connectApp(target)
    await ensureSettings(state.client, { downloadDir: DOWNLOAD_DIR, bandwidthMbps: 1 })

    for (let round = 1; round <= ROUNDS; round += 1) {
      console.log(`\n──────── P1-1 第 ${round}/${ROUNDS} 轮 ────────`)
      const ok = await runP1_PauseRace(state.client, round)
      if (!ok) {
        notes.push(`P1-1 在第 ${round} 轮检测到任务卡在 pausing，已终止后续轮次（视为此 P1 未修复）`)
        break
      }
    }

    console.log('\n──────── P1-3 陈旧超长 .part ────────')
    await runP1_StalePart(state.client)

    // P1-2：UI 侧无法触发可重试网络错误，由新增单测覆盖；此处仅确认字段存在。
    console.log('\n──────── P1-2 retries 字段（单测覆盖） ────────')
    try {
      const snap = await snapshot(state.client)
      const anyTask = (snap.tasks || [])[0]
      const fieldOk = anyTask ? typeof anyTask.retries === 'number' : true
      results.record('P1-2 任务 retries 字段存在且为数字（修复由单测覆盖，见报告）', fieldOk, anyTask ? `task retries=${anyTask.retries}` : '当前无任务快照（字段校验跳过）')
      notes.push('P1-2（retries 恒 0）真实 UI 无法触发可重试网络错误（数据源固定为 HF/Mirror/ModelScope），修复验证依赖 backend-rust 新增单元测试，见 QA 报告「P1 修复后复验」章节引用。')
    } catch (error) {
      results.record('P1-2 retries 字段检查', false, String(error.message).slice(0, 300))
    }

    // 恢复不限速
    await ensureSettings(state.client, { bandwidthMbps: 0 })

    state.consoleErrors = state.client.consoleErrors.slice()
    state.pageErrors = state.client.pageErrors.slice()
    results.record('运行期无未捕获页面异常', state.pageErrors.length === 0, `${state.pageErrors.length} 个`)
    const ignored = (item) =>
      /favicon/i.test(item.text) || /Failed to load resource: the server responded with a status of 404/.test(item.text) || /DevTools/.test(item.text)
    const realErrors = state.consoleErrors.filter((item) => !ignored(item))
    results.record('运行期无控制台错误', realErrors.length === 0, realErrors.map((e) => e.text).join(' | ').slice(0, 600))
  } finally {
    if (state.client) await state.client.close().catch(() => {})
    killAppProcesses()
    if (!options.keep) {
      try {
        rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    restoreAppData()
    console.log('已还原应用数据（settings.json / tasks.json）')
  }

  const summary = results.summary('P1 修复针对性回归验收')
  const stuck = rounds.filter((item) => item.outcome === 'STUCK').length
  const report = {
    stamp: STAMP,
    exe: EXE,
    roundsRequested: ROUNDS,
    rounds,
    stuckPausing: stuck,
    notes,
    summary,
    evidenceDir: EVIDENCE_DIR,
    screenshots: state.screenshots,
    consoleErrors: state.consoleErrors,
    pageErrors: state.pageErrors,
  }
  writeFileSync(RESULT_JSON, JSON.stringify(report, null, 2), 'utf8')
  console.log(`结果 JSON：${RESULT_JSON}`)
  process.exitCode = summary.failed === 0 && stuck === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`\nP1 回归验收异常：${error.message || error}`)
  results.record('P1 回归主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('P1 修复针对性回归验收（异常终止）')
  try {
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, rounds, fatalError: String(error.stack || error) }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  if (state.client) state.client.close().catch(() => {})
  killAppProcesses()
  restoreAppData()
  process.exitCode = 1
})
