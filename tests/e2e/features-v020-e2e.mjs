#!/usr/bin/env node
/**
 * tests/e2e/features-v020-e2e.mjs — v0.2.0 多扫描根 / revision / 通知点击 真机验收
 *
 * 覆盖：
 *   A. 多扫描根：downloadDir + 附加根；LocalFile.rootDir 正确、树根节点数、统计合计、
 *      移除根后消失、重启后 libraryRoots 持久化；
 *   B. revision：HF list_revisions、非默认 revision（commit SHA 自定义）下载路径 `{repoId}/{revision}/`、
 *      与默认 revision 同名文件并存不冲突、默认路径不变；ModelScope master；错误 revision 中文错误不崩溃；
 *      浏览页 RevisionSelector UI（自定义 revision 应用与文件列表刷新）；
 *   C. 通知点击：closeToTray 隐藏窗口 → 完成下载触发系统通知 → Windows UIA 定位并点击 toast →
 *      主窗口 show/focus（无法自动点击则记录实施细节与桌面截图）；
 *   D. 设置页 v0.2.0 新项（单文件连接数 / 本地库附加扫描根）存在且回显正确。
 *
 * 安全：临时下载目录/临时库根；应用数据备份→还原；只结束自己 spawn 的进程；不改源码。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
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
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `features-v020-e2e-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'features-v020-e2e-result.json')
const APP_DATA_DIR = join(process.env.APPDATA, 'com.modeldownload.manager')
const WEBVIEW_DATA_DIR = join(EVIDENCE_DIR, 'ebwebview')
const TEMP_ROOT = join(process.env.LOCALAPPDATA, 'Temp', 'mdm-qa', `feat-${STAMP}`)
const ROOT_A = join(TEMP_ROOT, 'main-download')
const ROOT_B = join(TEMP_ROOT, 'extra-root-b')
const SETTINGS_FILE = join(APP_DATA_DIR, 'settings.json')
const TASKS_FILE = join(APP_DATA_DIR, 'tasks.json')
const HF_REPO = 'Qwen/Qwen2.5-0.5B-Instruct'
const MS_REPO = 'Qwen/Qwen2.5-0.5B-Instruct'

const results = createResults()
const notes = []
const pathNorm = (p) => String(p).replace(/\//g, '\\').toLowerCase()
const state = { client: null, proc: null, spawnedPid: null, appExitCode: null, screenshots: [], consoleErrors: [], pageErrors: [], hwnd: null, settings: null }

const screenshot = (client, name) =>
  client.screenshot(join(EVIDENCE_DIR, 'shots', `${name}.png`)).then((info) => {
    state.screenshots.push(info.path)
    return info.path
  }).catch(() => null)

/* ---------------- 文件/应用数据 ---------------- */

function writeFixture(filePath, size, fill) {
  mkdirSync(dirname(filePath), { recursive: true })
  const buffer = Buffer.alloc(size, fill ?? 7)
  writeFileSync(filePath, buffer)
  return filePath
}
async function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', rejectHash)
  })
}
function backupAppData() {
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

/* ---------------- Win32 / UIA ---------------- */

const WIN32_HELPERS = `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class QAF {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@`
function psWindow(action, pid, hwnd) {
  const body =
    action === 'close'
      ? `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { Write-Output '{"found":false}'; exit 0 }; $h = $p.MainWindowHandle; $ok = [QAF]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); Write-Output ('{"found":true,"hwnd":' + $h.ToInt64() + ',"posted":' + $ok + '}')`
      : action === 'visibility'
        ? `$h = [IntPtr]${hwnd}; $ok = [QAF]::IsWindowVisible($h); Write-Output ('{"visible":' + $ok.ToString().ToLower() + '}')`
        : action === 'state'
          ? `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { Write-Output '{"found":false}'; exit 0 }; $h = $p.MainWindowHandle; $visible = if ($h -ne [IntPtr]::Zero) { [QAF]::IsWindowVisible($h) } else { $false }; Write-Output ('{"found":true,"hwnd":' + $h.ToInt64() + ',"visible":' + $visible.ToString().ToLower() + '}')`
          : `$h = [QAF]::GetForegroundWindow(); Write-Output ('{"foreground":' + $h.ToInt64() + '}')`
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `${WIN32_HELPERS}\n${body}`], { encoding: 'utf8', timeout: 30000 })
  try {
    return JSON.parse((result.stdout || '').trim().split('\n').filter((line) => line.trim().startsWith('{')).pop())
  } catch {
    return { error: (result.stdout || result.stderr || '').slice(0, 300) }
  }
}

