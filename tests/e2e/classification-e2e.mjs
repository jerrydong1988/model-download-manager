#!/usr/bin/env node
/**
 * tests/e2e/classification-e2e.mjs — v0.1.2 文件分类扩展（weight/mmproj/imatrix/config/other）真机验收
 *
 * 用 WebView2 CDP 驱动真实 debug exe（9223 + WEBVIEW2_USER_DATA_FOLDER 隔离；vite dev server 需在 1420）：
 *  A. 本地模型库：临时目录放 10 个分类样本文件，断言每行徽章、6 个筛选 chips 计数、
 *     5 张统计卡数值全部与磁盘/后端 scan_library 分类一致；
 *  B. 浏览仓库真实数据（hf-mirror）：
 *     - ggml-org/Qwen2.5-VL-7B-Instruct-GGUF（7 文件，2 mmproj）：徽章/筛选计数/头部统计/
 *       默认勾选（权重+投影器）/「全选模型文件」；
 *     - unsloth/Qwen2.5-VL-7B-Instruct-GGUF（33 文件，3 mmproj + 1 imatrix）：默认不勾选 imatrix。
 *
 * 安全约束：不 kill 任何非本脚本进程；只结束自己 spawn 的 PID 树；应用数据备份→还原；
 * 下载目录只通过真实设置页 UI 修改/还原；测试目录写 %TEMP%，测后清理。
 *
 * 用法：node tests/e2e/classification-e2e.mjs [--exe <path>] [--port 9223] [--keep]
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
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `classification-e2e-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'classification-e2e-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const BACKUP_DIR = join(EVIDENCE_DIR, 'appdata-backup')
const TEST_ROOT = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'Temp', 'mdm-qa', 'classification', STAMP)
const WEBVIEW_DATA_DIR = join(EVIDENCE_DIR, 'ebwebview')

const results = createResults()
const state = {
  client: null,
  proc: null,
  spawnedPid: null,
  appExitCode: null,
  settingsModified: false,
  originalSettings: null,
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  timings: {},
}

const screenshot = (client, name) =>
  client
    .screenshot(join(EVIDENCE_DIR, 'shots', `${name}.png`))
    .then((info) => {
      state.screenshots.push(info.path)
      return info.path
    })
    .catch((error) => {
      console.warn(`截图失败 ${name}: ${error.message}`)
      return null
    })

/* ------------------------------------------------------------------ */
/* 分类期望（与后端 util::classify_file v0.1.2 规则一致，用于断言）        */
/* ------------------------------------------------------------------ */

const KIND_LABEL = { weight: '权重', mmproj: '投影器', imatrix: '权重矩阵', config: '配置', other: '其他' }

/** 本地库分类样本：文件名 → 期望类型/大小。 */
const LIBRARY_SAMPLES = [
  { name: 'mmproj-Qwen3.8-Flash-Next-f16.gguf', kind: 'mmproj', size: 1_048_576 },
  { name: 'clip_vision_model.safetensors', kind: 'mmproj', size: 524_288 },
  { name: 'imatrix_unsloth.gguf_file', kind: 'imatrix', size: 262_144 },
  { name: 'qwen38-flash-next-mtp.hgn', kind: 'weight', size: 131_072 },
  { name: 'model.gguf', kind: 'weight', size: 2_097_152 },
  { name: 'model.safetensors', kind: 'weight', size: 3_145_728 },
  { name: 'mmproj_config.json', kind: 'config', size: 2_048 },
  { name: 'convert_mmproj_to_gguf.py', kind: 'config', size: 4_096 },
  { name: 'README.md', kind: 'config', size: 1_024 },
  { name: 'image.png', kind: 'other', size: 65_536 },
]

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

function summarizeSamples(samples) {
  const summary = {
    files: samples.length,
    bytes: 0,
    kinds: { weight: 0, mmproj: 0, imatrix: 0, config: 0, other: 0 },
    kindBytes: { weight: 0, mmproj: 0, imatrix: 0, config: 0, other: 0 },
  }
  for (const item of samples) {
    summary.bytes += item.size
    summary.kinds[item.kind] += 1
    summary.kindBytes[item.kind] += item.size
  }
  return summary
}

