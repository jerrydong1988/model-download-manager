#!/usr/bin/env node
/**
 * tests/e2e/download-e2e.mjs — 「模型下载管理器」真实端到端下载验收（WebView2 + Tauri 后端）
 *
 * 前置条件（Phase B 构建完成后）：
 *   1. `npm run build` 已生成 dist/（Tauri 编译期嵌入前端资源）；
 *   2. `cd src-tauri && cargo build` 已生成 src-tauri/target/debug/model-download-manager.exe；
 *   3. WebView2 运行时已安装（Win10/11 自带）。
 *
 * 做什么：
 *   - 用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port> 启动真实 debug exe；
 *   - 通过 CDP 驱动真实 UI（设置页 → 浏览仓库 → 仓库详情 → 勾选文件 → 开始下载 → 下载队列），
 *     并用真实 IPC `get_snapshot` 做结构化轮询；
 *   - 下载完成后校验磁盘文件大小、与 curl 独立下载对照 sha256；
 *   - 再测「限速下载 → 暂停 → 继续 → 完成」，校验 part 文件与最终 sha256；
 *   - 输出 PASS/FAIL 摘要、证据截图与 JSON 结果，失败时退出码非 0。
 *
 * 用法：
 *   node tests/e2e/download-e2e.mjs [选项]
 * 选项：
 *   --exe <path>       应用 exe 路径（默认 src-tauri/target/debug/model-download-manager.exe）
 *   --port <n>         WebView2 远程调试端口（默认 9223）
 *   --only <id>        只跑某个用例：hf | ms | ms-resume（默认全跑）
 *   --keep             保留临时下载目录（默认结束后清理）
 *   --keep-app         结束后不关闭应用（调试用）
 *   --skip-reference   跳过 curl 对照下载（无网络时仅校验任务/文件大小）
 *   -h, --help         显示帮助
 *
 * 写域说明：本脚本只读应用源码；运行期写入 .temp/qa/、系统临时下载目录，并临时备份/恢复
 * %APPDATA%\com.modeldownload.manager 下的 settings.json / tasks.json，结束后还原。
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

import {
  connect,
  createResults,
  PORT_WEBVIEW2,
  sha256File,
  sleep,
  waitForEndpoint,
  listTargets,
} from './cdp.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(SCRIPT_DIR, '..', '..')

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      if (token === '-h') options.help = true
      continue
    }
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

if (options.help) {
  const doc = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const match = doc.match(/\/\*\*([\s\S]*?)\*\//)
  console.log(match ? match[1].replace(/^ \* ?/gm, '').trim() : '见文件头注释')
  process.exit(0)
}

const PORT = Number(options.port || PORT_WEBVIEW2)
const EXE = resolve(options.exe || join(ROOT, 'src-tauri', 'target', 'debug', 'model-download-manager.exe'))
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `download-e2e-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'download-e2e-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const BACKUP_DIR = join(EVIDENCE_DIR, 'appdata-backup')
const TEMP_ROOT = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'Temp', 'mdm-qa')
const DOWNLOAD_DIR = join(TEMP_ROOT, STAMP)

const results = createResults()
const state = {
  proc: null,
  client: null,
  backupFiles: [],
  startedAt: Date.now(),
  cases: [],
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
}

/* ------------------------------------------------------------------ */
/* 用例定义                                                             */
/* ------------------------------------------------------------------ */

const ALL_CASES = [
  {
    id: 'hf',
    label: 'HuggingFace（hf-mirror 默认端点）小文件下载',
    source: 'huggingface',
    repoId: 'hf-internal-testing/tiny-random-gpt2',
    file: 'pytorch_model.bin',
    expectedSize: 3561811,
    kind: 'smoke',
    checkLibrary: true,
  },
  {
    id: 'ms',
    label: 'ModelScope 小文件下载',
    source: 'modelscope',
    repoId: 'Qwen/Qwen2.5-0.5B-Instruct',
    file: 'config.json',
    expectedSize: 659,
    kind: 'smoke',
    checkLibrary: false,
  },
  {
    id: 'ms-resume',
    label: 'ModelScope 暂停→继续断点续传（约 6.7MB，限速 0.5MB/s）',
    source: 'modelscope',
    repoId: 'Qwen/Qwen2.5-0.5B-Instruct',
    file: 'tokenizer.json',
    expectedSize: 7031645,
    kind: 'resume',
    bandwidthMbps: 0.5,
  },
]