function findAndClickToast() {
  // 1) 枚举 Win11/Win10 通知窗口：右下角、可见、类名 XamlExplorerHostIslandWindow / Windows.UI.Core.CoreWindow 等
  const enumScript = `Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class QAT {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$items = New-Object System.Collections.ArrayList
$cb = [QAT+EnumProc]{ param($h, $l)
  if (-not [QAT]::IsWindowVisible($h)) { return $true }
  $cls = New-Object System.Text.StringBuilder 256; [void][QAT]::GetClassName($h, $cls, 256)
  $title = New-Object System.Text.StringBuilder 256; [void][QAT]::GetWindowText($h, $title, 256)
  $rect = New-Object QAT+RECT; [void][QAT]::GetWindowRect($h, [ref]$rect)
  $w = $rect.Right - $rect.Left; $ht = $rect.Bottom - $rect.Top
  if ($w -lt 250 -or $w -gt 700 -or $ht -lt 60 -or $ht -gt 400) { return $true }
  $cx = ($rect.Left + $rect.Right) / 2; $cy = ($rect.Top + $rect.Bottom) / 2
  if ($cx -lt ($screen.Width / 2) -or $cy -lt ($screen.Height / 2)) { return $true }
  $clsText = $cls.ToString(); $titleText = $title.ToString()
  if ($clsText -match 'XamlExplorerHostIslandWindow|Windows.UI.Core.CoreWindow|Windows.UI.Composition.DesktopWindowContentBridge|NotifyIcon' -or $titleText -match '模型下载管理器') {
    [void]$items.Add([pscustomobject]@{ hwnd = $h.ToInt64(); cls = $clsText; title = $titleText; x = [int]$cx; y = [int]$cy; w = $w; h = $ht })
  }
  return $true
}
[void][QAT]::EnumWindows($cb, [IntPtr]::Zero)
$items | ConvertTo-Json -Compress`
  const enumResult = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', enumScript], { encoding: 'utf8', timeout: 30000 })
  let candidates = []
  try {
    const text = (enumResult.stdout || '').trim()
    const line = text.split('\n').filter((item) => item.trim().startsWith('[') || item.trim().startsWith('{')).pop() || '[]'
    const parsed = JSON.parse(line)
    candidates = Array.isArray(parsed) ? parsed : [parsed]
  } catch { candidates = [] }
  candidates = candidates.filter((item) => item && item.x > 0 && item.y > 0)
  if (candidates.length === 0) return clickToastViaUia(enumResult)
  const target = candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0]
  const clickScript = `@@WIN32@@
[void][QAF]::SetCursorPos(@@X@@, @@Y@@); Start-Sleep -Milliseconds 150; [QAF]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [QAF]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Write-Output 'clicked'`.split('@@WIN32@@').join(WIN32_HELPERS).split('@@X@@').join(String(target.x)).split('@@Y@@').join(String(target.y))
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', clickScript], { encoding: 'utf8', timeout: 30000 })
  return { ok: true, found: target, candidates }
}

function clickToastViaUia(enumResult) {
  const uiaScript = `try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName System.Windows.Forms
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $found = $null
    foreach ($el in $els) {
      try {
        $n = $el.Current.Name
        if ($n -and ($n -match '下载完成|下载失败')) {
          $r = $el.Current.BoundingRectangle
          if ($r.Width -gt 0 -and $r.Height -gt 0 -and $r.X -gt ($screen.Width / 2) -and $r.Y -gt ($screen.Height / 2) -and $r.X -lt $screen.Width -and $r.Y -lt $screen.Height) {
            $found = [pscustomobject]@{ name = $n; x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2) }
            break
          }
        }
      } catch { }
    }
    Write-Output (@{ ok = $true; found = $found } | ConvertTo-Json -Compress)
  } catch { Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) }`
  const uia = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', uiaScript], { encoding: 'utf8', timeout: 60000 })
  let parsed = null
  try { parsed = JSON.parse((uia.stdout || '').trim().split('\n').filter((line) => line.trim().startsWith('{')).pop()) } catch { parsed = { ok: false } }
  if (!parsed?.ok || !parsed.found) {
    return { ok: false, parsed: { reason: 'UIA 未定位到右下角通知文本', uia: parsed, raw: (uia.stdout || uia.stderr || '').slice(0, 200), enum: (enumResult?.stdout || enumResult?.stderr || '').slice(0, 160) } }
  }
  const target = parsed.found
  const clickScript = WIN32_HELPERS + `\n[void][QAF]::SetCursorPos(${target.x}, ${target.y}); Start-Sleep -Milliseconds 150; [QAF]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [QAF]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Write-Output 'clicked'`
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', clickScript], { encoding: 'utf8', timeout: 30000 })
  return { ok: true, found: target, source: 'uia' }
}