/* ------------------------------------------------------------------ */
/* 进程/应用数据                                                        */
/* ------------------------------------------------------------------ */

function listAppPids() {
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process -Name 'model-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
    { encoding: 'utf8', timeout: 15000 },
  )
  return (result.stdout || '').split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0)
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

function killOwnApp() {
  if (!state.spawnedPid) return
  try {
    spawnSync('taskkill', ['/PID', String(state.spawnedPid), '/T', '/F'], { encoding: 'utf8', timeout: 20000 })
    console.log(`已结束本脚本启动的测试实例 PID=${state.spawnedPid}`)
  } catch (error) {
    console.warn(`结束测试实例失败：${error.message}`)
  }
}

async function launchApp() {
  if (!existsSync(EXE)) throw new Error(`应用 exe 不存在：${EXE}`)
  const existing = listAppPids()
  if (existing.length > 0) console.log(`检测到已有应用实例（不触碰）：${existing.join(', ')}`)
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
  console.log(`启动测试实例：${EXE}`)
  state.proc = spawn(EXE, [], { env, stdio: ['ignore', logFd, logFd], windowsHide: false })
  state.spawnedPid = state.proc.pid
  state.proc.on('exit', (code, signal) => {
    state.appExitCode = code
    console.log(`测试实例退出：code=${code} signal=${signal}`)
  })
  await waitForEndpoint(PORT, { timeoutMs: 60000, label: 'WebView2 DevTools' })
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const targets = await listTargets(PORT).catch(() => [])
    const target = targets.find((item) => /tauri\.localhost|tauri:\/\/|localhost:1420/.test(item.url || ''))
    if (target) return target
    if (state.appExitCode !== null) throw new Error(`测试实例启动后退出（code=${state.appExitCode}）`)
    await sleep(300)
  }
  throw new Error('未找到测试实例页面 target')
}

async function connectApp(target) {
  const client = await connect(PORT, (item) => item.id === target.id, { timeoutMs: 30000 })
  await client.startCapture()
  await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'Tauri IPC' })
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照加载' })
  return client
}

/* ------------------------------------------------------------------ */
/* 页面操作与 DOM 读取                                                  */
/* ------------------------------------------------------------------ */

async function clickSidebar(client, label) {
  await client.clickByText(label, 'aside nav button, aside button')
  await sleep(350)
}

async function ensureSettingsDir(client, downloadDir) {
  await clickSidebar(client, '设置')
  await client.waitFor('Boolean(document.querySelector("#settings-download-dir"))', { timeoutMs: 20000, description: '设置页' })
  await client.type('#settings-download-dir', downloadDir)
  await client.clickByText('保存设置')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const current = await client.tauriInvoke('get_settings')
    if (current.downloadDir === downloadDir) return current
    await sleep(250)
  }
  throw new Error(`设置下载目录超时：${downloadDir}`)
}

