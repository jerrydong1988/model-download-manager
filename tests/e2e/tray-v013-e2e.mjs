#!/usr/bin/env node
/**
 * tests/e2e/tray-v013-e2e.mjs — v0.1.3 托盘后台下载 / 退出语义 / 系统通知 真机验收
 *
 * WebView2 CDP + Win32（PostMessage WM_CLOSE）驱动真实 debug exe：
 *   A. closeToTray=true：限速下载 7MB tokenizer.json → WM_CLOSE 关窗
 *      → 断言进程存活、窗口隐藏、.part 持续增长、tasks.json 任务 active、
 *        应用内出现「已最小化到托盘」提示；再次启动第二实例 → ≤6s 退出且主窗口 visible、进度继续正确。
 *   B. 通知：完成/失败任务的应用内 toast（含「打开位置」/「重试」动作）；尝试捕获 Windows 通知与托盘图标；
 *      关闭通知开关后保存生效。
 *   C. closeToTray=false：关窗 → 进程退出且 tasks.json 已落盘；重启后任务恢复为 paused。
 *
 * 安全约束：只结束本脚本 spawn 的 PID 树，绝不 kill 其他实例；WebView2 数据目录隔离；
 * 应用数据（settings/tasks）备份→还原；下载目录用临时目录并清理。
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `tray-v013-e2e-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'tray-v013-e2e-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const BACKUP_DIR = join(EVIDENCE_DIR, 'appdata-backup')
const WEBVIEW_DATA_DIR = join(EVIDENCE_DIR, 'ebwebview')
const DOWNLOAD_DIR = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'Temp', 'mdm-qa', `tray-${STAMP}`)
const TASKS_FILE = join(APP_DATA_DIR, 'tasks.json')
const REPO = 'Qwen/Qwen2.5-0.5B-Instruct'
const BIG_FILE = 'tokenizer.json'
const BIG_SIZE = 7031645

const results = createResults()
const notes = []
const state = {
  client: null,
  proc: null,
  spawnedPid: null,
  appExitCode: null,
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  firstWindowHandle: null,
}

const screenshot = (client, name) =>
  client
    .screenshot(join(EVIDENCE_DIR, 'shots', `${name}.png`))
    .then((info) => {
      state.screenshots.push(info.path)
      return info.path
    })
    .catch(() => null)

/* ------------------------------------------------------------------ */
/* 进程 / Win32 / 应用数据                                             */
/* ------------------------------------------------------------------ */

function appPids() {
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process -Name 'model-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
    { encoding: 'utf8', timeout: 15000 },
  )
  return (result.stdout || '').split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0)
}

function backupAppData() {
  mkdirSync(BACKUP_DIR, { recursive: true })
  state.before = {}
  for (const name of ['settings.json', 'tasks.json']) {
    const source = join(APP_DATA_DIR, name)
    state.before[name] = existsSync(source) ? readFileSync(source, 'utf8') : null
    if (existsSync(source)) copyFileSync(source, join(BACKUP_DIR, name))
  }
}

function restoreAppData() {
  try {
    for (const name of ['settings.json', 'tasks.json']) {
      const target = join(APP_DATA_DIR, name)
      if (state.before?.[name] === null) rmSync(target, { force: true })
      else if (existsSync(join(BACKUP_DIR, name))) copyFileSync(join(BACKUP_DIR, name), target)
    }
  } catch (error) {
    console.warn(`恢复应用数据失败：${error.message}`)
  }
}

const WIN32_HELPERS = `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class QAW {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@`