function findAndClickToastLegacy() {
  const script = `try {
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $found = $null
    foreach ($el in $els) { try { $n = $el.Current.Name; if ($n -and ($n -match '下载完成|下载失败|模型下载管理器')) { $r = $el.Current.BoundingRectangle; if ($r.Width -gt 0 -and $r.Height -gt 0) { $found = [pscustomobject]@{ name = $n; x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2) }; break } } } catch { } }
    Write-Output (@{ ok = $true; found = $found } | ConvertTo-Json -Compress)
  } catch { Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) }`
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 })
  let parsed = null
  try { parsed = JSON.parse((result.stdout || '').trim().split('\n').filter((line) => line.trim().startsWith('{')).pop()) } catch { parsed = { ok: false } }
  if (!parsed?.ok || !parsed.found) return { ok: false, parsed }
  const { x, y } = parsed.found
  const clickScript = `${WIN32_HELPERS}\n[void][QAF]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 120; [QAF]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [QAF]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Write-Output 'clicked'`
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', clickScript], { encoding: 'utf8', timeout: 30000 })
  return { ok: true, found: parsed.found }
}

function desktopScreenshot(name) {
  const path = join(EVIDENCE_DIR, 'shots', name)
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save(${JSON.stringify(path)}, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 30000 })
  if (existsSync(path)) { state.screenshots.push(path); return path }
  return null
}

/* ---------------- 进程/连接 ---------------- */

function appPids() {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', "(Get-Process -Name 'model-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"], { encoding: 'utf8', timeout: 15000 })
  return (r.stdout || '').split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0)
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
  state.appExitCode = null
  state.proc = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=*`, WEBVIEW2_USER_DATA_FOLDER: WEBVIEW_DATA_DIR },
    stdio: ['ignore', logFd, logFd],
    windowsHide: false,
  })
  state.spawnedPid = state.proc.pid
  const proc = state.proc
  proc.on('exit', (code) => { if (state.proc === proc) state.appExitCode = code })
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
  await client.tauriInvoke('save_settings', { settings: { ...current, ...patch } })
  await sleep(400)
  return getSettings(client)
}
async function snapshot(client) { return client.tauriInvoke('get_snapshot') }
async function taskById(client, taskId) {
  const snap = await snapshot(client)
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
  if (!taskId) throw new Error(`start_downloads 无 taskId：${JSON.stringify(tasks)}`)
  return taskId
}
async function clickSidebar(client, label) {
  await client.clickByText(label, 'aside nav button, aside button')
  await sleep(400)
}
function readTasks() { try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')) } catch { return null } }
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${unit === 0 ? value : value.toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`
}

/* ---------------- A. 多扫描根 ---------------- */

