#!/usr/bin/env node
/**
 * tests/e2e/app-ui-checks.mjs — 真实应用 UI / 设置持久化 / 安全验收（Phase B 可复跑）
 *
 * 复用 tests/e2e/cdp.mjs；以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>
 * 启动真实 debug exe（需先 npm run build && cargo build），然后：
 *
 *   pages     四个页面真实模式截图 + 白屏/控制台错误/页面异常检查（浏览页真实搜索 API 验证）；
 *   settings  设置页修改并发/限速/下载目录 → 保存 → 检查 settings.json → 重启应用 → 验证持久化；
 *   security  路径穿越（repoId/remotePath 中的 ..、绝对路径、盘符、UNC）被拒绝；Token 不出现在日志/错误中。
 *
 * 用法：
 *   node tests/e2e/app-ui-checks.mjs [--exe <path>] [--port 9223] [--checks pages,settings,security]
 *
 * 结束后自动关闭应用并还原 %APPDATA%\com.modeldownload.manager 下的 settings.json / tasks.json。
 * 写域：本脚本只读应用源码，运行期仅写 .temp/qa/、系统临时目录，并临时备份/恢复应用数据。
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
    } else {
      options[key] = true
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const PORT = Number(options.port || PORT_WEBVIEW2)
const EXE = resolve(options.exe || join(ROOT, 'src-tauri', 'target', 'debug', 'model-download-manager.exe'))
const CHECKS = new Set(
  String(options.checks || 'pages,settings,security')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
)
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `ui-checks-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'ui-checks-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const BACKUP_DIR = join(EVIDENCE_DIR, 'appdata-backup')
const TMP_DOWNLOAD_DIR = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'Temp', 'mdm-qa', `ui-checks-${STAMP}`)

const results = createResults()
const state = {
  client: null,
  proc: null,
  appExitCode: null,
  backupFiles: [],
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
}

const screenshot = (client, name) =>
  client
    .screenshot(join(EVIDENCE_DIR, 'shots', `${name}.png`))
    .then((info) => {
      state.screenshots.push(info.path)
      return info
    })
    .catch((error) => {
      console.warn(`截图失败 ${name}: ${error.message}`)
      return null
    })

/* ------------------------------------------------------------------ */
/* 应用启动/连接/清理                                                  */
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
  const pids = (result.stdout || '').split(/\s+/).filter(Boolean)
  if (pids.length > 0) console.log(`已结束应用进程：${pids.join(', ')}`)
  return pids
}

async function launchApp() {
  if (!existsSync(EXE)) throw new Error(`应用 exe 不存在：${EXE}（请先 npm run build && cargo build）`)
  killAppProcesses()
  const logFd = openSync(join(EVIDENCE_DIR, 'app.log'), 'a')
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=*`,
  }
  console.log(`启动应用：${EXE}`)
  state.proc = spawn(EXE, [], { env, stdio: ['ignore', logFd, logFd], windowsHide: false })
  state.appExitCode = null
  state.proc.on('exit', (code, signal) => {
    state.appExitCode = code
    console.log(`应用进程退出：code=${code} signal=${signal}`)
  })
  await waitForEndpoint(PORT, { timeoutMs: 60000, label: 'WebView2 DevTools' })
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const targets = await listTargets(PORT).catch(() => [])
    const appTarget = targets.find((target) => /tauri\.localhost|tauri:\/\/|localhost:1420/.test(target.url || ''))
    if (appTarget) return appTarget
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
  await client.waitFor('document.readyState === "complete"', { timeoutMs: 30000, description: '页面加载' })
  await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'Tauri IPC 就绪' })
  await client.waitFor('document.body.innerText.includes("模型下载管理器")', { timeoutMs: 30000, description: '应用 shell 就绪' })
  // 等快照加载（真实模式侧边栏显示“本地存储”）。
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照加载完成' })
  return client
}

/** 重启应用并重连，返回新 client。 */
async function restartApp() {
  if (state.client) {
    await state.client.close().catch(() => {})
    state.client = null
  }
  killAppProcesses()
  await sleep(1500)
  const target = await launchApp()
  state.client = await connectApp(target)
  return state.client
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

/* ------------------------------------------------------------------ */
/* 页面检查                                                            */
/* ------------------------------------------------------------------ */

async function clickSidebar(client, label) {
  await client.clickByText(label, 'aside nav button, aside button')
  await sleep(300)
}

const PAGE_CHECKS = [
  {
    key: 'browse',
    label: '浏览仓库',
    marker: 'input[aria-label="搜索仓库"]',
    waitText: '已加载',
    description: '搜索区 + 真实搜索 API 返回列表',
  },
  {
    key: 'downloads',
    label: '下载队列',
    marker: null,
    waitText: '下载队列',
    description: '队列页渲染（空状态或任务列表）',
  },
  {
    key: 'library',
    label: '本地模型库',
    marker: null,
    waitText: '本地模型库',
    description: '本地库扫描页渲染',
  },
  {
    key: 'settings',
    label: '设置',
    marker: '#settings-download-dir',
    waitText: '下载目录',
    description: '设置页渲染且设置项加载',
  },
]

async function repoCardsInfo(client) {
  return client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('button[aria-label^="打开仓库 "]')];
    return {
      count: cards.length,
      ids: cards.slice(0, 20).map((el) => (el.getAttribute('aria-label') || '').replace('打开仓库 ', '')),
    };
  })()`)
}

