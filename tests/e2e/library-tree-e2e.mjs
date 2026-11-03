#!/usr/bin/env node
/**
 * tests/e2e/library-tree-e2e.mjs — v0.1.1「本地模型库目录树」真机验收
 *
 * 用 WebView2 CDP 驱动真实 debug exe（Tauri dev 模式需 vite dev server 在 1420），
 * 在临时测试目录（tests/e2e/library-fixture.mjs 构造，113 文件/124 行）上验收：
 *   树结构 / 聚合统计 / 默认展开策略 / 展开全部与折叠全部 / 单项逐级展开 / 深层目录 /
 *   搜索 / 类型筛选 / 资源管理器 reveal（拦截 open_path 不弹窗）/ 删除确认（取消与确认）/
 *   详情面板（默认宽度 / 1440 内联 / 1100 覆盖抽屉）/ 窗口化 DOM 行数 / 操作耗时 /
 *   0 白屏 / 0 未捕获异常 / 0 控制台错误。
 *
 * 安全约束（本脚本特殊）：
 *   - 不按进程名清场、不 kill 任何非本脚本启动的进程；只用 taskkill /T 结束自己 spawn 的 PID 树；
 *   - WebView2 数据目录用 `WEBVIEW2_USER_DATA_FOLDER` 隔离到 .temp 临时目录，避免与用户实例共用；
 *   - 应用数据（%APPDATA%\com.modeldownload.manager\settings.json/tasks.json）先备份、结束后还原；
 *     下载目录只通过真实 UI 设置页修改/还原，不直接写 settings.json；
 *   - 测试目录写在 %TEMP%\mdm-qa\library-tree\<stamp>，不写用户真实下载目录。
 *
 * 用法：node tests/e2e/library-tree-e2e.mjs [--exe <path>] [--port 9223] [--keep]
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
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, createResults, listTargets, PORT_WEBVIEW2, sleep, waitForEndpoint } from './cdp.mjs'
import { createLibraryFixture, fixtureSummary, removeLibraryFixture } from './library-fixture.mjs'

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
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `library-tree-e2e-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'library-tree-e2e-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const BACKUP_DIR = join(EVIDENCE_DIR, 'appdata-backup')
const TEST_ROOT = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'Temp', 'mdm-qa', 'library-tree', STAMP)
const WEBVIEW_DATA_DIR = join(EVIDENCE_DIR, 'ebwebview')

const results = createResults()
const state = {
  client: null,
  proc: null,
  spawnedPid: null,
  appExitCode: null,
  settingsModified: false,
  originalSettings: null,
  timings: {},
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  notes: [],
  userInstancePidsBefore: [],
  userInstancePidsAfter: [],
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
/* 前端 formatBytes 等价实现（用于与 DOM 文本对照）                     */
/* ------------------------------------------------------------------ */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
function formatBytes(bytes, fractionDigits) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = fractionDigits ?? (unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2)
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

/* ------------------------------------------------------------------ */
/* 进程与应用数据                                                       */
/* ------------------------------------------------------------------ */

function listAppPids() {
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process -Name 'model-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
    { encoding: 'utf8', timeout: 15000 },
  )
  return (result.stdout || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
}

function backupAppData() {
  mkdirSync(BACKUP_DIR, { recursive: true })
  state.appDataBefore = {}
  for (const name of ['settings.json', 'tasks.json']) {
    const source = join(APP_DATA_DIR, name)
    state.appDataBefore[name] = existsSync(source)
      ? { content: readFileSync(source, 'utf8'), mtimeMs: statSync(source).mtimeMs }
      : { content: null, mtimeMs: 0 }
    if (existsSync(source)) copyFileSync(source, join(BACKUP_DIR, name))
  }
}

function restoreAppData() {
  try {
    for (const name of ['settings.json', 'tasks.json']) {
      const target = join(APP_DATA_DIR, name)
      const backup = join(BACKUP_DIR, name)
      const before = state.appDataBefore?.[name]
      if (before?.content === null) rmSync(target, { force: true })
      else if (existsSync(backup)) copyFileSync(backup, target)
    }
  } catch (error) {
    console.warn(`恢复应用数据失败：${error.message}`)
  }
}