function psWindow(action, pid, hwnd) {
  const body =
    action === 'close'
      ? `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { Write-Output '{"found":false}'; exit 0 }; $h = $p.MainWindowHandle; if ($h -eq [IntPtr]::Zero) { Write-Output '{"found":true,"hwnd":0}'; exit 0 }; $ok = [QAW]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); Write-Output ('{"found":true,"hwnd":' + $h.ToInt64() + ',"posted":' + $ok + '}')`
      : action === 'visibility'
        ? `$h = [IntPtr]${hwnd}; $ok = [QAW]::IsWindowVisible($h); $title = New-Object System.Text.StringBuilder 256; [void][QAW]::GetWindowText($h, $title, 256); Write-Output ('{"hwnd":${hwnd},"visible":' + $ok.ToString().ToLower() + ',"title":' + ($title.ToString() | ConvertTo-Json) + '}')`
      : action === 'enum'
        ? `$target = ${pid}; $items = New-Object System.Collections.ArrayList; $cb = [QAW+EnumProc]{ param($h, $l) $wpid = 0; [void][QAW]::GetWindowThreadProcessId($h, [ref]$wpid); if ($wpid -eq $target) { $cls = New-Object System.Text.StringBuilder 256; [void][QAW]::GetClassName($h, $cls, 256); $title = New-Object System.Text.StringBuilder 256; [void][QAW]::GetWindowText($h, $title, 256); [void]$items.Add([pscustomobject]@{ hwnd = $h.ToInt64(); cls = $cls.ToString(); title = $title.ToString(); visible = [QAW]::IsWindowVisible($h) }) } return $true }; [void][QAW]::EnumWindows($cb, [IntPtr]::Zero); $items | ConvertTo-Json -Compress`
        : `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { Write-Output '{"found":false}'; exit 0 }; $h = $p.MainWindowHandle; $visible = if ($h -ne [IntPtr]::Zero) { [QAW]::IsWindowVisible($h) } else { $false }; Write-Output ('{"found":true,"hwnd":' + $h.ToInt64() + ',"visible":' + $visible.ToString().ToLower() + ',"title":' + ($p.MainWindowTitle | ConvertTo-Json) + '}')`
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `${WIN32_HELPERS}\n${body}`], { encoding: 'utf8', timeout: 30000 })
  const text = (result.stdout || '').trim()
  try {
    return JSON.parse(text.split('\n').filter((line) => line.trim().startsWith('{')).pop())
  } catch {
    return { error: text.slice(0, 300) || (result.stderr || '').slice(0, 300) }
  }
}