/** 读取本地库页：树行（含分类徽章）、筛选 chips、统计卡、footer。 */
async function readLibraryState(client) {
  return client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')].map((el) => {
      const cells = [...el.children].map((cell) => (cell.innerText || '').trim());
      const rowKey = el.getAttribute('data-row-key') || '';
      return {
        level: Number(el.getAttribute('aria-level')),
        isDir: Boolean(el.querySelector('button[aria-label^="打开目录 "]')),
        relativePath: (() => { const dirBtn = el.querySelector('button[aria-label^="打开目录 "]'); if (dirBtn) return (dirBtn.getAttribute('aria-label') || '').slice('打开目录 '.length); return rowKey.startsWith('file:') ? rowKey.slice(5) : ''; })(),
        name: (() => { const pt = el.querySelector('span[aria-describedby]'); if (!pt) return cells[0] || ''; return [...pt.childNodes].filter((n) => n.nodeType === 3).map((n) => (n.textContent || '').trim()).join(''); })(),
        badge: cells[1] || '',
        sizeText: cells[2] || '',
        text: el.innerText.replace(/\\s+/g, ' ').slice(0, 200),
      };
    });
    const bodyText = document.body.innerText;
    const pick = (regex) => { const m = bodyText.match(regex); return m ? m[1] : null; };
    const labels = ['总占用空间', '模型权重', '投影器 / 矩阵', '配置 / 其他'];
    const stats = labels.map((label) => {
      const labelEl = [...document.querySelectorAll('p')].find((p) => (p.textContent || '').trim() === label);
      if (!labelEl || !labelEl.parentElement) return null;
      const box = labelEl.parentElement;
      return { label, value: box.children[1] ? box.children[1].textContent.trim() : '', hint: box.children[2] ? box.children[2].textContent.trim() : '' };
    });
    const group = document.querySelector('[role="group"][aria-label="按文件类型筛选"]');
    const filters = group ? [...group.querySelectorAll('button')].map((b) => ({ text: b.innerText.replace(/\\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed') === 'true' })) : [];
    return {
      rows,
      filters,
      stats,
      footerFiles: pick(/共\\s*(\\d+)\\s*个文件/),
      hitText: pick(/命中\\s*(\\d+)\\s*个文件/),
      bodyLength: bodyText.length,
      hasTree: Boolean(document.querySelector('[role="tree"]')),
      hasError: Boolean(document.querySelector('[role="alert"]')),
    };
  })()`)
}

async function waitLibraryFiles(client, expectedCount, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await readLibraryState(client)
    if (Number(last.footerFiles) === expectedCount) return last
    await sleep(150)
  }
  throw new Error(`等待本地库扫描 ${expectedCount} 文件超时；当前 footer=${last?.footerFiles}，stats=${JSON.stringify(last?.stats)}`)
}

async function clickFilterChip(client, labelPrefix) {
  const clicked = await client.evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="按文件类型筛选"]');
    if (!group) return false;
    const btn = [...group.querySelectorAll('button')].find((b) => b.innerText.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(labelPrefix)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`点击类型筛选失败：${labelPrefix}`)
  await sleep(350)
}

/** 读取仓库详情页文件表：行徽章 + 勾选状态 + 筛选 chips + 头部文案。 */
async function readDetailState(client) {
  return client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('input[aria-label^="选择 "]')].map((input) => {
      const row = input.parentElement;
      const cells = row ? [...row.children] : [];
      const name = ((input.getAttribute('aria-label') || '').replace('选择 ', '')).split('/').pop();
      return {
        path: (input.getAttribute('aria-label') || '').replace('选择 ', ''),
        name,
        badge: cells[2] ? cells[2].innerText.trim() : '',
        checked: input.checked,
        disabled: input.disabled,
      };
    });
    const group = document.querySelector('[role="group"][aria-label="按文件类型筛选"]');
    const filters = group ? [...group.querySelectorAll('button')].map((b) => ({ text: b.innerText.replace(/\\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed') === 'true' })) : [];
    const bodyText = document.body.innerText;
    const headerMatch = bodyText.match(/共\\s*(\\d+)\\s*个文件\\s*·\\s*权重\\s*(\\d+)(?:\\s*·\\s*投影器\\s*(\\d+))?/);
    const selectedMatch = bodyText.match(/已选\\s*(\\d+)\\s*个文件/);
    return {
      rows,
      filters,
      header: headerMatch ? { total: Number(headerMatch[1]), weight: Number(headerMatch[2]), mmproj: headerMatch[3] ? Number(headerMatch[3]) : 0 } : null,
      selectedCount: selectedMatch ? Number(selectedMatch[1]) : null,
      bodyLength: bodyText.length,
      hasErrorBanner: Boolean(document.querySelector('[role="alert"]')),
      allModelButton: [...document.querySelectorAll('button')].some((b) => b.innerText.includes('全选模型文件')),
    };
  })()`)
}

async function openRepoDetail(client, repoId, source = 'huggingface') {
  const base = await client.evaluate('location.origin + location.pathname')
  await client.navigate(`${base}?repo=${encodeURIComponent(repoId)}&source=${source}`)
  await client.waitFor(`document.body.innerText.includes(${JSON.stringify(repoId)})`, { timeoutMs: 45000, description: '仓库详情加载' })
  await client.waitFor('document.querySelectorAll(\'input[aria-label^="选择 "]\').length > 0', { timeoutMs: 45000, description: '文件表渲染' })
  await sleep(500)
}