async function launchApp() {
  if (!existsSync(EXE)) throw new Error(`应用 exe 不存在：${EXE}`)
  state.userInstancePidsBefore = listAppPids()
  if (state.userInstancePidsBefore.length > 0) {
    console.log(`检测到已有应用实例（不触碰）：${state.userInstancePidsBefore.join(', ')}`)
  }
  // 不使用 9223 端口的其他实例；若端口被占用则直接报错，不 kill 任何进程
  try {
    await listTargets(PORT, 1500)
    throw new Error(`端口 ${PORT} 已有 CDP 实例占用；按安全约束不结束任何进程，请人工处理后重试`)
  } catch (error) {
    if (String(error.message).startsWith(`端口 ${PORT}`)) throw error
    // 端口空闲 → 继续
  }
  mkdirSync(WEBVIEW_DATA_DIR, { recursive: true })
  const logFd = openSync(join(EVIDENCE_DIR, 'app.log'), 'a')
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=*`,
    WEBVIEW2_USER_DATA_FOLDER: WEBVIEW_DATA_DIR,
  }
  console.log(`启动测试实例：${EXE}`)
  console.log(`WEBVIEW2_USER_DATA_FOLDER=${WEBVIEW_DATA_DIR}（与用户实例隔离）`)
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
    if (state.appExitCode !== null) {
      throw new Error(`测试实例启动后退出（code=${state.appExitCode}）；targets=${JSON.stringify(targets.map((t) => t.url))}`)
    }
    await sleep(300)
  }
  throw new Error('未找到测试实例页面 target')
}

async function connectApp(target) {
  const client = await connect(PORT, (item) => item.id === target.id, { timeoutMs: 30000 })
  await client.startCapture()
  await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'Tauri IPC 就绪' })
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照加载完成' })
  return client
}

function killOwnApp() {
  const pid = state.spawnedPid
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 20000 })
    console.log(`已结束本脚本启动的测试实例 PID=${pid}（仅自己的进程树）`)
  } catch (error) {
    console.warn(`结束测试实例失败：${error.message}`)
  }
}

/* ------------------------------------------------------------------ */
/* UI 操作                                                             */
/* ------------------------------------------------------------------ */

async function clickSidebar(client, label) {
  await client.clickByText(label, 'aside nav button, aside button')
  await sleep(350)
}

async function ensureSettingsDir(client, downloadDir) {
  await clickSidebar(client, '设置')
  await client.waitFor('Boolean(document.querySelector("#settings-download-dir"))', {
    timeoutMs: 20000,
    description: '设置页',
  })
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

async function readLibraryState(client) {
  const raw = await client.evaluate(`(() => {
    const rowEls = [...document.querySelectorAll('[role="treeitem"]')];
    const rows = rowEls.map((el) => {
      const cells = [...el.children].map((cell) => (cell.innerText || '').trim());
      const dirButton = el.querySelector('button[aria-label^="打开目录 "]');
      const delButton = el.querySelector('button[aria-label^="删除文件 "]');
      const revealButton = el.querySelector('button[aria-label^="在资源管理器中显示 "]');
      let name = '';
      let path = '';
      if (dirButton) {
        const label = dirButton.getAttribute('aria-label') || '';
        path = label.slice('打开目录 '.length);
        name = cells[0] ? cells[0].replace(/\\s*\\d+\\s*个(?:文件)?\\s*$/, '').trim() : path;
      } else {
        const rowKey = el.getAttribute('data-row-key') || '';
        path = rowKey.startsWith('file:') ? rowKey.slice(5) : '';
        const pathText = el.querySelector('span[aria-describedby]');
        const display = pathText
          ? [...pathText.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent || '').join('').trim()
          : '';
        name = display || path.split('/').pop() || '';
      }
      const countMatch = (cells[0] || '').match(/(\\d+)\\s*个/);
      return {
        level: Number(el.getAttribute('aria-level')),
        expanded: el.getAttribute('aria-expanded'),
        selected: el.getAttribute('aria-selected'),
        kind: dirButton ? 'dir' : 'file',
        isRoot: Number(el.getAttribute('aria-level')) === 1,
        name,
        path,
        dirPath: dirButton ? path : null,
        relativePath: dirButton ? null : path,
        fileCount: countMatch ? Number(countMatch[1]) : null,
        badge: cells[1] || '',
        sizeText: cells[2] || '',
        timeText: cells[3] || '',
        text: el.innerText.slice(0, 300),
      };
    });
    const bodyText = document.body.innerText;
    const pick = (regex) => { const m = bodyText.match(regex); return m ? m[1] : null; };
    const statLabels = ['总占用空间', '模型权重', '投影器 / 矩阵', '配置 / 其他'];
    const stats = statLabels.map((label) => {
      const labelEl = [...document.querySelectorAll('p')].find((p) => (p.textContent || '').trim() === label);
      if (!labelEl || !labelEl.parentElement) return null;
      const box = labelEl.parentElement;
      return {
        label,
        value: box.children[1] ? box.children[1].textContent.trim() : '',
        hint: box.children[2] ? box.children[2].textContent.trim() : '',
      };
    });
    const filterGroup = document.querySelector('[role="group"][aria-label="按文件类型筛选"]');
    const filters = filterGroup
      ? [...filterGroup.querySelectorAll('button')].map((b) => ({ text: b.innerText.trim(), pressed: b.getAttribute('aria-pressed') === 'true' }))
      : [];
    const dialog = document.querySelector('[role="dialog"]');
    return {
      rows,
      domRowCount: rows.length,
      totalRowCount: pick(/当前显示\\s*(\\d+)\\s*行/),
      footerFileCount: pick(/共\\s*(\\d+)\\s*个文件/),
      footerSize: pick(/共\\s*\\d+\\s*个文件[\\s\\S]{0,40}?(\\d+(?:\\.\\d+)?\\s*[KMGT]?B)/),
      dirNodeText: pick(/(\\d+)\\s*个目录节点/),
      hitText: pick(/命中\\s*(\\d+)\\s*个文件/),
      stats,
      filters,
      hasTree: Boolean(document.querySelector('[role="tree"]')),
      hasEmptyFilter: bodyText.includes('没有匹配的文件'),
      bodyTextLength: bodyText.length,
      dialogOpen: Boolean(dialog),
      dialogText: dialog ? dialog.innerText.slice(0, 500) : '',
    };
  })()`)
  // v0.2.0：data-row-key=绝对路径；在 Node 侧统一转换为相对扫描根路径，供匹配与断言使用。
  const baseRoot = String(TEST_ROOT).replace(/\\/g, '/').replace(/\/$/, '')
  for (const row of raw.rows) {
    if (row.kind !== 'file') continue
    const normalized = String(row.path || '').replace(/\\/g, '/')
    row.relativePath = normalized.toLowerCase().startsWith(baseRoot.toLowerCase() + '/')
      ? normalized.slice(baseRoot.length + 1)
      : normalized
    row.name = row.relativePath.split('/').pop() || row.name
  }
  return raw
}

async function waitTreeRows(client, expected, { timeoutMs = 20000, description = `行数=${expected}` } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await readLibraryState(client)
    if (Number(last.totalRowCount) === expected) return last
    await sleep(120)
  }
  throw new Error(`等待 ${description} 超时；当前 footer 行数=${last?.totalRowCount}，命中=${last?.hitText}，files=${last?.footerFileCount}`)
}

async function clickTreeRow(client, matcher) {
  const payload = JSON.stringify(matcher)
  const clicked = await client.evaluate(`(() => {
    const matcher = ${payload};
    const SEP = String.fromCharCode(92);
    const suffixOf = (relative) => (SEP + String(relative).split('/').join(SEP)).toLowerCase();
    const rows = [...document.querySelectorAll('[role="treeitem"]')];
    const target = rows.find((el) => {
      const level = Number(el.getAttribute('aria-level'));
      const dirButton = el.querySelector('button[aria-label^="打开目录 "]');
      const rowKey = (el.getAttribute('data-row-key') || '').toLowerCase();
      if (matcher.kind === 'dir') {
        if (!dirButton) return false;
        if (matcher.root) return level === 1;
        return rowKey.endsWith(suffixOf(matcher.path));
      }
      if (!rowKey.startsWith('file:')) return false;
      return rowKey.endsWith(suffixOf(matcher.relativePath));
    });
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`点击目录树行失败：${JSON.stringify(matcher)}`)
  await sleep(200)
}

async function expandRootRow(client) {
  const clicked = await client.evaluate(`(() => { const el = document.querySelector('[role="treeitem"][aria-level="1"]'); if (!el) return false; el.click(); return true; })()`)
  if (!clicked) throw new Error('点击根节点失败')
  return waitTreeRows(client, 7, { description: '根节点展开（7 行）' })
}

async function collapseAllAndExpandRoot(client) {
  await clickButtonText(client, '折叠全部')
  await waitTreeRows(client, 1, { description: '折叠全部（仅根节点）' })
  return expandRootRow(client)
}

async function clickAria(client, label) {
  const selector = `button[aria-label=${JSON.stringify(label)}]`
  const clicked = await client.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`点击按钮失败：${label}`)
  await sleep(200)
}