async function runMultiRoots(client) {
  console.log('\n--- A：多扫描根目录 ---')
  // 构造：downloadDir=ROOT_A（2 个仓库目录 + 根文件），附加根 ROOT_B（1 个仓库 + 根文件）
  writeFixture(join(ROOT_A, 'OrgA', 'ModelA', 'model-a.gguf'), 1024 * 1024, 0x11)
  writeFixture(join(ROOT_A, 'OrgA', 'ModelA', 'config.json'), 2048, 0x22)
  writeFixture(join(ROOT_A, 'top-level.bin'), 4096, 0x33)
  writeFixture(join(ROOT_B, 'OrgB', 'ModelB', 'model-b.safetensors'), 2 * 1024 * 1024, 0x44)
  writeFixture(join(ROOT_B, 'README-b.md'), 512, 0x55)
  const settings = await saveSettings(client, { downloadDir: ROOT_A, libraryRoots: [ROOT_B], connectionsPerFile: 4, bandwidthLimit: 0 })
  results.record('[A] 写入 libraryRoots 并生效', settings.downloadDir === ROOT_A && Array.isArray(settings.libraryRoots) && settings.libraryRoots.length === 1 && settings.libraryRoots[0] === ROOT_B, JSON.stringify({ downloadDir: settings.downloadDir, libraryRoots: settings.libraryRoots }))

  const files = await client.tauriInvoke('scan_library')
  const normalizedRootA = pathNorm(ROOT_A)
  const normalizedRootB = pathNorm(ROOT_B)
  const rootDirOk = (files || []).every((file) => {
    const normalized = pathNorm(file.path)
    if (normalized.startsWith(normalizedRootA + '\\')) return pathNorm(file.rootDir) === normalizedRootA
    if (normalized.startsWith(normalizedRootB + '\\')) return pathNorm(file.rootDir) === normalizedRootB
    return false
  })
  results.record(
    '[A] LocalFile.rootDir 正确（每文件归属对应扫描根）',
    rootDirOk && files.length === 5 && files.some((file) => pathNorm(file.rootDir) === normalizedRootB) && files.some((file) => pathNorm(file.rootDir) === normalizedRootA),
    `files=${files.length} roots=${[...new Set((files || []).map((file) => file.rootDir))].join(' | ')}`,
  )
  results.record(
    '[A] 多根聚合统计正确（5 个文件 / 3.00 MB+）',
    files.length === 5 && files.reduce((sum, file) => sum + Number(file.size || 0), 0) === 1024 * 1024 + 2048 + 4096 + 2 * 1024 * 1024 + 512,
    `count=${files.length} bytes=${files.reduce((sum, file) => sum + Number(file.size || 0), 0)}`,
  )

  await clickSidebar(client, '本地模型库')
  await client.waitFor('document.body.innerText.includes("扫描根目录")', { timeoutMs: 20000, description: '扫描根面板' })
  await client.waitFor(`document.body.innerText.includes("5 个文件") || document.body.innerText.includes("共 5 个文件")`, { timeoutMs: 30000, description: '多根扫描完成' })
  await sleep(500)
  const panelState = await client.evaluate(`(() => {
    const panel = document.querySelector('section[aria-label="扫描根目录"]');
    const roots = panel ? [...panel.querySelectorAll('[role="group"][aria-label^="扫描根 "]')].map((el) => el.getAttribute('aria-label')) : [];
    const treeRoots = [...document.querySelectorAll('[role="treeitem"][aria-level="1"]')].map((el) => (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 80));
    const totalText = panel ? panel.innerText.replace(/\\s+/g, ' ') : '';
    return { roots, treeRoots, totalText };
  })()`)
  results.record(
    '[A] 扫描根面板显示 2 个根（下载目录 + 附加根）',
    panelState.roots.length === 2 && panelState.roots.some((label) => pathNorm(label).includes(normalizedRootA)) && panelState.roots.some((label) => pathNorm(label).includes(normalizedRootB)) && /2 个根/.test(panelState.totalText),
    JSON.stringify(panelState).slice(0, 500),
  )
  results.record('[A] 树出现多个根节点（≥2）', panelState.treeRoots.length >= 2, JSON.stringify(panelState.treeRoots))
  await screenshot(client, '01-multi-root-tree')

  // 移除附加根
  const removeSelector = `button[aria-label=${JSON.stringify(`移除扫描根 ${ROOT_B}`)}]`
  const clickedRemove = await client.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(removeSelector)}); if (!el) return false; el.click(); return true; })()`)
  await client.waitFor(`document.body.innerText.includes("1 个根")`, { timeoutMs: 30000, description: '移除附加根' })
  const afterRemove = await getSettings(client)
  const filesAfterRemove = await client.tauriInvoke('scan_library')
  results.record(
    '[A] 移除附加根后不再扫描（downloadDir 始终保留）',
    clickedRemove && (afterRemove.libraryRoots || []).length === 0 && filesAfterRemove.length === 3 && filesAfterRemove.every((file) => pathNorm(file.rootDir) === normalizedRootA),
    `libraryRoots=${JSON.stringify(afterRemove.libraryRoots)} files=${filesAfterRemove.length}`,
  )
  await screenshot(client, '02-root-removed')

  // 重新添加并重启验证持久化
  await saveSettings(client, { libraryRoots: [ROOT_B] })
  await client.waitFor(`document.body.innerText.includes("2 个根")`, { timeoutMs: 30000, description: '重新添加根' })
  const settingsBeforeRestart = await getSettings(client)
  if (state.client) await state.client.close().catch(() => {})
  killOwnApp()
  await sleep(1500)
  const target = await launchApp()
  state.client = await connectApp(target)
  const settingsAfterRestart = await getSettings(state.client)
  const filesAfterRestart = await state.client.tauriInvoke('scan_library')
  results.record(
    '[A] 重启后 libraryRoots 持久化且多根扫描生效',
    JSON.stringify(settingsAfterRestart.libraryRoots) === JSON.stringify([ROOT_B]) && filesAfterRestart.length === 5,
    `before=${JSON.stringify(settingsBeforeRestart.libraryRoots)} after=${JSON.stringify(settingsAfterRestart.libraryRoots)} files=${filesAfterRestart.length}`,
  )
  await clickSidebar(state.client, '本地模型库')
  await sleep(800)
  const treeRootsAfterRestart = await state.client.evaluate(`[...document.querySelectorAll('[role="treeitem"][aria-level="1"]')].length`)
  results.record('[A] 重启后多根树正常渲染', treeRootsAfterRestart >= 2, `根节点=${treeRootsAfterRestart}`)
  await screenshot(state.client, '03-multi-root-after-restart')
  return { files: filesAfterRestart, settings: settingsAfterRestart }
}

/* ---------------- B. revision ---------------- */

async function runRevision(client) {
  console.log('\n--- B：revision 选择与下载 ---')
  // 1) list_revisions 真实 HF（取 main 分支与 tags；无 tags 时用 API sha 作为自定义 revision）
  const revisions = await client.tauriInvoke('list_revisions', { source: 'huggingface', repoId: HF_REPO })
  results.record(
    '[B] list_revisions 返回默认 revision/分支/标签结构',
    revisions && revisions.defaultRevision === 'main' && Array.isArray(revisions.branches) && Array.isArray(revisions.tags),
    JSON.stringify(revisions).slice(0, 400),
  )

  const apiResp = spawnSync('curl.exe', ['-sL', '--max-time', '60', `https://hf-mirror.com/api/models/${HF_REPO}`], { encoding: 'utf8', timeout: 90000 })
  let commitSha = null
  try { commitSha = JSON.parse(apiResp.stdout || '{}').sha || null } catch { commitSha = null }
  results.record('[B] 获取仓库 commit sha 作为自定义 revision 测试值', Boolean(commitSha), `sha=${commitSha}`)

  const detail = await client.tauriInvoke('get_repo_detail', { source: 'huggingface', repoId: HF_REPO })
  const smallFile = (detail.files || []).filter((file) => Number(file.size) > 0).sort((a, b) => Number(a.size) - Number(b.size))[0]
  results.record('[B] 默认 revision 文件列表可用且选取小文件', Boolean(smallFile), smallFile ? `${smallFile.path}（${smallFile.size}B）` : '无')

  const downloadDir = join(TEMP_ROOT, 'revision-download')
  // 2) 非默认 revision（commit sha）下载
  const shaTaskId = await startDownload(client, { source: 'huggingface', repoId: HF_REPO, remotePath: smallFile.path, size: Number(smallFile.size), saveDir: downloadDir, revision: commitSha })
  const shaTask = await waitTask(client, shaTaskId, ['completed', 'error'], 180000)
  const shaPath = shaTask?.savePath
  const shaDiskSha = shaPath && existsSync(shaPath) ? await sha256File(shaPath) : null
  results.record('[B] 非默认 revision 下载完成', shaTask?.status === 'completed', JSON.stringify(shaTask ? { status: shaTask.status, revision: shaTask.revision, error: shaTask.error } : null))
  results.record('[B] 任务 revision 字段 == 自定义 revision', shaTask?.revision === commitSha, `task.revision=${shaTask?.revision}`)
  results.record(
    '[B] 非默认 revision 保存路径含 {repoId}/{revision}/',
    Boolean(shaPath) && pathNorm(shaPath).includes(pathNorm(join(HF_REPO, commitSha))),
    `savePath=${shaPath}`,
  )

  // curl 对照同一 revision 内容
  const curlFile = join(EVIDENCE_DIR, `curl-revision-${smallFile.path.replace(/[\\/]/g, '_')}`)
  const curl = spawnSync('curl.exe', ['-sL', '--max-time', '120', '-o', curlFile, `https://hf-mirror.com/${HF_REPO}/resolve/${commitSha}/${smallFile.path}`], { encoding: 'utf8', timeout: 150000 })
  const curlSha = existsSync(curlFile) ? await sha256File(curlFile) : null
  results.record('[B] 非默认 revision 内容 sha256 与 curl 一致', Boolean(shaDiskSha) && shaDiskSha === curlSha, `app=${shaDiskSha} curl=${curlSha}`)

  // 3) 默认 revision 同名文件 → 路径不含 revision 段、可与非默认并存
  const defaultTaskId = await startDownload(client, { source: 'huggingface', repoId: HF_REPO, remotePath: smallFile.path, size: Number(smallFile.size), saveDir: downloadDir })
  const defaultTask = await waitTask(client, defaultTaskId, ['completed', 'error'], 180000)
  const defaultPath = defaultTask?.savePath
  results.record('[B] 默认 revision 下载完成且 revision 字段为 main', defaultTask?.status === 'completed' && defaultTask?.revision === 'main', JSON.stringify(defaultTask ? { status: defaultTask.status, revision: defaultTask.revision } : null))
  results.record(
    '[B] 默认路径不变（无 revision 段）且与非默认 revision 并存不冲突',
    Boolean(defaultPath) && !pathNorm(defaultPath).includes(pathNorm(commitSha)) && pathNorm(defaultPath) !== pathNorm(shaPath) && existsSync(shaPath) && existsSync(defaultPath),
    `default=${defaultPath}；nonDefault=${shaPath}`,
  )

  // 4) 浏览页 RevisionSelector UI：打开 → 自定义 revision 输入 sha → 应用 → 文件列表刷新
  const base = await client.evaluate('location.origin + location.pathname')
  await client.navigate(`${base}?repo=${encodeURIComponent(HF_REPO)}&source=huggingface`)
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(HF_REPO)})`, { timeoutMs: 45000, description: '仓库详情' })
  await client.waitFor(`Boolean(document.querySelector('button[aria-label^="选择 HuggingFace revision"]'))`, { timeoutMs: 45000, description: 'Revision 选择器' })
  const selectorBefore = await client.evaluate(`(() => { const b = document.querySelector('button[aria-label^="选择 HuggingFace revision"]'); return { label: b.getAttribute('aria-label'), text: b.innerText.replace(/\\s+/g, ' ') }; })()`)
  await client.evaluate(`document.querySelector('button[aria-label^="选择 HuggingFace revision"]').click()`)
  await client.waitFor(`Boolean(document.querySelector('[role="dialog"][aria-label="选择 revision"]'))`, { timeoutMs: 15000, description: 'revision 弹层' })
  const dialogState = await client.evaluate(`(() => { const d = document.querySelector('[role="dialog"][aria-label="选择 revision"]'); return d ? { text: d.innerText.replace(/\\s+/g, ' ').slice(0, 500), options: d.querySelectorAll('button').length } : null; })()`)
  await screenshot(client, '04-revision-selector')
  const customClicked = await client.evaluate(`(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('自定义')); if (!btn) return false; btn.click(); return true; })()`)
  results.record('[B] RevisionSelector 支持自定义 revision 输入', customClicked, '')
  await client.waitFor(`Boolean(document.querySelector('input[aria-label="自定义 revision"]'))`, { timeoutMs: 10000, description: '自定义 revision 输入' })
  await client.type('input[aria-label="自定义 revision"]', commitSha)
  await client.clickByText('应用')
  await client.waitFor(`Boolean(document.querySelector('button[aria-label^="选择 HuggingFace revision"]')) && document.querySelector('button[aria-label^="选择 HuggingFace revision"]').getAttribute('aria-label').includes(${JSON.stringify(commitSha)})`, { timeoutMs: 30000, description: '应用自定义 revision' })
  await client.waitFor(`document.querySelectorAll('input[aria-label^="选择 "]').length > 0`, { timeoutMs: 45000, description: 'revision 切换后文件列表刷新' })
  const selectorAfter = await client.evaluate(`(() => { const b = document.querySelector('button[aria-label^="选择 HuggingFace revision"]'); return { label: b.getAttribute('aria-label'), text: b.innerText.replace(/\\s+/g, ' ') }; })()`)
  results.record(
    '[B] 浏览页 RevisionSelector 自定义 revision 应用并刷新文件列表',
    selectorBefore.label.includes('main') && Boolean(dialogState) && dialogState.options >= 1 && selectorAfter.label.includes(commitSha),
    `before=${JSON.stringify(selectorBefore)} after=${JSON.stringify(selectorAfter)} dialog=${JSON.stringify(dialogState)?.slice(0, 200)}`,
  )
  await screenshot(client, '05-revision-applied')

  // 5) 无效 revision：中文错误且不崩溃
  let invalidTaskError = null
  try {
    const badTaskId = await startDownload(client, { source: 'huggingface', repoId: HF_REPO, remotePath: smallFile.path, size: Number(smallFile.size), saveDir: downloadDir, revision: 'qa-nonexistent-rev-xyz' })
    const badTask = await waitTask(client, badTaskId, ['error', 'completed'], 120000)
    invalidTaskError = badTask?.error || null
    results.record('[B] 无效 revision 下载任务进入 error（中文错误）', badTask?.status === 'error' && /[\u4e00-\u9fa5]/.test(invalidTaskError || ''), `status=${badTask?.status} error=${(invalidTaskError || '').slice(0, 160)}`)
  } catch (error) {
    invalidTaskError = String(error.message || error)
    results.record('[B] 无效 revision 下载任务进入 error（中文错误）', /[\u4e00-\u9fa5]/.test(invalidTaskError), invalidTaskError.slice(0, 200))
  }
  const aliveAfterInvalid = await client.tauriInvoke('get_snapshot')
  results.record('[B] 无效 revision 后应用仍存活且可响应 IPC', Boolean(aliveAfterInvalid) && aliveAfterInvalid.appVersion === '0.2.0', `appVersion=${aliveAfterInvalid?.appVersion}`)

  // 6) ModelScope 自定义 revision master（默认 → 默认路径不变）
  const msTaskId = await startDownload(client, { source: 'modelscope', repoId: MS_REPO, remotePath: 'config.json', size: 659, saveDir: downloadDir, revision: 'master' })
  const msTask = await waitTask(client, msTaskId, ['completed', 'error'], 120000)
  results.record(
    '[B] ModelScope 自定义 revision=master 下载完成且 revision 字段正确',
    msTask?.status === 'completed' && msTask?.revision === 'master' && Number(msTask?.downloaded) === 659,
    JSON.stringify(msTask ? { status: msTask.status, revision: msTask.revision, savePath: msTask.savePath } : null),
  )
  results.record(
    '[B] ModelScope master（默认 revision）保存路径不含 revision 段',
    Boolean(msTask?.savePath) && !pathNorm(msTask.savePath).includes(pathNorm('/master/')),
    `savePath=${msTask?.savePath}`,
  )
  return { commitSha, shaPath, defaultPath, revisionList: revisions }
}

/* ---------------- C. 通知点击 / D. 设置页新项 ---------------- */

async function runNotificationClick(client) {
  console.log('\n--- C：通知点击唤起窗口 ---')
  await saveSettings(client, { notificationsEnabled: true, closeToTray: true, downloadDir: join(TEMP_ROOT, 'main-download'), libraryRoots: [ROOT_B], connectionsPerFile: 4 })
  const before = psWindow('state', state.spawnedPid)
  state.hwnd = before?.hwnd || null
  results.record('[C] 隐藏前主窗口可见', before?.visible === true && Boolean(before?.hwnd), JSON.stringify(before))
  const close = psWindow('close', state.spawnedPid)
  await sleep(1500)
  const hidden = psWindow('visibility', state.spawnedPid, state.hwnd)
  results.record('[C] closeToTray 隐藏窗口（进程存活）', close && state.appExitCode === null && hidden?.visible === false, `close=${JSON.stringify(close)} visible=${hidden?.visible}`)

  // 隐藏状态下触发一次真实小文件下载完成 → 系统通知
  const downloadDir = join(TEMP_ROOT, 'notify-download')
  const notifyTaskId = await startDownload(client, { source: 'modelscope', repoId: MS_REPO, remotePath: 'merges.txt', size: 1671839, saveDir: downloadDir, revision: 'master' })
  const notifyTask = await waitTask(client, notifyTaskId, ['completed', 'error'], 180000)
  results.record('[C] 隐藏状态下下载完成（触发系统通知条件）', notifyTask?.status === 'completed', JSON.stringify(notifyTask ? { status: notifyTask.status, downloaded: notifyTask.downloaded } : null))
  await sleep(700)
  const toastInfo = await client.evaluate(`(() => ({ hasDone: document.body.innerText.includes('下载完成'), hasOpen: document.body.innerText.includes('打开位置') }))()`)
  results.record('[C] 完成 Toast 出现（含打开位置动作）', toastInfo.hasDone && toastInfo.hasOpen, JSON.stringify(toastInfo))

  const click = findAndClickToast()
  desktopScreenshot('06-desktop-notification.png')
  if (click.ok) {
    let shown = false
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const info = psWindow('visibility', state.spawnedPid, state.hwnd)
      if (info?.visible === true) { shown = true; break }
      await sleep(400)
    }
    results.record('[C] 点击系统通知后主窗口 show（IsWindowVisible=true）', shown, `toast=${JSON.stringify(click.found)}`)
    await screenshot(client, '07-after-toast-click')
    desktopScreenshot('08-desktop-after-toast-click.png')
    if (!shown) notes.push('[C] 已通过 UIA 定位并点击 toast，但 10s 内未观测到主窗口 visible（可能 UIA 定位到任务栏/其他文本元素）。')
  } else {
    notes.push(`[C] 无法自动定位/点击 Windows toast（UIA 限制）：${JSON.stringify(click.parsed).slice(0, 300)}；已保存应用内 Toast 截图与桌面截图（06-desktop-notification.png）。实施方式：closeToTray 隐藏 → IPC 触发完成下载 → PowerShell UIA 枚举 ControlType.Text（匹配 下载完成/模型下载管理器）→ mouse_event 点击；平台限制下如实记录。`)
    desktopScreenshot('07-desktop-toast-fallback.png')
  }
}

async function runSettingsChecks(client) {
  console.log('\n--- D：设置页 v0.2.0 新项 ---')
  await clickSidebar(client, '设置')
  await client.waitFor('document.body.innerText.includes("单文件连接数")', { timeoutMs: 20000, description: '单文件连接数' })
  const settingsText = await client.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 6000)`)
  const connectionsValue = await client.evaluate(`(() => { const input = document.querySelector('input[aria-label="单文件连接数"]'); return input ? input.value : (document.body.innerText.match(/单文件连接数[\\s\\S]{0,80}?(\\d)/)||[])[1] || null; })()`)
  const rootsCount = await client.evaluate(`(() => { const m = document.body.innerText.match(/本地库附加扫描根：(\\d+) 个/); return m ? Number(m[1]) : null; })()`)
  results.record(
    '[D] 设置页含「单文件连接数」（1-8）与「本地库附加扫描根」新项',
    /单文件连接数/.test(settingsText) && /1[\\s-]*8|1-8|1..8/.test(settingsText) && rootsCount !== null,
    `connections=${connectionsValue} libraryRoots=${rootsCount}`,
  )
  await screenshot(client, '09-settings-v020')
}