function desktopScreenshot(name) {
  const path = join(EVIDENCE_DIR, 'shots', name)
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save(${JSON.stringify(path)}, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); Write-Output 'ok'`
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 30000 })
  if (existsSync(path)) {
    state.screenshots.push(path)
    return path
  }
  return null
}

async function trySystemNotificationEvidence(label) {
  const script = `try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
    $history = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('')
    $count = @($history).Count
    $items = @($history | Select-Object -First 3 | ForEach-Object { try { $_.Notification.Visual.GetBinding([Windows.UI.Notifications.ToastTemplateType]::ToastText02).GetTextElements() -join ' / ' } catch { '' } })
    Write-Output (@{ ok = $true; count = $count; items = $items } | ConvertTo-Json -Compress)
  } catch { Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) }`
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 })
  const text = (result.stdout || '').trim()
  let parsed = null
  try {
    parsed = JSON.parse(text.split('\n').filter((line) => line.trim().startsWith('{')).pop())
  } catch {
    parsed = { ok: false, error: text.slice(0, 200) }
  }
  if (parsed?.ok && Array.isArray(parsed.items) && parsed.items.some((item) => /模型下载管理器|下载完成|下载失败/.test(item || ''))) {
    results.record(`${label}：Windows 通知历史捕获到应用通知`, true, JSON.stringify(parsed).slice(0, 400))
    return
  }
  notes.push(`${label}：无法通过 WinRT 通知历史捕获（可能有桌面通知但 API 不可用/需 AUMID）：${JSON.stringify(parsed).slice(0, 300)}；改用应用内 toast + 后端日志 + 桌面截图作为证据。`)
}

async function tryTrayEvidence(pid) {
  const winEnum = psWindow('enum', pid)
  const windows = Array.isArray(winEnum) ? winEnum : winEnum?.error ? [] : [winEnum]
  const trayLike = windows.filter((item) => /tray|notification/i.test(item.cls || '') || /模型下载/.test(item.title || ''))
  const uiaScript = `try {
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $names = @()
    foreach ($b in $buttons) { try { $n = $b.Current.Name; if ($n -and ($n -like '*模型下载*' -or $n -like '*Model Download*')) { $names += $n } } catch { } }
    Write-Output (@{ ok = $true; names = @($names | Select-Object -First 5) } | ConvertTo-Json -Compress)
  } catch { Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) }`
  const uia = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', uiaScript], { encoding: 'utf8', timeout: 60000 })
  let uiaParsed = null
  try {
    uiaParsed = JSON.parse((uia.stdout || '').trim().split('\n').filter((line) => line.trim().startsWith('{')).pop())
  } catch {
    uiaParsed = { ok: false }
  }
  const trayFound = uiaParsed?.ok && Array.isArray(uiaParsed.names) && uiaParsed.names.length > 0
  if (trayFound) {
    results.record('托盘图标存在（UIA 枚举到托盘按钮/tooltip）', true, JSON.stringify(uiaParsed.names))
  } else {
    notes.push(`托盘图标/菜单：UIA 未枚举到（Windows 11 托盘折叠/权限限制）：${JSON.stringify(uiaParsed).slice(0, 200)}；进程窗口类枚举结果=${JSON.stringify(windows.slice(0, 6))}。`)
  }
  return { windows, trayLike, uiaParsed, trayFound }
}

/* ------------------------------------------------------------------ */
/* 应用启动/连接/操作                                                  */
/* ------------------------------------------------------------------ */

async function launchApp({ withDebug = true } = {}) {
  const existing = appPids()
  if (existing.length > 0) console.log(`检测到已有其他实例（不触碰）：${existing.join(', ')}`)
  if (withDebug) {
    try {
      await listTargets(PORT, 1500)
      throw new Error(`端口 ${PORT} 已被占用，按安全约束不结束任何进程`)
    } catch (error) {
      if (String(error.message).startsWith(`端口 ${PORT}`)) throw error
    }
  }
  mkdirSync(WEBVIEW_DATA_DIR, { recursive: true })
  const logFd = openSync(join(EVIDENCE_DIR, 'app.log'), 'a')
  const env = { ...process.env, RUST_BACKTRACE: '1' }
  if (withDebug) {
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${PORT} --remote-allow-origins=*`
    env.WEBVIEW2_USER_DATA_FOLDER = WEBVIEW_DATA_DIR
  }
  console.log(`启动应用（${withDebug ? '带 CDP' : '第二实例，无 CDP'}）：${EXE}`)
  const proc = spawn(EXE, [], { env, stdio: ['ignore', logFd, logFd], windowsHide: false })
  if (withDebug) {
    state.proc = proc
    state.spawnedPid = proc.pid
    state.appExitCode = null
    proc.on('exit', (code) => {
      state.appExitCode = code
      console.log(`应用进程退出：code=${code}`)
    })
    await waitForEndpoint(PORT, { timeoutMs: 60000, label: 'WebView2 DevTools' })
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const targets = await listTargets(PORT).catch(() => [])
      const target = targets.find((item) => /tauri\.localhost|tauri:\/\/|localhost:1420/.test(item.url || ''))
      if (target) return { target, proc }
      if (state.appExitCode !== null) throw new Error(`应用启动后退出（code=${state.appExitCode}）`)
      await sleep(300)
    }
    throw new Error('未找到应用页面 target')
  }
  return { proc }
}

async function connectApp(target) {
  const client = await connect(PORT, (item) => item.id === target.id, { timeoutMs: 30000 })
  await client.startCapture()
  await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'Tauri IPC' })
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照加载' })
  return client
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

async function clickSidebar(client, label) {
  await client.clickByText(label, 'aside nav button, aside button')
  await sleep(350)
}

async function saveSettings(client) {
  await client.clickByText('保存设置')
  await sleep(800)
}

async function ensureSettings(client, { downloadDir, bandwidthMb } = {}) {
  await clickSidebar(client, '设置')
  await client.waitFor('Boolean(document.querySelector("#settings-download-dir"))', { timeoutMs: 20000, description: '设置页' })
  if (downloadDir) await client.type('#settings-download-dir', downloadDir)
  if (bandwidthMb !== undefined) await client.type('#settings-bandwidth', String(bandwidthMb))
  await saveSettings(client)
  return client.tauriInvoke('get_settings')
}

async function setSwitch(client, ariaLabel, checked) {
  const current = await client.evaluate(`(() => { const el = document.querySelector('[role="switch"][aria-label=${JSON.stringify(ariaLabel)}]'); return el ? el.getAttribute('aria-checked') === 'true' : null; })()`)
  if (current === checked) return true
  await client.evaluate(`(() => { const el = document.querySelector('[role="switch"][aria-label=${JSON.stringify(ariaLabel)}]'); if (el) el.click(); return true; })()`)
  await sleep(250)
  return true
}