async function clickButtonText(client, text) {
  await client.clickByText(text, 'button')
  await sleep(300)
}

async function typeSearch(client, value) {
  await client.type('input[aria-label="搜索文件名或路径"]', value)
  await sleep(350)
}

async function readPanel(client) {
  return client.evaluate(`(() => {
    const panel = document.querySelector('aside[role="complementary"][aria-label="文件详情"]');
    if (!panel) return null;
    const style = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    const backdropEl = [...document.querySelectorAll('div')].find((div) => (div.className || '').toString().includes('z-30'));
    const backdrop = backdropEl ? getComputedStyle(backdropEl).display !== 'none' : false;
    return {
      position: style.position,
      width: Math.round(rect.width),
      top: Math.round(rect.top),
      right: Math.round(window.innerWidth - rect.right),
      text: panel.innerText.slice(0, 1200),
      hasBackdrop: backdrop,
      viewportWidth: window.innerWidth,
    };
  })()`)
}

async function setViewport(client, width, height) {
  await client.setViewport(width, height)
  await sleep(400)
}

async function clearViewport(client) {
  await client.send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)
}

/* ------------------------------------------------------------------ */
/* 断言辅助                                                            */
/* ------------------------------------------------------------------ */

function findRow(rowsState, { kind, path, relativePath, isRoot }) {
  return rowsState.rows.find((row) => {
    if (kind && row.kind !== kind) return false
    if (isRoot !== undefined && row.isRoot !== isRoot) return false
    if (path !== undefined && row.dirPath !== path) return false
    if (relativePath !== undefined && row.relativePath !== relativePath) return false
    return true
  })
}

function statValue(rowsState, label) {
  return rowsState.stats.find((item) => item && item.label === label)?.value ?? null
}

function statHint(rowsState, label) {
  return rowsState.stats.find((item) => item && item.label === label)?.hint ?? null
}