/* ---------------- 主流程 ---------------- */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  mkdirSync(TEMP_ROOT, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  console.log(`临时目录：${TEMP_ROOT}`)
  results.record('应用 exe 存在', existsSync(EXE), EXE)
  backupAppData()
  try {
    let target = await launchApp()
    state.client = await connectApp(target)
    let snap = await snapshot(state.client)
    results.record('应用启动且版本为 0.2.0', snap.appVersion === '0.2.0', `appVersion=${snap.appVersion}`)

    await runMultiRoots(state.client)
    const revisionInfo = await runRevision(state.client)
    await runSettingsChecks(state.client)
    await runNotificationClick(state.client)

    state.pageErrors = state.client.pageErrors.slice()
    state.consoleErrors = state.client.consoleErrors.slice()
    results.record('运行期无未捕获页面异常', state.pageErrors.length === 0, `${state.pageErrors.length} 个：${state.pageErrors.map((e) => e.text).join(' | ').slice(0, 400)}`)
    const ignored = (item) => /Failed to load resource: the server responded with a status of 404/.test(item.text) || /favicon/i.test(item.text) || /DevTools/.test(item.text)
    const realErrors = state.consoleErrors.filter((item) => !ignored(item))
    results.record('运行期无控制台错误（忽略 favicon/404 资源提示）', realErrors.length === 0, `${realErrors.length} 个：${realErrors.map((e) => e.text).join(' | ').slice(0, 600)}`)
    writeFileSync(join(EVIDENCE_DIR, 'revision-info.json'), JSON.stringify({ commitSha: revisionInfo.commitSha, revisionList: revisionInfo.revisionList, shaPath: revisionInfo.shaPath, defaultPath: revisionInfo.defaultPath }, null, 2), 'utf8')
  } finally {
    if (state.client) await state.client.close().catch(() => {})
    killOwnApp()
    await sleep(1500)
    const restored = restoreAppData()
    notes.push(`应用数据已${restored ? '' : '未'}还原（settings/tasks）；临时目录将删除。`)
    rmSync(TEMP_ROOT, { recursive: true, force: true })
    rmSync(WEBVIEW_DATA_DIR, { recursive: true, force: true })
    console.log('已清理临时目录并还原应用数据')
    console.log(`当前剩余应用实例：${appPids().join(',') || '无'}`)
    try {
      const before = readFileSync(join(EVIDENCE_DIR, 'appdata-backup', 'tasks.json'))
      const after = readFileSync(TASKS_FILE)
      results.record('测试后完整任务文件与备份逐字节一致', before.equals(after), `backupBytes=${before.length}, restoredBytes=${after.length}`)
    } catch (error) {
      results.record('测试后任务数据还原复核', false, String(error.message).slice(0, 300))
    }
  }
  const summary = results.summary('v0.2.0 多根/revision/通知点击真机验收')
  writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, exe: EXE, notes, summary, screenshots: state.screenshots, consoleErrors: state.consoleErrors, pageErrors: state.pageErrors }, null, 2), 'utf8')
  console.log(`结果 JSON：${RESULT_JSON}`)
  for (const note of notes) console.log(`  - ${note}`)
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`\nfeatures 验收异常：${error.message || error}`)
  results.record('features 验收主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('v0.2.0 多根/revision/通知点击真机验收（异常终止）')
  try { writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, notes, fatalError: String(error.stack || error) }, null, 2), 'utf8') } catch { /* ignore */ }
  if (state.client) state.client.close().catch(() => {})
  killOwnApp()
  restoreAppData()
  process.exitCode = 1
})