async function waitRepoCards(client, { predicate = null, timeoutMs = 45000, description = '仓库卡片' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = { count: 0, ids: [] }
  while (Date.now() < deadline) {
    last = await repoCardsInfo(client)
    if (last.count > 0 && (!predicate || predicate(last))) return last
    await sleep(300)
  }
  throw new Error(`等待${description}超时；最后卡片=${JSON.stringify(last)}`)
}

async function runPageChecks(client) {
  console.log('\n──────── 四页面真实模式检查 ────────')
  const origin = await client.evaluate('location.href')
  results.record('应用页面来源（真实模式）', /tauri\.localhost|tauri:\/\//.test(origin) || origin.includes('localhost:1420'), origin)

  // 浏览页：HuggingFace（默认 hf-mirror）真实搜索 + Link 分页「加载更多」
  await clickSidebar(client, '浏览仓库')
  await client.waitFor('Boolean(document.querySelector(\'input[aria-label="搜索仓库"]\'))', {
    timeoutMs: 20000,
    description: '浏览页搜索框',
  })
  try {
    const cards = await waitRepoCards(client, { description: 'HuggingFace 真实搜索结果' })
    results.record('浏览页真实搜索（HuggingFace / hf-mirror）', cards.count > 0, `已加载 ${cards.count} 个仓库，首个=${cards.ids[0]}`)
    try {
      const before = cards.count
      await client.clickByText('加载更多', 'button')
      const more = await waitRepoCards(client, {
        predicate: (info) => info.count > before,
        timeoutMs: 45000,
        description: '「加载更多」追加结果',
      })
      results.record('浏览页「加载更多」（HF Link 分页）', more.count > before, `${before} → ${more.count} 个仓库`)
    } catch (error) {
      results.record('浏览页「加载更多」（HF Link 分页）', false, String(error.message).slice(0, 400))
    }
  } catch (error) {
    results.record('浏览页真实搜索（HuggingFace / hf-mirror）', false, String(error.message).slice(0, 400))
  }

  // 切换到 ModelScope 再验证一次真实搜索（等待卡片来源徽章为 ModelScope，避免读到旧 HF 卡片）
  try {
    await client.clickByText('ModelScope', 'button')
    await client.waitFor(
      `document.querySelectorAll('button[aria-label^="打开仓库 "]').length > 0 && [...document.querySelectorAll('button[aria-label^="打开仓库 "]')].some((el) => el.innerText.includes('ModelScope'))`,
      { timeoutMs: 45000, description: 'ModelScope 真实搜索结果' },
    )
    const msCards = await waitRepoCards(client, { description: 'ModelScope 仓库卡片' })
    results.record('浏览页真实搜索（ModelScope）', msCards.count > 0, `已加载 ${msCards.count} 个仓库，首个=${msCards.ids[0]}`)
    await screenshot(client, 'browse-modelscope')
    // 切回 HuggingFace，保持状态一致
    await client.clickByText('HuggingFace', 'button')
    await sleep(1500)
  } catch (error) {
    results.record('浏览页真实搜索（ModelScope）', false, String(error.message).slice(0, 400))
  }

  for (const page of PAGE_CHECKS) {
    await clickSidebar(client, page.label)
    if (page.marker) {
      await client.waitFor(`Boolean(document.querySelector(${JSON.stringify(page.marker)}))`, {
        timeoutMs: 20000,
        description: `${page.label} 页面标记`,
      })
    }
    await client.waitFor(`document.querySelector('h1') && document.querySelector('h1').innerText.trim() === ${JSON.stringify(page.label)}`, {
      timeoutMs: 20000,
      description: `${page.label} 页面标题`,
    })
    await client.waitFor(`document.body.innerText.includes(${JSON.stringify(page.waitText)})`, {
      timeoutMs: 20000,
      description: `${page.label} 内容`,
    })
    await sleep(800) // 等异步数据（库扫描/任务列表）稳定
    const text = await client.bodyText(6000)
    const shot = await screenshot(client, page.key)
    results.record(
      `页面：${page.label}`,
      text.length > 150 && Boolean(shot) && shot.bytes > 5000,
      `text=${text.length} chars, png=${shot ? shot.bytes : 0} bytes, ${page.description}`,
    )
    // 错误横幅检查
    const hasError = await client.evaluate(
      'Boolean(document.querySelector(\'[role="alert"]\')) && /失败|错误/.test(document.body.innerText)',
    )
    results.record(`页面：${page.label} 无错误横幅`, !hasError, hasError ? '检测到 role=alert 错误提示' : '')
  }

  // 事件通道（前端 listen 订阅是否成功建立）
  try {
    await client.waitFor('document.body.innerText.includes("事件通道已连接")', {
      timeoutMs: 15000,
      description: '事件通道已连接',
    })
    results.record('前端事件通道已连接（listen 订阅成功）', true, 'download-progress/task-updated 等 4 个事件')
  } catch (error) {
    results.record('前端事件通道已连接（listen 订阅成功）', false, String(error.message).slice(0, 300))
  }

  state.consoleErrors = client.consoleErrors.slice()
  state.pageErrors = client.pageErrors.slice()
  results.record('页面运行期无未捕获异常', state.pageErrors.length === 0, `${state.pageErrors.length} 个：${state.pageErrors.map((e) => e.text).join(' | ').slice(0, 500)}`)
  const ignored = (item) =>
    /favicon/i.test(item.text) || /Failed to load resource: the server responded with a status of 404/.test(item.text) || /DevTools/.test(item.text)
  const realErrors = state.consoleErrors.filter((item) => !ignored(item))
  results.record('页面运行期无控制台错误', realErrors.length === 0, realErrors.map((e) => e.text).join(' | ').slice(0, 800))
}

/* ------------------------------------------------------------------ */
/* 设置持久化                                                          */
/* ------------------------------------------------------------------ */

async function getSettings(client) {
  return client.tauriInvoke('get_settings')
}

async function saveSettingsViaUi(client) {
  await client.clickByText('保存设置')
  await sleep(500)
}

async function waitSettings(client, predicate, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await getSettings(client)
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`等待设置条件超时：${description}；当前=${JSON.stringify(last)}`)
}

async function runSettingsChecks(client) {
  console.log('\n──────── 设置持久化检查 ────────')
  mkdirSync(TMP_DOWNLOAD_DIR, { recursive: true })
  const original = await getSettings(client)
  results.record('读取当前设置', Boolean(original?.downloadDir), `concurrency=${original.concurrency} bandwidthLimit=${original.bandwidthLimit}`)

  await clickSidebar(client, '设置')
  await client.waitFor('Boolean(document.querySelector("#settings-download-dir"))', { timeoutMs: 20000, description: '设置页' })

  // 修改：下载目录、并发 +1、限速 1.5 MB/s
  await client.type('#settings-download-dir', TMP_DOWNLOAD_DIR)
  const originalConcurrency = Number(original.concurrency)
  await client.evaluate(`(() => {
    const el = document.querySelector('button[aria-label="并发下载数增加"]');
    if (el) { el.click(); return true; }
    return false;
  })()`)
  await client.type('#settings-bandwidth', '1.5')
  await screenshot(client, 'settings-edited')
  await saveSettingsViaUi(client)
  const expectedConcurrency = Math.min(8, originalConcurrency + 1)
  const expectedBandwidth = Math.round(1.5 * 1024 * 1024)
  const saved = await waitSettings(
    client,
    (settings) =>
      settings.downloadDir === TMP_DOWNLOAD_DIR &&
      Number(settings.concurrency) === expectedConcurrency &&
      Math.abs(Number(settings.bandwidthLimit) - expectedBandwidth) <= 1,
    `downloadDir=${TMP_DOWNLOAD_DIR} concurrency=${expectedConcurrency} bandwidthLimit=${expectedBandwidth}`,
  )
  results.record(
    '设置页保存后立即生效（get_settings）',
    saved.downloadDir === TMP_DOWNLOAD_DIR && Number(saved.concurrency) === expectedConcurrency,
    `downloadDir=${saved.downloadDir} concurrency=${saved.concurrency} bandwidthLimit=${saved.bandwidthLimit}`,
  )

  // settings.json 磁盘内容
  const settingsPath = join(APP_DATA_DIR, 'settings.json')
  let diskSettings = null
  try {
    diskSettings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    results.record(
      'settings.json 已原子写盘且字段正确',
      diskSettings.downloadDir === TMP_DOWNLOAD_DIR &&
        Number(diskSettings.concurrency) === expectedConcurrency &&
        Math.abs(Number(diskSettings.bandwidthLimit) - expectedBandwidth) <= 1,
      settingsPath,
    )
  } catch (error) {
    results.record('settings.json 已原子写盘且字段正确', false, String(error.message))
  }
  await screenshot(client, 'settings-saved')

  // 重启应用后持久化
  const restarted = await restartApp()
  const afterRestart = await getSettings(restarted)
  results.record(
    '重启应用后设置持久化生效',
    afterRestart.downloadDir === TMP_DOWNLOAD_DIR &&
      Number(afterRestart.concurrency) === expectedConcurrency &&
      Math.abs(Number(afterRestart.bandwidthLimit) - expectedBandwidth) <= 1,
    `downloadDir=${afterRestart.downloadDir} concurrency=${afterRestart.concurrency} bandwidthLimit=${afterRestart.bandwidthLimit}`,
  )
  await clickSidebar(restarted, '设置')
  await sleep(800)
  const settingsUiText = await restarted.bodyText(6000)
  results.record(
    '重启后设置页 UI 回显新值',
    settingsUiText.includes('1.5') && settingsUiText.includes('并发'),
    '',
  )
  await screenshot(restarted, 'settings-after-restart')

  // 还原设置（通过真实命令，保持环境干净）
  try {
    const restore = { ...afterRestart, downloadDir: original.downloadDir, concurrency: original.concurrency, bandwidthLimit: original.bandwidthLimit }
    await restarted.tauriInvoke('save_settings', { settings: restore })
    await sleep(500)
    const restored = await getSettings(restarted)
    results.record('设置已还原（save_settings）', restored.downloadDir === original.downloadDir, `downloadDir=${restored.downloadDir}`)
  } catch (error) {
    console.warn(`还原设置失败：${error.message}`)
  }
  return restarted
}

/* ------------------------------------------------------------------ */
/* 安全用例                                                            */
/* ------------------------------------------------------------------ */

function listTree(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return []
  const entries = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    let stat = null
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) entries.push(...listTree(path, depth + 1))
    else entries.push(path)
  }
  return entries
}