/**
 * 汇总文件表全部行（FileTable 固定行高 + 虚拟滚动，只渲染可视区 + 缓冲）。
 * 通过滚动表格容器收集所有行，按 path 去重。
 */
async function collectDetailRows(client) {
  const findScroller = `(() => {
    let el = document.querySelector('input[aria-label^="选择 "]');
    while (el) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return null;
  })()`
  const readRows = `(() => [...document.querySelectorAll('input[aria-label^="选择 "]')].map((input) => {
    const row = input.parentElement;
    const cells = row ? [...row.children] : [];
    return {
      path: (input.getAttribute('aria-label') || '').replace('选择 ', ''),
      name: (input.getAttribute('aria-label') || '').replace('选择 ', '').split('/').pop(),
      badge: cells[2] ? cells[2].innerText.trim() : '',
      checked: input.checked,
    };
  }))()`
  const seen = new Map()
  for (let guard = 0; guard < 200; guard += 1) {
    const rows = await client.evaluate(readRows)
    for (const row of rows) seen.set(row.path, row)
    const info = await client.evaluate(`(() => { const sc = ${findScroller}; if (!sc) return null; return { scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight }; })()`)
    if (!info) break
    if (info.scrollTop + info.clientHeight >= info.scrollHeight - 2) break
    await client.evaluate(`(() => {
      const sc = ${findScroller};
      if (!sc) return false;
      sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(80, Math.floor(sc.clientHeight * 0.8)));
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`)
    await sleep(150)
  }
  // 复位到顶部，避免影响后续截图/交互
  await client.evaluate(`(() => { const sc = ${findScroller}; if (sc) { sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll', { bubbles: true })); } return true; })()`)
  await sleep(200)
  return [...seen.values()]
}

async function clickButtonText(client, text) {
  await client.clickByText(text, 'button')
  await sleep(400)
}

/* ------------------------------------------------------------------ */
/* 用例 A：本地模型库分类                                              */
/* ------------------------------------------------------------------ */