const selectedCases = ALL_CASES.filter(
  (item) => !options.only || String(options.only).split(',').includes(item.id),
)
if (selectedCases.length === 0) {
  console.error(`未知的 --only 参数：${options.only}；可选值：${ALL_CASES.map((c) => c.id).join(', ')}`)
  process.exit(2)
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function logStep(title) {
  console.log(`\n──────── ${title} ────────`)
}

function screenshot(client, name) {
  const path = join(EVIDENCE_DIR, 'shots', `${name}.png`)
  return client
    .screenshot(path)
    .then((info) => {
      state.screenshots.push(info.path)
      return info.path
    })
    .catch((error) => {
      console.warn(`截图失败（${name}）：${error.message}`)
      return null
    })
}

function fileInfo(path) {
  if (!existsSync(path)) return null
  const stat = statSync(path)
  return { size: stat.size, mtimeMs: stat.mtimeMs }
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
  // 任务列表清空，保证本次验收从干净状态开始（settings.json 保留，UI 会覆盖）。
  rmSync(join(APP_DATA_DIR, 'tasks.json'), { force: true })
}

function restoreAppData() {
  try {
    if (!existsSync(APP_DATA_DIR)) return
    for (const name of ['settings.json', 'tasks.json']) {
      const target = join(APP_DATA_DIR, name)
      const backup = join(BACKUP_DIR, name)
      if (state.backupFiles.includes(name)) {
        copyFileSync(backup, target)
      } else {
        rmSync(target, { force: true })
      }
    }
  } catch (error) {
    console.warn(`恢复应用数据失败（请手动检查 ${APP_DATA_DIR}）：${error.message}`)
  }
}

function killExistingApp() {
  const query = `Get-Process -Name 'model-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8',
    timeout: 15000,
  })
  const pids = (result.stdout || '')
    .split(/\s+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
  for (const pid of pids) {
    try {
      spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { timeout: 10000 })
      console.log(`已结束残留应用进程 PID=${pid}`)
    } catch {
      /* ignore */
    }
  }
  return pids
}

/** 启动真实 debug exe，并等待 9223 上的 DevTools 端点。 */
async function launchApp() {
  if (!existsSync(EXE)) {
    throw new Error(
      `应用 exe 不存在：${EXE}\n请先执行 npm run build && cd src-tauri && cargo build（debug）后再运行本脚本。`,
    )
  }
  killExistingApp()
  // 等待上一个 WebView2 实例释放 9223 端口（进程被杀后子进程可能稍晚退出）。
  const portFreeDeadline = Date.now() + 10000
  while (Date.now() < portFreeDeadline) {
    try {
      await listTargets(PORT, 1000)
      await sleep(300)
    } catch {
      break
    }
  }
  await sleep(800)

  // 应用 stdout/stderr 落盘，便于失败诊断（Tauri release 通常无输出）。
  const appLogPath = join(EVIDENCE_DIR, 'app.log')
  const appLogFd = openSync(appLogPath, 'a')
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=*`,
    RUST_BACKTRACE: '1',
  }
  console.log(`启动应用：${EXE}`)
  console.log(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT} --remote-allow-origins=*`)
  state.proc = spawn(EXE, [], { env, stdio: ['ignore', appLogFd, appLogFd], windowsHide: false })
  state.appExitCode = null
  state.proc.on('exit', (code, signal) => {
    state.appExitCode = code
    console.log(`应用进程退出：code=${code} signal=${signal}`)
  })

  const appLogTail = () => {
    try {
      const text = readFileSync(appLogPath, 'utf8')
      return text.length > 3000 ? text.slice(-3000) : text
    } catch {
      return '(无 app.log)'
    }
  }

  const started = Date.now()
  await waitForEndpoint(PORT, {
    timeoutMs: 60000,
    label: 'WebView2 DevTools',
  })

  // WebView2 启动初期可能只有 about:blank，需轮询等待应用页面 target。
  let targets = []
  let appTarget = null
  const appTargetDeadline = Date.now() + 45000
  while (Date.now() < appTargetDeadline) {
    targets = await listTargets(PORT).catch(() => [])
    appTarget = targets.find((target) => /tauri\.localhost|tauri:\/\/|localhost:1420/.test(target.url || ''))
    if (appTarget) break
    if (state.appExitCode !== null) {
      throw new Error(
        `应用启动后退出（exit code=${state.appExitCode}），未创建应用页面 target。\n当前 targets=${JSON.stringify(targets.map((t) => `${t.type}:${t.url}`))}\napp.log 尾部：\n${appLogTail()}`,
      )
    }
    await sleep(300)
  }
  let browserLabel = 'unknown'
  try {
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
    browserLabel = version.Browser
  } catch {
    /* ignore */
  }
  console.log(
    `WebView2 DevTools 上线：${browserLabel}（${Date.now() - started}ms），targets=${targets.length}，应用 target=${appTarget ? appTarget.url : '(未找到)'}`,
  )
  if (!appTarget) {
    throw new Error(
      `未找到应用页面 target；当前 targets=${JSON.stringify(targets.map((t) => `${t.type}:${t.url}`))}\napp.log 尾部：\n${appLogTail()}`,
    )
  }
  return appTarget
}

async function connectApp(appTarget) {
  const client = await connect(PORT, (target) => target.id === appTarget.id, { timeoutMs: 30000 })
  await client.startCapture()
  await client.waitFor('document.readyState === "complete"', { timeoutMs: 30000, description: '页面加载完成' })
  // 等待 App 快照加载完成（侧边栏显示真实下载目录/存储状态）。
  await client.waitFor(
    'Boolean(window.__TAURI_INTERNALS__) && document.body.innerText.includes("模型下载管理器")',
    { timeoutMs: 30000, description: 'Tauri 应用 shell 就绪' },
  )
  await waitForSnapshot(client, (snapshot) => Boolean(snapshot?.settings?.downloadDir), { timeoutMs: 30000 })
  const isMock = await client.evaluate('document.body.innerText.includes("Mock 数据模式")')
  results.record('应用以真实模式启动（非 mock）', !isMock, isMock ? '检测到 Mock 数据模式' : '真实 IPC')
  const snapshot = await client.tauriInvoke('get_snapshot')
  results.record('get_snapshot 命令可用', Boolean(snapshot?.tasks), `appVersion=${snapshot?.appVersion} dataDir=${snapshot?.dataDir}`)
  return client
}

async function getSnapshot(client) {
  return client.tauriInvoke('get_snapshot')
}

async function waitForSnapshot(client, predicate, { timeoutMs = 30000, intervalMs = 250, description = '快照条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      last = await getSnapshot(client)
      if (predicate(last)) return last
    } catch (error) {
      lastError = String(error.message || error)
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待 ${description} 超时（${timeoutMs}ms）${lastError ? `；最后错误：${lastError}` : ''}；最后快照=${JSON.stringify(last)?.slice(0, 600)}`)
}