async function runSecurityChecks(client) {
  console.log('\n──────── 安全用例检查 ────────')
  mkdirSync(TMP_DOWNLOAD_DIR, { recursive: true })
  const filesBefore = listTree(TMP_DOWNLOAD_DIR)
  const escapeProbes = [
    join(process.env.LOCALAPPDATA || '.', 'Temp', 'evil-from-mdm.bin'),
    join(process.env.USERPROFILE || '.', 'evil-from-mdm.bin'),
    join(TMP_DOWNLOAD_DIR, '..', 'evil-from-mdm.bin'),
  ].map((path) => resolve(path))
  for (const probe of escapeProbes) rmSync(probe, { force: true })

  const baseRequest = {
    source: 'modelscope',
    repoId: 'Qwen/Qwen2.5-0.5B-Instruct',
    remotePath: 'config.json',
    size: 659,
    saveDir: TMP_DOWNLOAD_DIR,
  }
  const maliciousCases = [
    ['repoId 上级目录穿越 ../../etc', { ...baseRequest, repoId: '../../etc' }],
    ['repoId 反斜杠穿越 ..\\..\\etc', { ...baseRequest, repoId: '..\\..\\etc' }],
    ['remotePath 上级目录穿越 ../../../evil.bin', { ...baseRequest, remotePath: '../../../evil-from-mdm.bin' }],
    ['remotePath 反斜杠穿越 ..\\..\\evil.bin', { ...baseRequest, remotePath: '..\\..\\evil-from-mdm.bin' }],
    ['remotePath 绝对路径 C:\\Windows\\Temp\\evil.bin', { ...baseRequest, remotePath: 'C:\\Windows\\Temp\\evil-from-mdm.bin' }],
    ['remotePath UNC 路径', { ...baseRequest, remotePath: '\\\\server\\share\\evil-from-mdm.bin' }],
    ['remotePath 以分隔符开头 /evil.bin', { ...baseRequest, remotePath: '/evil-from-mdm.bin' }],
  ]
  for (const [label, request] of maliciousCases) {
    // 包裹成 resolve 对象，避免 CDP 把 reject 统一成 "Uncaught (in promise)" 而丢失后端中文错误。
    const outcome = await client.evaluate(`window.__TAURI_INTERNALS__.invoke('start_downloads', { requests: ${JSON.stringify([request])} })
      .then((response) => ({ ok: true, response }))
      .catch((error) => ({ ok: false, error: String(error) }))`)
    const accepted = Boolean(outcome?.ok) && Array.isArray(outcome?.response) && outcome.response.length > 0
    const errorText = String(outcome?.error || '')
    const rejected = !accepted
    const chineseHint = /[\u4e00-\u9fa5]/.test(errorText)
    results.record(`安全：拒绝 ${label}`, rejected, rejected ? `后端错误：${errorText.slice(0, 220)}` : '请求被接受（疑似路径穿越缺陷）')
    if (rejected) results.record(`安全：${label} 错误信息中文可读`, chineseHint, errorText.slice(0, 140))
  }

  // 清理可能产生的任务记录与文件
  try {
    await client.tauriInvoke('clear_finished')
  } catch {
    /* ignore */
  }

  const filesAfter = listTree(TMP_DOWNLOAD_DIR)
  const created = filesAfter.filter((path) => !filesBefore.includes(path))
  results.record(
    '安全：路径穿越未在临时目录产生文件',
    created.length === 0,
    created.length === 0 ? '无新增文件' : created.join(', '),
  )
  const escaped = escapeProbes.filter((path) => existsSync(path))
  results.record('安全：路径穿越未逃逸到临时目录之外', escaped.length === 0, escaped.join(', ') || '无逃逸文件')

  // Token 不泄漏
  const TOKEN = 'hf_QASECRETTOKEN1234567890'
  try {
    const current = await client.tauriInvoke('get_settings')
    await client.tauriInvoke('save_settings', { settings: { ...current, hfToken: TOKEN, msToken: TOKEN } })
    const before = client.consoleMessages.length
    const connectionOutcome = await client.evaluate(`window.__TAURI_INTERNALS__.invoke('test_connection', { source: 'huggingface' })
      .then((text) => ({ ok: true, text: String(text) }))
      .catch((error) => ({ ok: false, text: String(error) }))`)
    const connectionText = String(connectionOutcome?.text || '')
    await sleep(500)
    const pageText = await client.bodyText(20000)
    const newConsole = client.consoleMessages.slice(before).map((item) => item.text).join('\n')
    const leakInUi = pageText.includes(TOKEN)
    const leakInConsole = newConsole.includes(TOKEN)
    const leakInError = connectionText.includes(TOKEN)
    results.record('安全：Token 不出现在 UI 文本/控制台/连接错误中', !leakInUi && !leakInConsole && !leakInError, `test_connection 返回：${connectionText.slice(0, 160)}`)
    // 还原 token
    const restored = await client.tauriInvoke('get_settings')
    await client.tauriInvoke('save_settings', { settings: { ...restored, hfToken: '', msToken: '' } })
  } catch (error) {
    results.record('安全：Token 不泄漏检查', false, String(error.message || error).slice(0, 300))
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  mkdirSync(TMP_DOWNLOAD_DIR, { recursive: true })
  mkdirSync(APP_DATA_DIR, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  results.record('应用 exe 存在', existsSync(EXE), EXE)
  if (!existsSync(EXE)) {
    const summary = results.summary('真实应用 UI/持久化/安全验收（缺少前置构建）')
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, exe: EXE }, null, 2), 'utf8')
    process.exitCode = 1
    return
  }

  backupAppData()
  try {
    const target = await launchApp()
    state.client = await connectApp(target)
    results.record('应用以真实模式启动（非 mock）', !(await state.client.evaluate('document.body.innerText.includes("Mock 数据模式")')), '')

    if (CHECKS.has('pages')) {
      await runPageChecks(state.client)
    }
    if (CHECKS.has('security')) {
      await runSecurityChecks(state.client)
    }
    if (CHECKS.has('settings')) {
      state.client = await runSettingsChecks(state.client)
    }

    state.consoleErrors = state.client.consoleErrors.slice()
    state.pageErrors = state.client.pageErrors.slice()
    results.record('全流程无未捕获页面异常', state.pageErrors.length === 0, `${state.pageErrors.length} 个`)
    const ignored = (item) =>
      /favicon/i.test(item.text) || /Failed to load resource: the server responded with a status of 404/.test(item.text) || /DevTools/.test(item.text)
    const realErrors = state.consoleErrors.filter((item) => !ignored(item))
    results.record('全流程无控制台错误', realErrors.length === 0, realErrors.map((e) => e.text).join(' | ').slice(0, 800))
  } finally {
    if (state.client) await state.client.close().catch(() => {})
    killAppProcesses()
    try {
      rmSync(TMP_DOWNLOAD_DIR, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    restoreAppData()
    console.log('已还原应用数据（settings.json / tasks.json）')
  }

  const summary = results.summary('真实应用 UI/持久化/安全验收')
  writeFileSync(
    RESULT_JSON,
    JSON.stringify(
      {
        stamp: STAMP,
        exe: EXE,
        evidenceDir: EVIDENCE_DIR,
        checks: [...CHECKS],
        summary,
        screenshots: state.screenshots,
        consoleErrors: state.consoleErrors,
        pageErrors: state.pageErrors,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`结果 JSON：${RESULT_JSON}`)
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`\n验收失败：${error.message || error}`)
  results.record('UI/持久化/安全主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('真实应用 UI/持久化/安全验收（异常终止）')
  try {
    writeFileSync(
      RESULT_JSON,
      JSON.stringify({ stamp: STAMP, exe: EXE, evidenceDir: EVIDENCE_DIR, summary, fatalError: String(error.stack || error) }, null, 2),
      'utf8',
    )
  } catch {
    /* ignore */
  }
  if (state.client) state.client.close().catch(() => {})
  killAppProcesses()
  restoreAppData()
  process.exitCode = 1
})