async function runLibraryClassification(client) {
  console.log('\n──────── A. 本地模型库分类验收 ────────')
  const expected = summarizeSamples(LIBRARY_SAMPLES)
  const settings = await ensureSettingsDir(client, TEST_ROOT)
  state.settingsModified = true
  results.record('设置页保存下载目录为分类测试目录', settings.downloadDir === TEST_ROOT, TEST_ROOT)

  await clickSidebar(client, '本地模型库')
  await client.waitFor('document.querySelector("h1") && document.querySelector("h1").innerText.trim() === "本地模型库"', {
    timeoutMs: 20000,
    description: '本地模型库页',
  })
  const lib = await waitLibraryFiles(client, expected.files)
  results.record('扫描完成：文件数与总占用正确', lib.footerFiles === String(expected.files) && lib.stats[0]?.value === formatBytes(expected.bytes), `共 ${lib.footerFiles} 个文件，总占用 ${lib.stats[0]?.value}（期望 ${formatBytes(expected.bytes)}）`)

  // 1) 分类徽章
  const fileRows = lib.rows.filter((row) => !row.isDir)
  const badgeErrors = []
  for (const sample of LIBRARY_SAMPLES) {
    const row = fileRows.find((item) => (item.relativePath || '').split(/[\\\\/]/).pop() === sample.name)
    if (!row) badgeErrors.push(`${sample.name}: 行缺失`)
    else if (row.badge !== KIND_LABEL[sample.kind]) badgeErrors.push(`${sample.name}: 徽章=${row.badge}，期望=${KIND_LABEL[sample.kind]}`)
  }
  results.record(
    '每个样本文件的分类徽章正确',
    badgeErrors.length === 0,
    badgeErrors.length === 0
      ? LIBRARY_SAMPLES.map((item) => `${item.name.trim()}=${KIND_LABEL[item.kind]}`).join('，').slice(0, 500)
      : badgeErrors.join('；'),
  )

  // 2) 后端 scan_library 返回的 kind 与期望一致（直接验证后端分类）
  const backendFiles = await client.tauriInvoke('scan_library')
  const backendKinds = new Map((backendFiles || []).map((file) => [file.name, file.kind]))
  const backendErrors = LIBRARY_SAMPLES.filter((item) => backendKinds.get(item.name) !== item.kind).map(
    (item) => `${item.name}: scan_library=${backendKinds.get(item.name) || '缺失'}，期望=${item.kind}`,
  )
  results.record('后端 scan_library 分类与契约一致', backendErrors.length === 0, backendErrors.join('；') || `${backendFiles.length} 个文件分类全部正确`)

  // 3) 6 个筛选 chips 计数
  const expectedFilters = [
    ['全部', expected.files],
    ['权重', expected.kinds.weight],
    ['投影器', expected.kinds.mmproj],
    ['矩阵', expected.kinds.imatrix],
    ['配置', expected.kinds.config],
    ['其他', expected.kinds.other],
  ]
  const filterErrors = expectedFilters.filter(([label, count]) => {
    const chip = lib.filters.find((item) => item.text.startsWith(label))
    return !chip || chip.text !== `${label} ${count}`
  })
  results.record(
    '6 个类型筛选 chips 计数正确（全部/权重/投影器/矩阵/配置/其他）',
    filterErrors.length === 0 && lib.filters.length === 6,
    lib.filters.map((item) => item.text).join(' | '),
  )

  // 4) 4 张统计卡
  const stat = (label) => lib.stats.find((item) => item?.label === label)
  const statChecks = [
    ['总占用空间', formatBytes(expected.bytes), `共 ${expected.files} 个文件 · 1 个扫描根`],
    ['模型权重', String(expected.kinds.weight), `合计 ${formatBytes(expected.kindBytes.weight)}`],
    ['投影器 / 矩阵', `${expected.kinds.mmproj} / ${expected.kinds.imatrix}`, `${formatBytes(expected.kindBytes.mmproj)} · ${formatBytes(expected.kindBytes.imatrix)}`],
    ['配置 / 其他', `${expected.kinds.config} / ${expected.kinds.other}`, `${formatBytes(expected.kindBytes.config)} · ${formatBytes(expected.kindBytes.other)}`],
  ]
  const statErrors = statChecks.filter(([label, value, hint]) => {
    const card = stat(label)
    if (!card || card.value !== value) return true
    if (hint !== null && card.hint !== hint) return true
    return false
  })
  results.record(
    '4 张统计卡数值与磁盘一致',
    statErrors.length === 0,
    (lib.stats || []).map((card) => (card ? `${card.label}=${card.value}（${card.hint}）` : 'null')).join(' | ').slice(0, 600),
  )

  // 5) 每个筛选 chips 的实际命中行为
  const filterBehavior = []
  for (const key of ['weight', 'mmproj', 'imatrix', 'config', 'other']) {
    const label = KIND_LABEL[key] === '权重矩阵' ? '矩阵' : KIND_LABEL[key]
    await clickFilterChip(client, label)
    const filtered = await readLibraryState(client)
    const expectedNames = LIBRARY_SAMPLES.filter((item) => item.kind === key).map((item) => item.name).sort()
    const actualNames = filtered.rows.filter((row) => !row.isDir).map((row) => (row.relativePath || '').split(/[\\\\/]/).pop()).sort()
    const ok =
      Number(filtered.hitText) === expected.kinds[key] &&
      actualNames.length === expectedNames.length &&
      expectedNames.every((name) => actualNames.includes(name))
    filterBehavior.push({ key, ok, hit: filtered.hitText, names: actualNames })
    if (key === 'mmproj') await screenshot(client, '01-library-filter-mmproj')
    await clickButtonText(client, '清除筛选')
    await waitLibraryFiles(client, expected.files)
  }
  results.record(
    '各类型筛选命中文件集正确（投影器/矩阵/配置/其他/权重）',
    filterBehavior.every((item) => item.ok),
    filterBehavior.map((item) => `${item.key}:${item.hit}`).join('，'),
  )

  // 6) 恢复全量视图并截图
  const finalLib = await readLibraryState(client)
  results.record('筛选清除后恢复全部 10 个文件', finalLib.footerFiles === String(expected.files) && finalLib.rows.filter((row) => !row.isDir).length === expected.files, `行数=${finalLib.rows.length}`)
  results.record('本地库页无错误横幅/无白屏', !finalLib.hasError && finalLib.bodyLength > 500, `${finalLib.bodyLength} chars`)
  await screenshot(client, '02-library-classification')

  state.timings.libraryLoadMs = 0
  return { lib: finalLib, expected, backendFiles }
}