async function waitForTask(client, taskId, statuses, { timeoutMs = 300000, description = String(statuses) } = {}) {
  const wanted = new Set(Array.isArray(statuses) ? statuses : [statuses])
  let matched = null
  await waitForSnapshot(
    client,
    (snapshot) => {
      const task = (snapshot.tasks || []).find((item) => item.taskId === taskId)
      if (task && wanted.has(task.status)) {
        matched = task
        return true
      }
      return false
    },
    { timeoutMs, description: `任务 ${taskId.slice(0, 8)}… 进入 ${description}` },
  )
  return matched
}

async function findTask(client, predicate, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await getSnapshot(client)
    const task = (snapshot.tasks || []).find(predicate)
    if (task) return task
    await sleep(250)
  }
  return null
}

function clickSidebar(client, label) {
  return client.clickByText(label, 'aside nav button, aside button')
}

/* ------------------------------------------------------------------ */
/* 页面操作                                                            */
/* ------------------------------------------------------------------ */

async function ensureSettings(client, { downloadDir, bandwidthMbps } = {}) {
  await clickSidebar(client, '设置')
  await client.waitFor('Boolean(document.querySelector("#settings-download-dir"))', {
    timeoutMs: 20000,
    description: '设置页渲染',
  })
  if (downloadDir) {
    await client.type('#settings-download-dir', downloadDir)
  }
  if (bandwidthMbps !== undefined) {
    await client.type('#settings-bandwidth', String(bandwidthMbps))
  }
  await client.clickByText('保存设置')
  const expectedBandwidth =
    bandwidthMbps === undefined ? null : Math.round(Number(bandwidthMbps) <= 0 ? 0 : Number(bandwidthMbps) * 1024 * 1024)
  const snapshot = await waitForSnapshot(
    client,
    (snap) =>
      (!downloadDir || snap.settings.downloadDir === downloadDir) &&
      (expectedBandwidth === null || Math.abs(Number(snap.settings.bandwidthLimit) - expectedBandwidth) <= 1),
    { timeoutMs: 20000, description: '设置保存生效' },
  )
  results.record(
    '设置页保存生效（真实 save_settings）',
    true,
    `downloadDir=${snapshot.settings.downloadDir} bandwidth=${snapshot.settings.bandwidthLimit}`,
  )
  return snapshot.settings
}