function filterButton(rowsState, labelPrefix) {
  return rowsState.filters.find((item) => item.text.startsWith(labelPrefix)) || null
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  mkdirSync(APP_DATA_DIR, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  console.log(`测试树目录：${TEST_ROOT}`)

  // 阶段 1：构造测试树（113 文件 / 124 行）
  const manifest = createLibraryFixture(TEST_ROOT)
  const summary = fixtureSummary(manifest)
  const expected = {
    files: summary.fileCount,
    bytes: summary.totalBytes,
    kinds: summary.kinds,
    kindBytes: summary.kindBytes,
    dirNodeCount: summary.dirNodeCount,
    topLevelDirs: summary.topLevelDirs,
    initialRows: 1 + 4 + 100 + 1 + 1 + 1 + 2, // v0.2.0 默认展开「根 + 第一层」：根(1)+顶层目录(4)+bulk(100)+DemoLibrary 子(1)+Qwen 子(1)+unsloth 子(1)+根文件(2)
    collapsedRows: 1 + 4 + 2,
    expandedAllRows: summary.expandedAllRowCount,
    formatTotal: formatBytes(summary.totalBytes),
    formatWeight: formatBytes(summary.kindBytes.weight),
    formatMmproj: formatBytes(summary.kindBytes.mmproj),
    formatImatrix: formatBytes(summary.kindBytes.imatrix),
    formatConfig: formatBytes(summary.kindBytes.config),
    formatOther: formatBytes(summary.kindBytes.other),
  }
  results.record(
    '阶段1：测试目录构造完成',
    manifest.totals.files === 113 && manifest.totals.bytes === expected.bytes,
    `${summary.fileCount} 文件 / ${summary.totalBytes}B / 权重${summary.kinds.weight} 配置${summary.kinds.config} 其他${summary.kinds.other} / 展开全部 ${expected.expandedAllRows} 行`,
  )

  backupAppData()
  try {
    // 阶段 2：启动测试实例（与用户实例隔离，不 kill 任何他人进程）
    const target = await launchApp()
    results.record('测试实例启动（9223 CDP + WebView2 数据目录隔离）', true, `spawnedPid=${state.spawnedPid}，已有其他实例=${state.userInstancePidsBefore.join(',') || '无'}`)
    state.client = await connectApp(target)
    const snapshot = await state.client.tauriInvoke('get_snapshot')
    state.originalSettings = await state.client.tauriInvoke('get_settings')
    results.record(
      '真实模式启动（非 mock）',
      !(await state.client.evaluate('document.body.innerText.includes("演示数据")')),
      `appVersion=${snapshot.appVersion} dataDir=${snapshot.dataDir}`,
    )
    results.record(
      '版本号为 0.2.0',
      snapshot.appVersion === '0.2.0',
      `appVersion=${snapshot.appVersion}`,
    )
    results.record('启动前备份应用数据', true, `${BACKUP_DIR}（settings.json/tasks.json）`)

    // 通过真实 UI 设置页修改下载目录（不直接写 settings.json）
    const settings = await ensureSettingsDir(state.client, TEST_ROOT)
    state.settingsModified = true
    results.record('设置页保存下载目录为测试树', settings.downloadDir === TEST_ROOT, TEST_ROOT)

    // 进入本地库并等待扫描完成
    const navStart = Date.now()
    await clickSidebar(state.client, '本地模型库')
    await state.client.waitFor('document.querySelector("h1") && document.querySelector("h1").innerText.trim() === "本地模型库"', {
      timeoutMs: 20000,
      description: '本地模型库页',
    })
    let lib = await waitTreeRows(state.client, expected.initialRows, { description: '扫描完成且默认展开' })
    state.timings.libraryLoadMs = Date.now() - navStart
    results.record(
      '扫描完成：文件数与总大小正确',
      lib.footerFileCount === String(expected.files) && statValue(lib, '总占用空间') === expected.formatTotal,
      `共 ${lib.footerFileCount} 个文件，总占用 ${statValue(lib, '总占用空间')}（期望 ${expected.formatTotal}）`,
    )
    const statChecks = [
      ['总占用空间', expected.formatTotal, `共 ${expected.files} 个文件 · 1 个扫描根`],
      ['模型权重', String(expected.kinds.weight), `合计 ${expected.formatWeight}`],
      ['投影器 / 矩阵', `${expected.kinds.mmproj} / ${expected.kinds.imatrix}`, `${expected.formatMmproj} · ${expected.formatImatrix}`],
      ['配置 / 其他', `${expected.kinds.config} / ${expected.kinds.other}`, `${expected.formatConfig} · ${expected.formatOther}`],
    ]
    const statErrors = statChecks.filter(([label, value, hint]) => {
      const card = statValue(lib, label)
      const cardHint = statHint(lib, label)
      return card !== value || (hint !== null && cardHint !== hint)
    })
    results.record(
      '类型统计正确（总占用/权重/投影器/矩阵/配置/其他）',
      statErrors.length === 0,
      `${statChecks.map(([label, value, hint]) => `${label}=${statValue(lib, label)}（${statHint(lib, label)}，期望 ${value}/${hint}）`).join('；')}`,
    )
    const rootRow = findRow(lib, { kind: 'dir', isRoot: true })
    results.record(
      '根节点存在且显示总文件数/总大小',
      Boolean(rootRow) && rootRow.sizeText === expected.formatTotal && rootRow.text.includes(`${expected.files} 个文件`),
      rootRow ? `name=${rootRow.name} size=${rootRow.sizeText}` : '未找到根节点',
    )
    results.record(
      '默认展开策略：根+第一层+第二层（行数）',
      Number(lib.totalRowCount) === expected.initialRows,
      `当前显示 ${lib.totalRowCount} 行（期望 ${expected.initialRows}）`,
    )
    results.record('窗口化渲染生效（DOM 行数 < 总数）', Number(lib.totalRowCount) > lib.domRowCount && lib.domRowCount < 80, `总行 ${lib.totalRowCount}，DOM ${lib.domRowCount} 行`)
    results.record('无白屏/页面文本正常', lib.bodyTextLength > 500, `${lib.bodyTextLength} chars`)
    await screenshot(state.client, '01-initial-tree')

    // 展开全部 / 折叠全部（耗时与行数）
    const expandStart = Date.now()
    await clickButtonText(state.client, '展开全部')
    lib = await waitTreeRows(state.client, expected.expandedAllRows, { description: '展开全部 124 行' })
    state.timings.expandAllMs = Date.now() - expandStart
    results.record(
      '展开全部：124 行（11 目录 + 113 文件）',
      Number(lib.totalRowCount) === expected.expandedAllRows,
      `行数=${lib.totalRowCount}，耗时 ${state.timings.expandAllMs}ms，DOM 行数=${lib.domRowCount}`,
    )
    results.record('展开全部时窗口化仍生效', lib.domRowCount < 80, `DOM ${lib.domRowCount} / 总 ${lib.totalRowCount}`)
    await screenshot(state.client, '02-expand-all-124')

    // 滚动性能
    const scrollStart = Date.now()
    await state.client.evaluate(`(() => {
      const tree = document.querySelector('[role="tree"]');
      if (!tree) return false;
      tree.scrollTop = tree.scrollHeight;
      tree.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`)
    await sleep(400)
    state.timings.scrollToBottomMs = Date.now() - scrollStart
    lib = await readLibraryState(state.client)
    const bottomRowNames = lib.rows.map((row) => row.name)
    results.record(
      '滚动到底部正常（窗口化更新、无异常）',
      state.timings.scrollToBottomMs < 2000 && lib.bodyTextLength > 500,
      `耗时 ${state.timings.scrollToBottomMs}ms，底部 DOM 行=${bottomRowNames.slice(-3).join(', ')}`,
    )

    const collapseStart = Date.now()
    await clickButtonText(state.client, '折叠全部')
    const collapsedState = await waitTreeRows(state.client, 1, { description: '折叠全部（仅根节点）' })
    state.timings.collapseAllMs = Date.now() - collapseStart
    results.record(
      '折叠全部：仅根节点（v0.2.0 多根树语义）',
      Number(collapsedState.totalRowCount) === 1,
      `行数=${collapsedState.totalRowCount}，耗时 ${state.timings.collapseAllMs}ms`,
    )
    lib = await expandRootRow(state.client)
    // 根展开态（7 行全部渲染）下验证顶层目录与根散落文件
    const topRowsOk = expected.topLevelDirs.every((name) => lib.rows.some((row) => row.kind === 'dir' && row.name === name && !row.isRoot))
    results.record(
      '顶层目录节点存在（unsloth/Qwen/DemoLibrary/bulk）',
      topRowsOk,
      lib.rows.filter((row) => row.kind === 'dir' && !row.isRoot).map((row) => row.name).join(', '),
    )
    const rootFileNames = lib.rows.filter((row) => row.kind === 'file' && row.level === 2).map((row) => (row.relativePath || '').split('/').pop())
    results.record(
      '根目录散落文件在根下',
      ['ggml-model-Q4_K_M.gguf', 'README.md'].every((name) => rootFileNames.includes(name)),
      rootFileNames.join(', '),
    )
    await screenshot(state.client, '03-collapsed')

    // 聚合正确性：折叠态下顶层目录聚合
    const bulkRow = findRow(lib, { kind: 'dir', path: 'bulk' })
    const lingRow = findRow(lib, { kind: 'dir', path: 'DemoLibrary' })
    const qwenRow = findRow(lib, { kind: 'dir', path: 'Qwen' })
    const unslothRow = findRow(lib, { kind: 'dir', path: 'unsloth' })
    const dims = manifest.dirs
    results.record(
      '顶层目录聚合正确（文件数/大小）',
      bulkRow?.fileCount === dims.bulk.fileCount &&
        bulkRow?.sizeText === formatBytes(dims.bulk.totalSize) &&
        lingRow?.fileCount === dims.DemoLibrary.fileCount &&
        lingRow?.sizeText === formatBytes(dims.DemoLibrary.totalSize) &&
        qwenRow?.fileCount === dims.Qwen.fileCount &&
        qwenRow?.sizeText === formatBytes(dims.Qwen.totalSize) &&
        unslothRow?.fileCount === dims.unsloth.fileCount &&
        unslothRow?.sizeText === formatBytes(dims.unsloth.totalSize),
      `bulk=${bulkRow?.fileCount}个/${bulkRow?.sizeText}，DemoLibrary=${lingRow?.fileCount}个/${lingRow?.sizeText}，Qwen=${qwenRow?.fileCount}个/${qwenRow?.sizeText}，unsloth=${unslothRow?.fileCount}个/${unslothRow?.sizeText}`,
    )

    // 单项逐级展开：unsloth → flint-GGUF → assets
    await clickTreeRow(state.client, { kind: 'dir', path: 'unsloth' })
    lib = await waitTreeRows(state.client, expected.collapsedRows + 1, { description: '展开 unsloth' })
    results.record('单项展开：unsloth（+1 行 flint-GGUF）', Boolean(findRow(lib, { kind: 'dir', path: 'unsloth/flint-GGUF' })), `行数=${lib.totalRowCount}`)
    await clickTreeRow(state.client, { kind: 'dir', path: 'unsloth/flint-GGUF' })
    lib = await waitTreeRows(state.client, expected.collapsedRows + 1 + 6, { description: '展开 flint-GGUF' })
    const flintRow = findRow(lib, { kind: 'dir', path: 'unsloth/flint-GGUF' })
    const flintLeafRows = lib.rows.filter((row) => row.kind === 'file' && (row.relativePath || '').startsWith('unsloth/flint-GGUF/') && !(row.relativePath || '').includes('/assets/'))
    results.record(
      '展开 unsloth→flint-GGUF 可见 5 个直接叶子',
      flintRow?.fileCount === 7 && flintLeafRows.length === 5,
      `flint 聚合=${flintRow?.fileCount} 个/${flintRow?.sizeText}，直接叶子=${flintLeafRows.map((row) => row.name).join(', ')}`,
    )
    await clickTreeRow(state.client, { kind: 'dir', path: 'unsloth/flint-GGUF/assets' })
    lib = await waitTreeRows(state.client, expected.collapsedRows + 1 + 6 + 2, { description: '展开 assets' })
    const assetRows = lib.rows.filter((row) => row.kind === 'file' && (row.relativePath || '').includes('/assets/'))
    const assetsRow = findRow(lib, { kind: 'dir', path: 'unsloth/flint-GGUF/assets' })
    results.record(
      '展开 assets 可见 2 个 png（flint-GGUF 共 7 叶子）',
      assetRows.length === 2 && assetsRow?.fileCount === 2 && assetsRow?.sizeText === formatBytes(dims['unsloth/flint-GGUF/assets'].totalSize),
      `assets=${assetRows.map((row) => row.name).join(', ')}（${assetsRow?.sizeText}）`,
    )
    await screenshot(state.client, '04-expand-unsloth')

    // 深层目录链：先折叠，DemoLibrary → Nova → models → x
    await collapseAllAndExpandRoot(state.client)
    await clickTreeRow(state.client, { kind: 'dir', path: 'DemoLibrary' })
    lib = await waitTreeRows(state.client, expected.collapsedRows + 1, { description: '展开 DemoLibrary' })
    await clickTreeRow(state.client, { kind: 'dir', path: 'DemoLibrary/Nova' })
    lib = await waitTreeRows(state.client, expected.collapsedRows + 2, { description: '展开 Nova' })
    await clickTreeRow(state.client, { kind: 'dir', path: 'DemoLibrary/Nova/models' })
    lib = await waitTreeRows(state.client, expected.collapsedRows + 3, { description: '展开 models' })
    await clickTreeRow(state.client, { kind: 'dir', path: 'DemoLibrary/Nova/models/x' })
    lib = await waitTreeRows(state.client, expected.collapsedRows + 4, { description: '展开 x' })
    const deepFile = findRow(lib, { kind: 'file', relativePath: 'DemoLibrary/Nova/models/x/model-00001-of-00004.safetensors' })
    const deepRow = findRow(lib, { kind: 'dir', path: 'DemoLibrary/Nova/models/x' })
    results.record(
      '深层目录 DemoLibrary/Nova/models/x 展开可见 safetensors 叶子',
      Boolean(deepFile) && deepRow?.fileCount === 1 && deepRow?.sizeText === formatBytes(dims['DemoLibrary/Nova/models/x'].totalSize),
      `${deepFile?.name}，x 聚合=${deepRow?.fileCount} 个/${deepRow?.sizeText}`,
    )

    // 搜索
    await collapseAllAndExpandRoot(state.client)
    const searchStart = Date.now()
    await typeSearch(state.client, 'flint')
    lib = await waitTreeRows(state.client, 11, { timeoutMs: 10000, description: '搜索 flint 自动展开' })
    state.timings.searchMs = Date.now() - searchStart
    const flintHits = lib.hitText ? Number(lib.hitText) : null
    const searchRows = lib.rows
    results.record(
      '搜索 flint：路径命中的文件全部自动展开可见',
      flintHits === 7 && searchRows.filter((row) => row.kind === 'file').length === 7 && lib.filters.every((item) => !item.pressed || item.text.startsWith('全部')),
      `命中 ${lib.hitText} 个（路径含 flint 的 7 个文件），行数=${lib.totalRowCount}，耗时 ${state.timings.searchMs}ms`,
    )
    await screenshot(state.client, '05-search-flint')
    await typeSearch(state.client, 'zzz-not-exist')
    await state.client.waitFor('document.body.innerText.includes("没有匹配的文件")', { timeoutMs: 10000, description: '搜索无结果空态' })
    results.record('搜索无结果显示空态「没有匹配的文件」', true, '')
    await clickButtonText(state.client, '清除筛选')
    lib = await waitTreeRows(state.client, expected.collapsedRows, { description: '清除搜索后恢复折叠态' })
    results.record('清除筛选恢复正常', Number(lib.totalRowCount) === expected.collapsedRows && !lib.hasEmptyFilter, `行数=${lib.totalRowCount}`)

    // 类型筛选（v0.1.3：6 类，bulk/.dat 与 .gguf_file 等新分类）
    await clickButtonText(state.client, '权重')
    lib = await waitTreeRows(state.client, 116, { description: '权重筛选' })
    results.record(
      `类型筛选：权重 ${expected.kinds.weight} 个文件`,
      Number(lib.hitText) === expected.kinds.weight && statValue(lib, '模型权重') === String(expected.kinds.weight),
      `命中 ${lib.hitText}，行数=${lib.totalRowCount}`,
    )
    await screenshot(state.client, '06-filter-weight')
    await clickButtonText(state.client, '矩阵')
    lib = await waitTreeRows(state.client, 4, { description: '矩阵筛选' })
    results.record(`类型筛选：矩阵 ${expected.kinds.imatrix} 个文件`, Number(lib.hitText) === expected.kinds.imatrix, `命中 ${lib.hitText}，行数=${lib.totalRowCount}`)
    await clickButtonText(state.client, '配置')
    lib = await waitTreeRows(state.client, 9, { description: '配置筛选' })
    results.record(`类型筛选：配置 ${expected.kinds.config} 个文件`, Number(lib.hitText) === expected.kinds.config, `命中 ${lib.hitText}，行数=${lib.totalRowCount}`)
    await clickButtonText(state.client, '其他')
    lib = await waitTreeRows(state.client, 6, { description: '其他筛选' })
    results.record(`类型筛选：其他 ${expected.kinds.other} 个文件`, Number(lib.hitText) === expected.kinds.other, `命中 ${lib.hitText}，行数=${lib.totalRowCount}`)
    results.record(
      '类型筛选按钮计数正确（全部/权重/投影器/矩阵/配置/其他）',
      (filterButton(lib, '全部')?.text || '').replace(/\s+/g, ' ').trim() === `全部 ${expected.files}` &&
        (filterButton(lib, '权重')?.text || '').replace(/\s+/g, ' ').trim() === `权重 ${expected.kinds.weight}` &&
        (filterButton(lib, '投影器')?.text || '').replace(/\s+/g, ' ').trim() === `投影器 ${expected.kinds.mmproj}` &&
        (filterButton(lib, '矩阵')?.text || '').replace(/\s+/g, ' ').trim() === `矩阵 ${expected.kinds.imatrix}` &&
        (filterButton(lib, '配置')?.text || '').replace(/\s+/g, ' ').trim() === `配置 ${expected.kinds.config}` &&
        (filterButton(lib, '其他')?.text || '').replace(/\s+/g, ' ').trim() === `其他 ${expected.kinds.other}`,
      lib.filters.map((item) => item.text.replace(/\s+/g, ' ')).join(' | '),
    )
    await clickButtonText(state.client, '清除筛选')
    await waitTreeRows(state.client, expected.collapsedRows)

    // 行操作：reveal 按钮可用性
    // 注：Tauri 注入的 window.__TAURI_INTERNALS__.invoke 属性为 non-writable/non-configurable，
    // 无法 monkey-patch 拦截；为避免真实弹出资源管理器窗口干扰用户，这里只做按钮存在性/可用性静态验证。
    const revealWire = await state.client.evaluate(`(() => {
      const fileBtn = document.querySelector('button[aria-label="在资源管理器中显示 README.md"]');
      const dirBtn = document.querySelector('button[aria-label="打开目录 bulk"]');
      return {
        file: fileBtn ? { title: fileBtn.getAttribute('title'), disabled: Boolean(fileBtn.disabled) } : null,
        dir: dirBtn ? { title: dirBtn.getAttribute('title'), disabled: Boolean(dirBtn.disabled) } : null,
      };
    })()`)
    results.record(
      '行操作 reveal 按钮存在且可用（文件/目录；为避免弹窗未实际点击）',
      Boolean(revealWire?.file) && revealWire.file.title === '在资源管理器中显示' && !revealWire.file.disabled &&
        Boolean(revealWire?.dir) && revealWire.dir.title === '打开目录' && !revealWire.dir.disabled,
      `文件按钮=${JSON.stringify(revealWire?.file)}，目录按钮=${JSON.stringify(revealWire?.dir)}`,
    )
    state.notes.push(
      'reveal（在资源管理器中显示/打开目录）无法在 CDP 层拦截：Tauri 的 window.__TAURI_INTERNALS__.invoke 为 non-writable/non-configurable，覆盖会静默失败并真实弹窗；为避免干扰用户，本轮以「按钮存在/title/可用性」静态验证代替实际点击。',
    )

    // 展开 bulk 供删除用例（100 个文件）
    await clickTreeRow(state.client, { kind: 'dir', path: 'bulk' })
    lib = await waitTreeRows(state.client, expected.collapsedRows + 100, { description: '展开 bulk' })

    // 删除：取消（无副作用）
    const deleteTarget = 'bulk/bulk-001.dat'
    const deleteTargetAbs = join(TEST_ROOT, 'bulk', 'bulk-001.dat')
    await clickAria(state.client, '删除文件 bulk-001.dat')
    await state.client.waitFor('Boolean(document.querySelector(\'[role="dialog"]\'))', { timeoutMs: 10000, description: '删除确认对话框' })
    const dialog = await readLibraryState(state.client)
    results.record('删除确认对话框出现且提示磁盘路径', dialog.dialogOpen && dialog.dialogText.includes('删除本地文件？') && dialog.dialogText.includes('bulk-001.dat'), '')
    await screenshot(state.client, '07-delete-dialog')
    await state.client.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const btn = dialog ? [...dialog.querySelectorAll('button')].find((item) => item.innerText.trim() === '取消') : null;
      if (btn) { btn.click(); return true; }
      return false;
    })()`)
    await state.client.waitFor('!document.querySelector(\'[role="dialog"]\')', { timeoutMs: 10000, description: '取消删除' })
    await sleep(300)
    lib = await readLibraryState(state.client)
    results.record(
      '取消删除无副作用（磁盘/树/统计不变）',
      existsSync(deleteTargetAbs) && lib.footerFileCount === String(expected.files) &&
        lib.rows.some((row) => row.relativePath === deleteTarget),
      `磁盘存在=${existsSync(deleteTargetAbs)}，文件数=${lib.footerFileCount}`,
    )

    // 删除：确认（磁盘文件消失、树移除、统计更新）
    await clickAria(state.client, '删除文件 bulk-001.dat')
    await state.client.waitFor('Boolean(document.querySelector(\'[role="dialog"]\'))', { timeoutMs: 10000, description: '删除确认对话框（第二次）' })
    await state.client.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const btn = dialog ? [...dialog.querySelectorAll('button')].find((item) => item.innerText.trim() === '删除文件') : null;
      if (btn) { btn.click(); return true; }
      return false;
    })()`)
    await state.client.waitFor(`document.body.innerText.includes("共 ${expected.files - 1} 个文件") && !document.querySelector('[role="dialog"]')`, {
      timeoutMs: 20000,
      description: '删除完成',
    })
    await sleep(400)
    lib = await readLibraryState(state.client)
    const bulkAfter = findRow(lib, { kind: 'dir', path: 'bulk' })
    const expectedBytesAfterDelete = expected.bytes - 1024
    results.record(
      '确认删除：文件从磁盘删除且树/统计同步',
      !existsSync(deleteTargetAbs) &&
        lib.footerFileCount === String(expected.files - 1) &&
        !lib.rows.some((row) => row.relativePath === deleteTarget) &&
        bulkAfter?.fileCount === 99 &&
        statValue(lib, '总占用空间') === formatBytes(expectedBytesAfterDelete),
      `磁盘删除=${!existsSync(deleteTargetAbs)}，文件数=${lib.footerFileCount}，bulk=${bulkAfter?.fileCount} 个，总占用=${statValue(lib, '总占用空间')}（期望 ${formatBytes(expectedBytesAfterDelete)}）`,
    )
    await screenshot(state.client, '08-after-delete')

    // 详情面板（默认宽度 1320 实际表现 + 1440 内联 + 1100 覆盖抽屉）
    await collapseAllAndExpandRoot(state.client)
    await clickTreeRow(state.client, { kind: 'file', relativePath: 'README.md' })
    await state.client.waitFor('Boolean(document.querySelector(\'aside[role="complementary"][aria-label="文件详情"]\'))', {
      timeoutMs: 10000,
      description: '详情面板',
    })
    const panelDefault = await readPanel(state.client)
    results.record(
      '详情面板显示文件信息（名称/大小/相对路径/完整路径/删除按钮）',
      Boolean(panelDefault) &&
        panelDefault.text.includes('README.md') &&
        panelDefault.text.includes('2.00 KB') &&
        panelDefault.text.includes('README.md') &&
        panelDefault.text.includes(join(TEST_ROOT, 'README.md')) &&
        panelDefault.text.includes('在资源管理器中显示') &&
        panelDefault.text.includes('删除文件'),
      `默认视口 ${panelDefault?.viewportWidth}px，position=${panelDefault?.position}，width=${panelDefault?.width}px`,
    )
    await screenshot(state.client, '09-detail-default-1320')
    await setViewport(state.client, 1440, 900)
    const panel1440 = await readPanel(state.client)
    results.record(
      '详情面板 1440 宽度为内联（非覆盖）',
      panel1440?.position === 'static' && panel1440?.hasBackdrop === false,
      `position=${panel1440?.position}，width=${panel1440?.width}px，viewport=${panel1440?.viewportWidth}`,
    )
    await screenshot(state.client, '10-detail-1440')
    await setViewport(state.client, 1100, 800)
    const panel1100 = await readPanel(state.client)
    results.record(
      '详情面板 1100 宽度为覆盖式抽屉（含遮罩）',
      panel1100?.position === 'fixed' && panel1100?.hasBackdrop === true,
      `position=${panel1100?.position}，width=${panel1100?.width}px，viewport=${panel1100?.viewportWidth}，backdrop=${panel1100?.hasBackdrop}`,
    )
    await screenshot(state.client, '11-detail-1100-drawer')
    await clearViewport(state.client)
    await clickAria(state.client, '关闭文件详情')
    await state.client.waitFor('!document.querySelector(\'aside[role="complementary"][aria-label="文件详情"]\')', {
      timeoutMs: 10000,
      description: '关闭详情面板',
    })
    results.record('详情面板可关闭', true, '')

    // 无异常/控制台错误
    state.pageErrors = state.client.pageErrors.slice()
    state.consoleErrors = state.client.consoleErrors.slice()
    results.record('无未捕获页面异常（Runtime.exceptionThrown）', state.pageErrors.length === 0, `${state.pageErrors.length} 个`)
    const ignored = (item) =>
      /favicon/i.test(item.text) || /Failed to load resource: the server responded with a status of 404/.test(item.text) || /DevTools/.test(item.text)
    const realErrors = state.consoleErrors.filter((item) => !ignored(item))
    results.record('无控制台错误', realErrors.length === 0, realErrors.map((item) => item.text).join(' | ').slice(0, 600))
    results.record(
      '页面无白屏',
      (await state.client.evaluate('document.body.innerText.length')) > 500,
      '',
    )
    results.record('操作耗时记录（初载/展开全部/折叠全部/搜索/滚动）', true, JSON.stringify(state.timings))
  } finally {
    // 设置还原（通过真实 UI）+ 应用数据还原 + 清理，绝不触碰用户进程
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
    await sleep(1500)
    restoreAppData()
    console.log(`已还原应用数据（settings.json/tasks.json）`)
    if (!options.keep) {
      const removed = removeLibraryFixture(TEST_ROOT)
      console.log(`已清理测试树目录：${TEST_ROOT}（${removed}）`)
      rmSync(WEBVIEW_DATA_DIR, { recursive: true, force: true })
    } else {
      console.log(`--keep：保留测试树目录 ${TEST_ROOT}`)
    }
    state.userInstancePidsAfter = listAppPids()
    console.log(`当前剩余应用实例（应为空或仅有用户实例）：${state.userInstancePidsAfter.join(', ') || '无'}`)
  }

  const summaryResult = results.summary('v0.2.0 本地库目录树回归验收')
  const report = {
    stamp: STAMP,
    exe: EXE,
    testRoot: TEST_ROOT,
    expected,
    timings: state.timings,
    screenshots: state.screenshots,
    consoleErrors: state.consoleErrors,
    pageErrors: state.pageErrors,
    notes: state.notes,
    userInstancePidsBefore: state.userInstancePidsBefore,
    userInstancePidsAfter: state.userInstancePidsAfter,
    summary: summaryResult,
  }
  writeFileSync(RESULT_JSON, JSON.stringify(report, null, 2), 'utf8')
  console.log(`结果 JSON：${RESULT_JSON}`)
  process.exitCode = summaryResult.failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`\n本地库目录树验收异常：${error.message || error}`)
  results.record('本地库目录树验收主流程', false, String(error.message || error).slice(0, 800))
  const summaryResult = results.summary('v0.2.0 本地库目录树回归验收（异常终止）')
  try {
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary: summaryResult, timings: state.timings, fatalError: String(error.stack || error) }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  if (state.client) state.client.close().catch(() => {})
  killOwnApp()
  restoreAppData()
  try {
    removeLibraryFixture(TEST_ROOT)
  } catch {
    /* ignore */
  }
  process.exitCode = 1
})