/* ------------------------------------------------------------------ */
/* 用例 B：真实仓库分类                                                */
/* ------------------------------------------------------------------ */

function countKinds(files) {
  const counts = { weight: 0, mmproj: 0, imatrix: 0, config: 0, other: 0 }
  for (const file of files) counts[file.kind] += 1
  return counts
}

async function runRepoClassification(client, repoId, expects, { screenshotPrefix }) {
  console.log(`\n──────── B. 真实仓库分类：${repoId} ────────`)
  await openRepoDetail(client, repoId)
  const detail = await client.tauriInvoke('get_repo_detail', { source: 'huggingface', repoId })
  const kinds = countKinds(detail.files)
  const expectedTotal = Object.values(kinds).reduce((sum, value) => sum + value, 0)
  const backendMatches =
    detail.files.length === expects.total &&
    kinds.weight === expects.weight &&
    kinds.mmproj === expects.mmproj &&
    kinds.imatrix === expects.imatrix &&
    kinds.config === expects.config &&
    kinds.other === expects.other
  results.record(
    `[${repoId}] get_repo_detail 分类与预期一致`,
    backendMatches,
    `共 ${detail.files.length} 文件（期望 ${expects.total}）：权重 ${kinds.weight}/${expects.weight}、投影器 ${kinds.mmproj}/${expects.mmproj}、矩阵 ${kinds.imatrix}/${expects.imatrix}、配置 ${kinds.config}/${expects.config}、其他 ${kinds.other}/${expects.other}`,
  )

  let dom = await readDetailState(client)
  const allRows = await collectDetailRows(client)
  results.record(
    `[${repoId}] 文件行「投影器」徽章数量正确`,
    allRows.filter((row) => row.badge === '投影器').length === expects.mmproj && allRows.length === expects.total,
    `采集 ${allRows.length}/${expects.total} 行；投影器徽章=${allRows.filter((row) => row.badge === '投影器').length}（期望 ${expects.mmproj}）；徽章分布=${JSON.stringify(allRows.reduce((acc, row) => ((acc[row.badge] = (acc[row.badge] || 0) + 1), acc), {}))}`,
  )
  results.record(
    `[${repoId}] 头部统计（共 N 个文件 · 权重 X · 投影器 Y）`,
    Boolean(dom.header) && dom.header.total === expects.total && dom.header.weight === expects.weight && dom.header.mmproj === expects.mmproj,
    dom.header ? `共 ${dom.header.total} 个文件 · 权重 ${dom.header.weight} · 投影器 ${dom.header.mmproj}` : '未解析到头部统计',
  )
  const expectedFilters = [
    ['全部', expects.total],
    ['权重', expects.weight],
    ['投影器', expects.mmproj],
    ['矩阵', expects.imatrix],
    ['配置', expects.config],
    ['其他', expects.other],
  ]
  const filterErrors = expectedFilters.filter(([label, count]) => {
    const chip = dom.filters.find((item) => item.text.startsWith(label))
    return !chip || chip.text !== `${label} ${count}`
  })
  results.record(
    `[${repoId}] 6 个筛选 chips 计数正确`,
    filterErrors.length === 0 && dom.filters.length === 6,
    dom.filters.map((item) => item.text).join(' | '),
  )

  // 默认勾选 = 权重 + 投影器
  const defaultSelected = allRows.filter((row) => row.checked).map((row) => row.path).sort()
  const expectedSelectedCategories = detail.files
    .filter((file) => file.kind === 'weight' || file.kind === 'mmproj')
    .map((file) => file.path)
    .sort()
  results.record(
    `[${repoId}] 默认勾选包含权重+投影器且数量正确`,
    defaultSelected.length === expectedSelectedCategories.length && expectedSelectedCategories.every((path) => defaultSelected.includes(path)),
    `默认勾选 ${defaultSelected.length} 个（期望 ${expectedSelectedCategories.length}：权重 ${expects.weight} + 投影器 ${expects.mmproj}）；已选文案=${dom.selectedCount}`,
  )
  results.record(
    `[${repoId}] 默认不勾选 imatrix/config/other`,
    allRows.filter((row) => row.checked && !['权重', '投影器'].includes(row.badge)).length === 0,
    allRows.filter((row) => row.checked).map((row) => `${row.name}:${row.badge}`).join(', ').slice(0, 300),
  )
  await screenshot(client, `${screenshotPrefix}-detail`)

  // 清空选择 → 全选模型文件（权重+投影器）
  await clickButtonText(client, '清空选择')
  dom = await readDetailState(client)
  results.record(`[${repoId}] 清空选择生效`, dom.selectedCount === 0, `已选=${dom.selectedCount}`)
  await clickButtonText(client, '全选模型文件')
  dom = await readDetailState(client)
  const modelRows = await collectDetailRows(client)
  const modelSelected = modelRows.filter((row) => row.checked).map((row) => row.path).sort()
  results.record(
    `[${repoId}] 「全选模型文件」选中权重+投影器（含 mmproj、排除 imatrix）`,
    modelSelected.length === expectedSelectedCategories.length && expectedSelectedCategories.every((path) => modelSelected.includes(path)),
    `全选后已选 ${modelSelected.length} 个（文案 ${dom.selectedCount}）；含投影器=${modelRows.filter((row) => row.checked && row.badge === '投影器').length}；含 imatrix=${modelRows.filter((row) => row.checked && row.badge === '权重矩阵').length}`,
  )

  // 投影器筛选
  await clickFilterChip(client, '投影器')
  const filtered = await readDetailState(client)
  results.record(
    `[${repoId}] 投影器筛选只显示 mmproj 文件`,
    filtered.rows.length === expects.mmproj && filtered.rows.every((row) => row.badge === '投影器'),
    `筛选后 ${filtered.rows.length} 行：${filtered.rows.map((row) => row.name).join(', ').slice(0, 300)}`,
  )
  await screenshot(client, `${screenshotPrefix}-mmproj-filter`)
  await clickFilterChip(client, '全部')

  // 无异常
  results.record(
    `[${repoId}] 页面无错误横幅/无白屏`,
    !filtered.hasErrorBanner && filtered.bodyLength > 500,
    `${filtered.bodyLength} chars`,
  )
  return { detail, kinds, dom }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  mkdirSync(TEST_ROOT, { recursive: true })
  mkdirSync(APP_DATA_DIR, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  console.log(`分类测试目录：${TEST_ROOT}`)
  results.record('应用 exe 存在', existsSync(EXE), EXE)
  if (!existsSync(EXE)) {
    const summary = results.summary('v0.1.2 文件分类真机验收（缺少前置构建）')
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary }, null, 2), 'utf8')
    process.exitCode = 1
    return
  }

  const expectedSummary = summarizeSamples(LIBRARY_SAMPLES)
  // 构造分类测试文件
  for (const sample of LIBRARY_SAMPLES) {
    const path = join(TEST_ROOT, sample.name)
    const buffer = Buffer.alloc(sample.size)
    const seed = sample.name.length % 251
    for (let offset = 0; offset < sample.size; offset += 1) buffer[offset] = (seed + offset) % 256
    writeFileSync(path, buffer)
  }
  results.record(
    '分类测试目录构造完成（10 个样本）',
    LIBRARY_SAMPLES.length === 10 && expectedSummary.files === 10,
    `权重 ${expectedSummary.kinds.weight} / 投影器 ${expectedSummary.kinds.mmproj} / 矩阵 ${expectedSummary.kinds.imatrix} / 配置 ${expectedSummary.kinds.config} / 其他 ${expectedSummary.kinds.other}，共 ${formatBytes(expectedSummary.bytes)}`,
  )

  backupAppData()
  try {
    const target = await launchApp()
    results.record('测试实例启动（9223 + WebView2 数据目录隔离）', true, `spawnedPid=${state.spawnedPid}`)
    state.client = await connectApp(target)
    const snapshot = await state.client.tauriInvoke('get_snapshot')
    state.originalSettings = await state.client.tauriInvoke('get_settings')
    results.record(
      '真实模式启动 / 版本号',
      snapshot.appVersion === '0.2.0' && !(await state.client.evaluate('document.body.innerText.includes("演示数据")')),
      `appVersion=${snapshot.appVersion}（期望 0.2.0）`,
    )

    const libraryResult = await runLibraryClassification(state.client)
    state.libraryResult = libraryResult

    // 恢复设置（前往浏览页前还原，避免影响真实仓库用例）
    if (state.originalSettings) {
      await ensureSettingsDir(state.client, state.originalSettings.downloadDir)
      results.record('设置还原为原下载目录（真实 UI）', true, state.originalSettings.downloadDir)
      state.settingsModified = false
    }

    const ggml = await runRepoClassification(
      state.client,
      'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF',
      { total: 7, weight: 3, mmproj: 2, imatrix: 0, config: 1, other: 1 },
      { screenshotPrefix: '03-ggml' },
    )
    const unsloth = await runRepoClassification(
      state.client,
      'unsloth/Qwen2.5-VL-7B-Instruct-GGUF',
      { total: 33, weight: 26, mmproj: 3, imatrix: 1, config: 2, other: 1 },
      { screenshotPrefix: '04-unsloth' },
    )

    // 全局无异常
    state.pageErrors = state.client.pageErrors.slice()
    state.consoleErrors = state.client.consoleErrors.slice()
    results.record('无未捕获页面异常（Runtime.exceptionThrown）', state.pageErrors.length === 0, `${state.pageErrors.length} 个`)
    const ignored = (item) =>
      /favicon/i.test(item.text) || /Failed to load resource: the server responded with a status of 404/.test(item.text) || /DevTools/.test(item.text)
    const realErrors = state.consoleErrors.filter((item) => !ignored(item))
    results.record('无控制台错误', realErrors.length === 0, realErrors.map((item) => item.text).join(' | ').slice(0, 600))
    results.record(
      '浏览页无白屏',
      (await state.client.evaluate('document.body.innerText.length')) > 500,
      '',
    )

    writeFileSync(
      join(EVIDENCE_DIR, 'classification-data.json'),
      JSON.stringify(
        {
          library: { expected: expectedSummary, filters: libraryResult.lib.filters, stats: libraryResult.lib.stats },
          ggml: { kinds: ggml.kinds, files: ggml.detail.files.map((f) => ({ path: f.path, kind: f.kind })) },
          unsloth: { kinds: unsloth.kinds, files: unsloth.detail.files.map((f) => ({ path: f.path, kind: f.kind })) },
        },
        null,
        2,
      ),
      'utf8',
    )
  } finally {
    if (state.client && state.settingsModified && state.originalSettings) {
      try {
        await ensureSettingsDir(state.client, state.originalSettings.downloadDir)
        results.record('设置还原为原下载目录（真实 UI）', true, state.originalSettings.downloadDir)
      } catch (error) {
        results.record('设置还原为原下载目录（真实 UI）', false, String(error.message).slice(0, 300))
      }
    }
    if (state.client) await state.client.close().catch(() => {})
    killOwnApp()
    await sleep(1200)
    restoreAppData()
    console.log('已还原应用数据（settings.json/tasks.json）')
    rmSync(TEST_ROOT, { recursive: true, force: true })
    rmSync(WEBVIEW_DATA_DIR, { recursive: true, force: true })
    console.log(`已清理测试目录与临时 WebView2 数据：${TEST_ROOT}`)
    console.log(`当前剩余应用实例：${listAppPids().join(', ') || '无'}`)
  }

  const summary = results.summary('v0.1.3 文件分类回归验收')
  const report = {
    stamp: STAMP,
    exe: EXE,
    testRoot: TEST_ROOT,
    timings: state.timings,
    screenshots: state.screenshots,
    consoleErrors: state.consoleErrors,
    pageErrors: state.pageErrors,
    summary,
  }
  writeFileSync(RESULT_JSON, JSON.stringify(report, null, 2), 'utf8')
  console.log(`结果 JSON：${RESULT_JSON}`)
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`\n分类验收异常：${error.message || error}`)
  results.record('分类验收主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('v0.1.3 文件分类回归验收（异常终止）')
  try {
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, fatalError: String(error.stack || error) }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  if (state.client) state.client.close().catch(() => {})
  killOwnApp()
  restoreAppData()
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exitCode = 1
})