async function currentOriginPath(client) {
  return client.evaluate('location.origin + location.pathname')
}

async function openRepoDetail(client, testCase, downloadDir) {
  const base = await currentOriginPath(client)
  const query = `?repo=${encodeURIComponent(testCase.repoId)}&source=${testCase.source}`
  await client.navigate(`${base}${query}`)
  await client.waitFor(
    `document.body.innerText.includes(${JSON.stringify(testCase.repoId)})`,
    { timeoutMs: 45000, description: `仓库详情加载：${testCase.repoId}` },
  )
  await client.waitFor(`document.querySelectorAll('input[aria-label^="选择 "]').length > 0`, {
    timeoutMs: 45000,
    description: '文件列表渲染',
  })
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(downloadDir)})`, {
    timeoutMs: 20000,
    description: '下载目录默认为设置目录',
  })
  await screenshot(client, `repo-detail-${testCase.id}`)
  return client.tauriInvoke('get_repo_detail', {
    source: testCase.source,
    repoId: testCase.repoId,
  })
}

/** 文件行可能因窗口化渲染不在可视区，滚动文件列表到目标行。 */
async function scrollFileIntoView(client, filePath) {
  const selector = `input[aria-label=${JSON.stringify(`选择 ${filePath}`)}]`
  if (await client.exists(selector)) return true
  const index = await client.evaluate(`(() => {
    const target = ${JSON.stringify(filePath)};
    const rows = [...document.querySelectorAll('input[aria-label^="选择 "]')];
    // 已渲染的可见行里找不到时，用文件总数与滚动位置保守滚动。
    const region = document.querySelector('[role="region"][aria-label="仓库文件列表"]');
    return region ? { scrollHeight: region.scrollHeight, rowCount: rows.length } : null;
  })()`)
  const rowHeight = 44
  const region = '[role="region"][aria-label="仓库文件列表"]'
  for (let position = 0; position < Math.max(1, Math.ceil(((index?.scrollHeight || 640) / rowHeight) / 10)); position += 1) {
    await client.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(region)});
      if (el) { el.scrollTop = ${position} * ${rowHeight * 10}; el.dispatchEvent(new Event('scroll', { bubbles: true })); }
      return true;
    })()`)
    await sleep(200)
    if (await client.exists(selector)) return true
  }
  return false
}

/** 勾选指定文件（先清空默认选择，再精确勾选 1 个）。 */
async function selectOnlyFile(client, filePath) {
  await client.clickByText('清空选择')
  await sleep(200)
  const rendered = await scrollFileIntoView(client, filePath)
  if (!rendered) throw new Error(`文件行未找到：${filePath}`)
  const selector = `input[aria-label=${JSON.stringify(`选择 ${filePath}`)}]`
  const checked = await client.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (!el.checked) el.click();
    return el.checked;
  })()`)
  if (!checked) throw new Error(`勾选文件失败：${filePath}`)
  await client.waitFor('document.body.innerText.includes("已选 1 个文件")', {
    timeoutMs: 10000,
    description: '选中合计显示 1 个文件',
  })
  const totalText = await client.evaluate(`(() => {
    const text = document.body.innerText;
    const match = text.match(/已选\\s*1\\s*个文件 · 合计\\s*([^\\n]+)/);
    return match ? match[1].trim() : '';
  })()`)
  return totalText
}

async function startDownload(client, testCase) {
  await client.clickByText('开始下载')
  const task = await findTask(
    client,
    (item) =>
      item.repoId === testCase.repoId &&
      item.remotePath === testCase.file &&
      item.source === testCase.source &&
      !['cancelled'].includes(item.status),
    { timeoutMs: 30000 },
  )
  if (!task) throw new Error('开始下载后未在快照中找到对应任务')
  results.record(
    `创建下载任务：${testCase.id}`,
    true,
    `taskId=${task.taskId} status=${task.status} savePath=${task.savePath}`,
  )
  return task
}

async function goDownloadsAndWaitRow(client, fileName) {
  await clickSidebar(client, '下载队列')
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(fileName)})`, {
    timeoutMs: 30000,
    description: `下载队列出现 ${fileName}`,
  })
}