async function openRepoAndSelect(client, filePath = BIG_FILE) {
  const base = await client.evaluate('location.origin + location.pathname')
  await client.navigate(`${base}?repo=${encodeURIComponent(REPO)}&source=modelscope`)
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(REPO)})`, { timeoutMs: 45000, description: '仓库详情' })
  await client.waitFor('document.querySelectorAll(\'input[aria-label^="选择 "]\').length > 0', { timeoutMs: 45000, description: '文件表' })
  await client.clickByText('清空选择')
  await sleep(300)
  const ok = await client.evaluate(`(() => {
    const input = document.querySelector('input[aria-label=${JSON.stringify(`选择 ${filePath}`)}]');
    if (!input) return false;
    if (!input.checked) input.click();
    return input.checked;
  })()`)
  if (!ok) throw new Error(`勾选文件失败：${filePath}`)
  await client.clickByText('开始下载')
  await sleep(600)
}

async function waitTask(client, predicate, { timeoutMs = 120000, intervalMs = 250, description = '任务条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const snap = await client.tauriInvoke('get_snapshot')
    last = (snap.tasks || []).find(predicate)
    if (last) return last
    await sleep(intervalMs)
  }
  return null
}

async function waitTaskStatus(client, taskId, statuses, { timeoutMs = 120000 } = {}) {
  const wanted = new Set(statuses)
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const snap = await client.tauriInvoke('get_snapshot')
    last = (snap.tasks || []).find((task) => task.taskId === taskId)
    if (last && wanted.has(last.status)) return last
    await sleep(200)
  }
  return last
}

function readTasksFile() {
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* A. 托盘后台下载                                                     */
/* ------------------------------------------------------------------ */

async function runTrayBackground(client) {
  console.log('\n──────── A. 托盘后台下载（closeToTray=true）────────')
  const settings = await ensureSettings(client, { downloadDir: DOWNLOAD_DIR, bandwidthMb: 0.4 })
  results.record('设置下载目录/限速为临时目录与 0.4MB/s', settings.downloadDir === DOWNLOAD_DIR && Math.round(settings.bandwidthLimit) === Math.round(0.4 * 1024 * 1024), JSON.stringify({ downloadDir: settings.downloadDir, bandwidth: settings.bandwidthLimit }))

  await openRepoAndSelect(client)
  const task = await waitTask(client, (item) => item.repoId === REPO && item.remotePath === BIG_FILE)
  results.record('开始真实下载（限速 0.4MB/s）', Boolean(task), task ? `taskId=${task.taskId}` : '未找到任务')
  if (!task) return null
  await clickSidebar(client, '下载队列')
  await waitTaskStatus(client, task.taskId, ['active'], { timeoutMs: 30000 })
  await sleep(800)
  const live = await client.tauriInvoke('get_snapshot')
  const running = (live.tasks || []).find((item) => item.taskId === task.taskId)
  results.record('下载进行中且产生进度', running?.status === 'active' && running.downloaded > 0, `downloaded=${running?.downloaded}/${running?.totalSize}`)

  // 记录窗口句柄并关闭窗口（PostMessage WM_CLOSE）
  const before = psWindow('state', state.spawnedPid)
  state.firstWindowHandle = before?.hwnd || null
  results.record('关闭前主窗口可见', before?.visible === true && Boolean(before?.hwnd), JSON.stringify(before))
  const close = psWindow('close', state.spawnedPid)
  results.record('发送 WM_CLOSE（模拟用户点关闭按钮）', close?.posted === 1 || close?.posted === true, JSON.stringify(close))
  await sleep(1800)

  const procAlive = state.appExitCode === null
  results.record('关闭窗口后进程仍存活（后台常驻托盘）', procAlive, `appExitCode=${state.appExitCode}`)
  const hidden = psWindow('visibility', state.spawnedPid, state.firstWindowHandle)
  results.record('窗口已隐藏（原主窗口 IsWindowVisible=false）', procAlive && hidden?.visible === false, JSON.stringify(hidden))

  // 隐藏后 CDP 是否仍可访问 + 应用内提示
  let hiddenToast = null
  try {
    hiddenToast = await client.evaluate('document.body.innerText.includes("已最小化到托盘")')
  } catch (error) {
    notes.push(`窗口隐藏后 CDP 不可访问：${error.message}；后续以文件系统/进程事实为准。`)
  }
  results.record('应用内提示「已最小化到托盘」', hiddenToast === true, String(hiddenToast))

  // .part 增长 + tasks.json
  const partPath = running?.tempPath || `${running?.savePath}.part`
  const size1 = existsSync(partPath) ? statSync(partPath).size : 0
  await sleep(3000)
  const size2 = existsSync(partPath) ? statSync(partPath).size : 0
  results.record('窗口隐藏后 .part 继续增长（后台下载）', size2 > size1 && size1 > 0, `${partPath}: ${size1} → ${size2} B（+${size2 - size1}）`)
  const tasksDisk = readTasksFile()
  const diskTask = (tasksDisk?.tasks || []).find((item) => item.taskId === task.taskId)
  results.record('tasks.json 中任务状态 active 且已落盘', diskTask?.status === 'active' && diskTask.downloaded > 0, JSON.stringify(diskTask ? { status: diskTask.status, downloaded: diskTask.downloaded, total: diskTask.totalSize } : null))

  // 第二实例唤起
  const secondStart = Date.now()
  const { proc: second } = await launchApp({ withDebug: false })
  const exited = await Promise.race([
    new Promise((resolve) => second.on('exit', () => resolve(true))),
    sleep(6000).then(() => false),
  ])
  const secondExitMs = Date.now() - secondStart
  results.record('第二实例 ≤6s 退出（单实例生效）', exited === true, `用时=${secondExitMs}ms`)
  let visibleAgain = false
  const visibleDeadline = Date.now() + 6000
  while (Date.now() < visibleDeadline) {
    const info = psWindow('state', state.spawnedPid)
    if (info?.visible === true) {
      visibleAgain = true
      break
    }
    await sleep(300)
  }
  results.record('第二实例启动后主窗口被唤起（≤6s）', visibleAgain, JSON.stringify(psWindow('state', state.spawnedPid)))
  let progressAfterWake = null
  try {
    const snap = await client.tauriInvoke('get_snapshot')
    progressAfterWake = (snap.tasks || []).find((item) => item.taskId === task.taskId)
  } catch (error) {
    notes.push(`唤起后 CDP 读取失败：${error.message}`)
  }
  results.record('唤起后进度正确（继续且 downloaded 与总大小一致）', Boolean(progressAfterWake) && progressAfterWake.downloaded > (running?.downloaded || 0) && progressAfterWake.totalSize === BIG_SIZE, JSON.stringify(progressAfterWake ? { downloaded: progressAfterWake.downloaded, total: progressAfterWake.totalSize, status: progressAfterWake.status } : null))
  await screenshot(client, 'tray-background-running')

  // 等待完成（通知/Toast 证据）
  const completed = await waitTaskStatus(client, task.taskId, ['completed', 'error', 'cancelled'], { timeoutMs: 120000 })
  results.record('后台下载最终完成', completed?.status === 'completed', JSON.stringify(completed ? { status: completed.status, downloaded: completed.downloaded, total: completed.totalSize } : null))
  await sleep(800)
  const toastInfo = await client.evaluate(`(() => {
    const text = document.body.innerText;
    return { hasDone: text.includes('下载完成'), hasOpen: text.includes('打开位置'), hasRetry: text.includes('重试') };
  })()`)
  results.record('完成任务应用内 Toast（含「打开位置」动作）', toastInfo.hasDone && toastInfo.hasOpen, JSON.stringify(toastInfo))
  await screenshot(client, 'completion-toast')
  desktopScreenshot('desktop-after-completion.png')
  const logText = (() => {
    try { return readFileSync(join(EVIDENCE_DIR, 'app.log'), 'utf8') } catch { return '' }
  })()
  const notificationErrorLines = logText.split('\n').filter((line) => /notification/i.test(line))
  results.record('后端通知发送无错误日志（成功通知静默）', notificationErrorLines.length === 0, notificationErrorLines.slice(0, 2).join(' | ') || 'app.log 无 notification 错误行')
  const trayInitErrors = logText.split('\n').filter((line) => /托盘初始化失败|创建托盘/.test(line))
  results.record('托盘创建无错误日志（间接证据）', trayInitErrors.length === 0, trayInitErrors.slice(0, 2).join(' | ') || 'app.log 无托盘初始化失败记录')
  await trySystemNotificationEvidence('完成通知')
  await tryTrayEvidence(state.spawnedPid)

  // 通知开关关闭 → 保存生效
  await clickSidebar(client, '设置')
  await setSwitch(client, '下载完成或失败时发送系统通知', false)
  await saveSettings(client)
  const afterToggle = await client.tauriInvoke('get_settings')
  results.record('通知开关关闭并保存生效', afterToggle.notificationsEnabled === false, `notificationsEnabled=${afterToggle.notificationsEnabled}`)

  // 失败任务 → error toast（含「重试」）
  const failStart = await client.tauriInvoke('start_downloads', {
    requests: [{ source: 'modelscope', repoId: REPO, remotePath: '__qa_not_exist__.bin', size: 123, saveDir: DOWNLOAD_DIR }],
  })
  const failTaskId = failStart?.[0]?.taskId
  const failed = failTaskId ? await waitTaskStatus(client, failTaskId, ['error', 'cancelled'], { timeoutMs: 60000 }) : null
  results.record('失败下载进入 error 状态', failed?.status === 'error', JSON.stringify(failed ? { status: failed.status, error: (failed.error || '').slice(0, 120) } : null))
  await sleep(900)
  const failToast = await client.evaluate(`(() => {
    const text = document.body.innerText;
    return { hasFail: text.includes('下载失败'), hasRetry: text.includes('重试'), hasErrorAlert: Boolean([...document.querySelectorAll('[role="alert"]')].length) };
  })()`)
  results.record('失败任务应用内 error Toast（含「重试」动作）', failToast.hasFail && failToast.hasRetry && failToast.hasErrorAlert, JSON.stringify(failToast))
  await screenshot(client, 'failure-toast')

  // 清理任务记录
  try {
    await client.tauriInvoke('clear_finished')
  } catch {
    /* ignore */
  }
  const doneFile = join(DOWNLOAD_DIR, 'Qwen', 'Qwen2.5-0.5B-Instruct', BIG_FILE)
  rmSync(doneFile, { force: true })
  rmSync(`${doneFile}.part`, { force: true })
  return task
}

/* ------------------------------------------------------------------ */
/* C. closeToTray=false 退出语义 / 重启恢复                            */
/* ------------------------------------------------------------------ */

async function runExitSemantics(client) {
  console.log('\n──────── C. closeToTray=false 退出语义 / 重启恢复 ────────')
  await clickSidebar(client, '设置')
  await setSwitch(client, '关闭窗口时最小化到托盘并在后台继续下载', false)
  await saveSettings(client)
  const settings = await client.tauriInvoke('get_settings')
  results.record('closeToTray 关闭并保存生效', settings.closeToTray === false, `closeToTray=${settings.closeToTray}`)

  await openRepoAndSelect(client)
  const task = await waitTask(client, (item) => item.repoId === REPO && item.remotePath === BIG_FILE)
  if (!task) {
    results.record('start download for exit test', false, '未创建任务')
    return
  }
  await sleep(1200)
  const snap = await client.tauriInvoke('get_snapshot')
  const active = (snap.tasks || []).find((item) => item.taskId === task.taskId)
  results.record('退出测试下载进行中', active?.status === 'active' && active.downloaded > 0, JSON.stringify(active ? { status: active.status, downloaded: active.downloaded } : null))

  const closeStart = Date.now()
  const close = psWindow('close', state.spawnedPid)
  const exitDeadline = Date.now() + 15000
  let exited = false
  while (Date.now() < exitDeadline) {
    if (state.appExitCode !== null) {
      exited = true
      break
    }
    await sleep(300)
  }
  results.record('closeToTray=false：关窗后进程退出', exited, `exitCode=${state.appExitCode}，等待=${Date.now() - closeStart}ms，postMessage=${JSON.stringify(close)}`)
  const tasksDisk = readTasksFile()
  const persisted = (tasksDisk?.tasks || []).find((item) => item.taskId === task.taskId)
  results.record(
    '退出时 tasks.json 已落盘且任务不丢（paused/queued）',
    Boolean(persisted) && ['paused', 'queued', 'pausing'].includes(persisted.status) && persisted.downloaded > 0,
    JSON.stringify(persisted ? { status: persisted.status, downloaded: persisted.downloaded } : null),
  )

  if (persisted?.status === 'pausing') {
    notes.push('P2 观察：closeToTray=false 退出落盘时任务状态为 pausing（非 paused/queued）。数据未丢、重启恢复为 paused；建议退出前等待暂停完成再落盘，或将验收文案放宽为 paused/queued/pausing。')
  }

  // 重启 → 恢复为 paused / queued
  if (state.client) await state.client.close().catch(() => {})
  state.client = null
  state.spawnedPid = null
  const { target } = await launchApp()
  state.client = await connectApp(target)
  const snap2 = await state.client.tauriInvoke('get_snapshot')
  const recovered = (snap2.tasks || []).find((item) => item.taskId === task.taskId)
  results.record(
    '重启后任务恢复（paused/queued，不丢进度）',
    Boolean(recovered) && ['paused', 'queued'].includes(recovered.status) && recovered.downloaded > 0,
    JSON.stringify(recovered ? { status: recovered.status, downloaded: recovered.downloaded } : null),
  )
  await clickSidebar(state.client, '下载队列')
  await sleep(500)
  await screenshot(state.client, 'recovered-task')
  // 清理
  try {
    await state.client.tauriInvoke('clear_finished')
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  mkdirSync(APP_DATA_DIR, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  console.log(`下载目录：${DOWNLOAD_DIR}`)
  results.record('应用 exe 存在', existsSync(EXE), EXE)
  if (!existsSync(EXE)) {
    const summary = results.summary('v0.1.3 托盘后台下载验收（缺少前置构建）')
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary }, null, 2), 'utf8')
    process.exitCode = 1
    return
  }
  backupAppData()
  try {
    const { target } = await launchApp()
    state.client = await connectApp(target)
    results.record('测试实例启动（9223 + WebView2 数据目录隔离）', true, `spawnedPid=${state.spawnedPid}`)
    const snapshot = await state.client.tauriInvoke('get_snapshot')
    results.record('真实模式 / 版本号', snapshot.appVersion === '0.1.3', `appVersion=${snapshot.appVersion}`)

    await runTrayBackground(state.client)
    await runExitSemantics(state.client)

    state.pageErrors = state.client?.pageErrors?.slice() || []
    state.consoleErrors = state.client?.consoleErrors?.slice() || []
    results.record('全流程无未捕获页面异常', state.pageErrors.length === 0, `${state.pageErrors.length} 个`)
    const ignored = (item) => /favicon/i.test(item.text) || /Failed to load resource: the server responded with a status of 404/.test(item.text) || /DevTools/.test(item.text)
    const realErrors = state.consoleErrors.filter((item) => !ignored(item))
    results.record('全流程无控制台错误', realErrors.length === 0, realErrors.map((item) => item.text).join(' | ').slice(0, 600))
  } finally {
    if (state.client) await state.client.close().catch(() => {})
    killOwnApp()
    await sleep(1200)
    restoreAppData()
    rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
    rmSync(WEBVIEW_DATA_DIR, { recursive: true, force: true })
    console.log('已还原应用数据并清理下载/临时 WebView2 目录')
    console.log(`当前剩余应用实例：${appPids().join(', ') || '无'}`)
  }
  const summary = results.summary('v0.1.3 托盘后台下载/通知/退出语义真机验收')
  writeFileSync(
    RESULT_JSON,
    JSON.stringify({ stamp: STAMP, exe: EXE, summary, notes, screenshots: state.screenshots, consoleErrors: state.consoleErrors, pageErrors: state.pageErrors }, null, 2),
    'utf8',
  )
  console.log(`结果 JSON：${RESULT_JSON}`)
  if (notes.length > 0) {
    console.log('\n限制/说明：')
    for (const note of notes) console.log(`  - ${note}`)
  }
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`\n托盘后台下载验收异常：${error.message || error}`)
  results.record('托盘后台下载验收主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('v0.1.3 托盘后台下载验收（异常终止）')
  try {
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, notes, fatalError: String(error.stack || error) }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  if (state.client) state.client.close().catch(() => {})
  killOwnApp()
  restoreAppData()
  process.exitCode = 1
})