async function pauseViaUi(client, task) {
  const label = `暂停下载：${task.fileName}`
  await client.waitFor(`Boolean(document.querySelector('button[aria-label=${JSON.stringify(label)}]'))`, {
    timeoutMs: 60000,
    description: '暂停按钮可用',
  })
  await client.evaluate(`(() => {
    const btn = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (btn) { btn.click(); return true; }
    return false;
  })()`)
}

async function resumeViaUi(client, task) {
  const label = `继续下载：${task.fileName}`
  await client.waitFor(`Boolean(document.querySelector('button[aria-label=${JSON.stringify(label)}]'))`, {
    timeoutMs: 60000,
    description: '继续按钮可用',
  })
  await client.evaluate(`(() => {
    const btn = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (btn) { btn.click(); return true; }
    return false;
  })()`)
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function resolveDownloadUrl(settings, testCase, revision) {
  if (testCase.source === 'huggingface') {
    const endpoint = String(settings.hfEndpoint || 'https://hf-mirror.com').replace(/\/$/, '')
    return `${endpoint}/${testCase.repoId}/resolve/${revision || 'main'}/${testCase.file}`
  }
  const endpoint = String(settings.msEndpoint || 'https://www.modelscope.cn').replace(/\/$/, '')
  return `${endpoint}/models/${testCase.repoId}/resolve/${revision || 'master'}/${testCase.file}`
}

function curlDownload(url, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  const started = Date.now()
  const result = spawnSync(
    'curl.exe',
    ['-sS', '-L', '--fail', '--max-time', '180', '--retry', '2', '-o', destination, url],
    { encoding: 'utf8', timeout: 200000 },
  )
  if (result.error) return { ok: false, error: String(result.error.message || result.error) }
  if (result.status !== 0) {
    return { ok: false, error: `curl exit=${result.status} stderr=${(result.stderr || '').trim().slice(0, 300)}` }
  }
  const info = fileInfo(destination)
  return { ok: true, size: info?.size ?? 0, ms: Date.now() - started }
}

async function verifyCompletedTask(client, testCase, task, settings, revision, { checkReference = true } = {}) {
  const prefix = `[${testCase.id}]`
  // 1) 任务字段
  const sizeOk = Number(task.downloaded) === Number(task.totalSize) && Number(task.totalSize) > 0
  const expectedOk = Number(task.totalSize) === testCase.expectedSize
  results.record(`${prefix} 任务 downloaded==totalSize`, sizeOk, `${task.downloaded}/${task.totalSize}`)
  results.record(`${prefix} totalSize 与仓库列表一致`, expectedOk, `期望 ${testCase.expectedSize}`)
  results.record(
    `${prefix} 任务在 addedAt 之后完成`,
    Number(task.completedAt) >= Number(task.addedAt) && Number(task.completedAt) > 0,
    `addedAt=${task.addedAt} completedAt=${task.completedAt}`,
  )
  results.record(`${prefix} savePath/tempPath 契约`, Boolean(task.savePath) && task.savePath.endsWith(task.fileName), task.savePath)

  // 2) 磁盘文件
  const info = fileInfo(task.savePath)
  results.record(`${prefix} 磁盘文件存在`, Boolean(info), task.savePath)
  if (!info) return { sha: null }
  results.record(`${prefix} 磁盘大小 == totalSize`, info.size === Number(task.totalSize), `${info.size} bytes`)
  results.record(`${prefix} 临时文件 .part 已清理`, !existsSync(`${task.savePath}.part`), `${task.savePath}.part`)
  results.record(`${prefix} 元数据 .part.json 已清理`, !existsSync(`${task.savePath}.part.json`), `${task.savePath}.part.json`)

  const actualSha = sha256File(task.savePath)
  let referenceSha = null
  if (checkReference && !options['skip-reference']) {
    const url = resolveDownloadUrl(settings, testCase, revision)
    const refPath = join(EVIDENCE_DIR, 'reference', `${testCase.id}-${testCase.file}`)
    const ref = curlDownload(url, refPath)
    if (!ref.ok) {
      results.record(`${prefix} curl 独立对照下载`, false, ref.error)
    } else {
      referenceSha = sha256File(refPath)
      results.record(`${prefix} curl 独立对照下载`, true, `${ref.size} bytes, ${ref.ms}ms, ${url}`)
      results.record(`${prefix} sha256 与独立下载一致`, actualSha === referenceSha, `app=${actualSha}`)
    }
  } else {
    console.log(`[${testCase.id}] 跳过 curl 对照（--skip-reference）`)
  }
  return { sha: actualSha, referenceSha }
}

/* ------------------------------------------------------------------ */
/* 用例执行                                                            */
/* ------------------------------------------------------------------ */

async function runSmokeCase(client, testCase, settings) {
  logStep(`${testCase.label}（${testCase.id}）`)
  const detail = await openRepoDetail(client, testCase, DOWNLOAD_DIR)
  const repoFile = (detail.files || []).find((file) => file.path === testCase.file)
  results.record(
    `[${testCase.id}] get_repo_detail 返回目标文件`,
    Boolean(repoFile) && Number(repoFile.size) === testCase.expectedSize,
    repoFile ? `${repoFile.path} ${repoFile.size} bytes kind=${repoFile.kind} revision=${detail.revision}` : '未找到',
  )
  const selectionText = await selectOnlyFile(client, testCase.file)
  results.record(`[${testCase.id}] 勾选目标文件（选中合计）`, Boolean(selectionText), selectionText)
  await screenshot(client, `selected-${testCase.id}`)

  let task = await startDownload(client, testCase)
  if (!['completed', 'active', 'queued', 'paused'].includes(task.status)) {
    results.record(`[${testCase.id}] 任务初始状态合法`, false, task.status)
  }
  await goDownloadsAndWaitRow(client, testCase.file)
  task = await waitForTask(client, task.taskId, 'completed')
  results.record(`[${testCase.id}] 任务状态到达 completed`, task.status === 'completed', `用时 ${Math.round((Date.now() - state.startedAt) / 1000)}s（脚本总耗时）`)

  // UI 状态徽章
  const rowText = await client.evaluate(`document.body.innerText.includes(${JSON.stringify(testCase.file)}) && document.body.innerText.includes("已完成")`)
  results.record(`[${testCase.id}] 下载队列 UI 显示已完成`, Boolean(rowText), '')
  await screenshot(client, `downloads-completed-${testCase.id}`)

  const hashes = await verifyCompletedTask(client, testCase, task, settings, detail.revision)

  if (testCase.checkLibrary) {
    await clickSidebar(client, '本地模型库')
    await client.waitFor('document.querySelector("h1") && document.querySelector("h1").innerText.trim() === "本地模型库"', { timeoutMs: 20000, description: '本地模型库页面' })
    // v0.2.0 多根树默认只展开「根 + 第一层」，深层文件不在 DOM；用真实 scan_library 轮询校验。
    let localFile = null
    const scanDeadline = Date.now() + 40000
    while (Date.now() < scanDeadline) {
      const localFiles = await client.tauriInvoke('scan_library')
      localFile = (localFiles || []).find((file) => file.path.endsWith(testCase.file) && Number(file.size) === testCase.expectedSize)
      if (localFile) break
      await sleep(500)
    }
    results.record(`[${testCase.id}] 本地模型库列出已下载文件`, Boolean(localFile), localFile ? `${localFile.path}（${localFile.kind}，rootDir=${localFile.rootDir}）` : `未在 scan_library 中找到 ${testCase.file}`)
    await screenshot(client, `library-${testCase.id}`)
  }

  state.cases.push({
    id: testCase.id,
    kind: 'smoke',
    taskId: task.taskId,
    savePath: task.savePath,
    size: task.totalSize,
    sha256: hashes.sha,
    referenceSha256: hashes.referenceSha,
    status: task.status,
  })
  return true
}

async function runResumeCase(client, testCase) {
  logStep(`${testCase.label}（${testCase.id}）`)
  // 1) 限速设置（保证能稳定在中途暂停）
  let settings = await ensureSettings(client, { bandwidthMbps: testCase.bandwidthMbps })
  const detail = await openRepoDetail(client, testCase, DOWNLOAD_DIR)
  const repoFile = (detail.files || []).find((file) => file.path === testCase.file)
  results.record(
    `[${testCase.id}] get_repo_detail 返回目标文件`,
    Boolean(repoFile) && Number(repoFile.size) === testCase.expectedSize,
    repoFile ? `${repoFile.path} ${repoFile.size} bytes kind=${repoFile.kind}` : '未找到',
  )
  await selectOnlyFile(client, testCase.file)
  let task = await startDownload(client, testCase)
  await goDownloadsAndWaitRow(client, testCase.file)

  // 2) 等到已下载 ≥ 20% 且 ≥ 512KB
  const targetPause = Math.max(Math.floor(testCase.expectedSize * 0.2), 512 * 1024)
  const pausedBase = await waitForSnapshot(
    client,
    (snapshot) => {
      const current = (snapshot.tasks || []).find((item) => item.taskId === task.taskId)
      if (!current) return false
      return current.downloaded >= targetPause || current.status === 'completed'
    },
    { timeoutMs: 120000, description: `下载进度达到 ${targetPause} bytes` },
  )
  const progressTask = (pausedBase.tasks || []).find((item) => item.taskId === task.taskId)
  results.record(
    `[${testCase.id}] 下载中途已产生进度`,
    progressTask.status === 'active' || progressTask.status === 'pausing',
    `status=${progressTask.status} downloaded=${progressTask.downloaded}/${progressTask.totalSize}`,
  )
  if (progressTask.status === 'completed') {
    results.record(`[${testCase.id}] 限速生效（未在暂停前完成）`, false, '限速 0.5MB/s 下仍瞬间完成，无法测试暂停')
    return false
  }

  // 3) 暂停（UI 按钮）
  await pauseViaUi(client, progressTask)
  const paused = await waitForTask(client, task.taskId, ['paused'], { timeoutMs: 90000, description: 'paused' })
  const partPath = paused.tempPath || `${paused.savePath}.part`
  let partInfo = fileInfo(partPath)
  if (!partInfo) {
    await sleep(1000)
    partInfo = fileInfo(partPath)
  }
  results.record(`[${testCase.id}] 暂停成功（状态 paused）`, paused.status === 'paused', `downloaded=${paused.downloaded}`)
  results.record(`[${testCase.id}] .part 临时文件保留`, Boolean(partInfo) && partInfo.size > 0, partInfo ? `${partPath} (${partInfo.size} bytes)` : '缺失')
  results.record(
    `[${testCase.id}] .part 大小与已下载字节一致`,
    Boolean(partInfo) && Math.abs(partInfo.size - Number(paused.downloaded)) <= 64 * 1024,
    partInfo ? `part=${partInfo.size} downloaded=${paused.downloaded}` : '缺失',
  )
  await screenshot(client, `paused-${testCase.id}`)

  // 4) 继续（UI 按钮）
  await resumeViaUi(client, paused)
  const resumed = await waitForTask(client, task.taskId, ['active', 'queued', 'completed'], {
    timeoutMs: 60000,
    description: '恢复下载',
  })
  results.record(`[${testCase.id}] 继续后重新进入下载态`, ['active', 'completed'].includes(resumed.status), `status=${resumed.status}`)
  const completed = await waitForTask(client, task.taskId, 'completed', { timeoutMs: 300000 })
  results.record(`[${testCase.id}] 续传后任务完成`, completed.status === 'completed', `downloaded=${completed.downloaded}`)

  // 5) 文件完整性校验（与 curl 对照）
  const finalInfo = fileInfo(completed.savePath)
  results.record(
    `[${testCase.id}] 续传后文件大小正确`,
    Boolean(finalInfo) && finalInfo.size === testCase.expectedSize,
    finalInfo ? `${finalInfo.size} bytes` : '缺失',
  )
  results.record(`[${testCase.id}] 续传后 .part 已清理`, !existsSync(`${completed.savePath}.part`), '')
  await screenshot(client, `resume-completed-${testCase.id}`)
  const hashes = await verifyCompletedTask(client, testCase, completed, settings, detail.revision)

  // 6) 恢复不限速
  settings = await ensureSettings(client, { bandwidthMbps: 0 })
  results.record(`[${testCase.id}] 限速恢复为 0`, Number(settings.bandwidthLimit) === 0, `bandwidthLimit=${settings.bandwidthLimit}`)

  state.cases.push({
    id: testCase.id,
    kind: 'resume',
    taskId: completed.taskId,
    savePath: completed.savePath,
    size: completed.totalSize,
    sha256: hashes.sha,
    referenceSha256: hashes.referenceSha,
    pausedAtBytes: paused.downloaded,
    partBytes: partInfo?.size ?? 0,
    status: completed.status,
  })
  return true
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  console.log(`临时下载目录：${DOWNLOAD_DIR}`)
  console.log(`应用数据目录：${APP_DATA_DIR}`)
  console.log(`应用 exe：${EXE}`)
  results.record('应用 exe 存在', existsSync(EXE), EXE)
  if (!existsSync(EXE)) {
    const summary = results.summary('真实端到端下载验收（缺少前置构建）')
    writeFileSync(
      RESULT_JSON,
      JSON.stringify({ stamp: STAMP, exe: EXE, summary, fatalError: `缺少 debug exe：${EXE}` }, null, 2),
      'utf8',
    )
    process.exitCode = 1
    return
  }

  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  mkdirSync(APP_DATA_DIR, { recursive: true })
  backupAppData()
  let appTarget = null
  try {
    appTarget = await launchApp()
    state.client = await connectApp(appTarget)
    const settings = await state.client.tauriInvoke('get_settings')
    results.record('get_settings 命令可用', Boolean(settings?.downloadDir), `hfEndpoint=${settings?.hfEndpoint}`)

    // 先用 UI 设置下载目录（同时验证设置页真实保存链路）
    await ensureSettings(state.client, { downloadDir: DOWNLOAD_DIR })

    for (const testCase of selectedCases) {
      if (testCase.kind === 'smoke') await runSmokeCase(state.client, testCase, settings)
      else await runResumeCase(state.client, testCase)
    }

    // 控制台错误 / 页面异常
    state.consoleErrors = state.client.consoleErrors.slice()
    state.pageErrors = state.client.pageErrors.slice()
    results.record('运行期无未捕获页面异常（Runtime.exceptionThrown）', state.pageErrors.length === 0, `${state.pageErrors.length} 个`)
    const ignoredConsole = (item) =>
      /favicon/i.test(item.text) ||
      /Failed to load resource: the server responded with a status of 404/.test(item.text) ||
      /Download the React DevTools/.test(item.text)
    const realConsoleErrors = state.consoleErrors.filter((item) => !ignoredConsole(item))
    results.record(
      '运行期无控制台错误（过滤 favicon/DevTools 提示）',
      realConsoleErrors.length === 0,
      realConsoleErrors.length === 0 ? '' : realConsoleErrors.map((item) => item.text).join(' | ').slice(0, 500),
    )
  } finally {
    if (state.client) await state.client.close().catch(() => {})
    if (!options['keep-app']) {
      killExistingApp()
    }
    if (!options.keep) {
      try {
        rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
        console.log(`已清理临时下载目录：${DOWNLOAD_DIR}`)
      } catch (error) {
        console.warn(`清理临时下载目录失败：${error.message}`)
      }
    }
    restoreAppData()
    console.log(`已恢复应用数据（settings.json/tasks.json）`)
  }

  const summary = results.summary('真实端到端下载验收')
  const report = {
    stamp: STAMP,
    port: PORT,
    exe: EXE,
    downloadDir: DOWNLOAD_DIR,
    evidenceDir: EVIDENCE_DIR,
    durationMs: Date.now() - state.startedAt,
    summary,
    cases: state.cases,
    screenshots: state.screenshots,
    consoleErrors: state.consoleErrors,
    pageErrors: state.pageErrors,
  }
  writeFileSync(RESULT_JSON, JSON.stringify(report, null, 2), 'utf8')
  console.log(`结果 JSON：${RESULT_JSON}`)
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main().catch(async (error) => {
  console.error(`\nE2E 失败：${error.message || error}`)
  if (state.client) {
    try {
      await screenshot(state.client, 'failure-state')
    } catch {
      /* ignore */
    }
    try {
      state.pageErrors = state.client.pageErrors.slice()
      state.consoleErrors = state.client.consoleErrors.slice()
    } catch {
      /* ignore */
    }
  }
  results.record('E2E 主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('真实端到端下载验收（异常终止）')
  try {
    writeFileSync(
      RESULT_JSON,
      JSON.stringify(
        {
          stamp: STAMP,
          port: PORT,
          exe: EXE,
          downloadDir: DOWNLOAD_DIR,
          evidenceDir: EVIDENCE_DIR,
          durationMs: Date.now() - state.startedAt,
          summary,
          cases: state.cases,
          fatalError: String(error.stack || error),
          consoleErrors: state.consoleErrors,
          pageErrors: state.pageErrors,
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* ignore */
  }
  try {
    restoreAppData()
  } catch {
    /* ignore */
  }
  process.exitCode = 1
})
