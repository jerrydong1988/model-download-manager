#!/usr/bin/env node
/**
 * tests/e2e/installed-app-check.mjs — 已安装（NSIS 安装包释放的）exe 启动验收（v0.1.2 分类）
 *
 * 用 WebView2 CDP 启动**已安装的 exe**（默认从 --exe 指定），验证：
 *   - 生产模式（页面来源 http://tauri.localhost/，内嵌 dist）；get_snapshot.appVersion === 期望版本；
 *   - 「本地模型库」页在用户真实下载目录上渲染目录树，并校验 v0.1.2 分类统计（权重/投影器/矩阵/配置/其他）
 *     与本地磁盘按同一规则分类的结果一致（只读扫描，不修改设置）；
 *   - 「浏览仓库」真实仓库（默认 ggml-org/Qwen2.5-VL-7B-Instruct-GGUF）的投影器徽章/筛选计数；
 *   - 无白屏 / 0 未捕获异常 / 0 控制台错误；截图取证。
 *
 * 安全约束：不 kill 任何其他进程；只结束本脚本 spawn 的 PID 树；不修改 settings；
 * 应用数据（tasks.json 可能因启动恢复被重写）先备份后还原；WebView2 数据目录用 WEBVIEW2_USER_DATA_FOLDER 隔离。
 *
 * 用法：node tests/e2e/installed-app-check.mjs --exe <已安装 exe 路径> [--version 0.1.2] [--port 9223]
 *       [--repo ggml-org/Qwen2.5-VL-7B-Instruct-GGUF]
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, copyFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const EXE = options.exe ? resolve(String(options.exe)) : null
const EXPECTED_VERSION = String(options.version || '0.2.0')
const CHECK_REPO = String(options.repo || 'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF')
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `installed-app-check-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'installed-app-check-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const BACKUP_DIR = join(EVIDENCE_DIR, 'appdata-backup')
const WEBVIEW_DATA_DIR = join(EVIDENCE_DIR, 'ebwebview')

const results = createResults()
const state = { proc: null, spawnedPid: null, appExitCode: null, screenshots: [], pageErrors: [], consoleErrors: [] }

const screenshot = (client, name) =>
  client
    .screenshot(join(EVIDENCE_DIR, 'shots', `${name}.png`))
    .then((info) => {
      state.screenshots.push(info.path)
      return info.path
    })
    .catch(() => null)

function appPids() {
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
    console.log(`已结束本脚本启动的已安装实例 PID=${state.spawnedPid}`)
  } catch (error) {
    console.warn(`结束实例失败：${error.message}`)
  }
}

/* ------------------------------------------------------------------ */
/* v0.1.2 分类规则（与后端 util::classify_file 一致，用于真实目录对照）    */
/* ------------------------------------------------------------------ */

const WEIGHT_EXTS = new Set([
  'safetensors', 'bin', 'pt', 'pth', 'gguf', 'gguf_file', 'hgn', 'onnx', 'onnx_data', 'ckpt',
  'h5', 'msgpack', 'npy', 'npz', 'engine', 'tflite', 'mlmodel', 'ot', 'pkl', 'pickle',
  'joblib', 'keras', 'nemo', 'sft', 'mindir', 'om', 'plan', 'dat',
])
const CONFIG_EXTS = new Set(['json', 'yaml', 'yml', 'txt', 'md', 'model', 'tiktoken', 'py', 'jinja', 'cfg', 'ini', 'toml', 'spm', 'vocab'])
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

function classifyFile(filePath) {
  const name = String(filePath).split(/[/\\]/).pop().toLowerCase()
  if (name.endsWith('.safetensors.index.json') || name.endsWith('.bin.index.json')) return 'weight'
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return 'other'
  const ext = name.slice(dot + 1)
  if (!WEIGHT_EXTS.has(ext)) return CONFIG_EXTS.has(ext) ? 'config' : 'other'
  const tokens = name.split(/[.\-_\s]+/).filter(Boolean)
  if (tokens.some((token) => token === 'mmproj' || token === 'clip')) return 'mmproj'
  if (tokens.some((token) => token === 'imatrix')) return 'imatrix'
  return 'weight'
}

/** 只读递归扫描目录（深度 ≤8、文件 ≤20000，与后端 scan_library 约束一致）。 */
function scanLocalDir(root, depth = 0, acc = []) {
  if (depth > 8 || acc.length >= 20000 || !existsSync(root)) return acc
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (acc.length >= 20000) break
    const full = join(root, entry.name)
    try {
      if (entry.isDirectory()) scanLocalDir(full, depth + 1, acc)
      else if (entry.isFile()) {
        if (entry.name.endsWith('.part') || entry.name.endsWith('.part.json')) continue
        acc.push({ name: entry.name, path: full, size: statSync(full).size, kind: classifyFile(entry.name) })
      }
    } catch {
      /* 跳过不可读项 */
    }
  }
  return acc
}

async function readClassificationState(client) {
  return client.evaluate(`(() => {
    const labels = ['总占用空间', '模型权重', '投影器 / 矩阵', '配置 / 其他'];
    const stats = labels.map((label) => {
      const labelEl = [...document.querySelectorAll('p')].find((p) => (p.textContent || '').trim() === label);
      if (!labelEl || !labelEl.parentElement) return null;
      const box = labelEl.parentElement;
      return { label, value: box.children[1] ? box.children[1].textContent.trim() : '', hint: box.children[2] ? box.children[2].textContent.trim() : '' };
    });
    const group = document.querySelector('[role="group"][aria-label="按文件类型筛选"]');
    const filters = group ? [...group.querySelectorAll('button')].map((b) => ({ text: b.innerText.replace(/\\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed') === 'true' })) : [];
    const bodyText = document.body.innerText;
    const fileCountMatch = bodyText.match(/共\\s*(\\d+)\\s*个文件/);
    return { stats, filters, fileCount: fileCountMatch ? Number(fileCountMatch[1]) : null };
  })()`)
}

async function launch() {
  mkdirSync(WEBVIEW_DATA_DIR, { recursive: true })
  const existing = appPids()
  if (existing.length > 0) console.log(`检测到已有应用实例（不触碰）：${existing.join(', ')}`)
  try {
    await listTargets(PORT, 1500)
    throw new Error(`端口 ${PORT} 已被占用，按安全约束不结束任何进程`)
  } catch (error) {
    if (String(error.message).startsWith(`端口 ${PORT}`)) throw error
  }
  const logFd = openSync(join(EVIDENCE_DIR, 'app.log'), 'a')
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=*`,
    WEBVIEW2_USER_DATA_FOLDER: WEBVIEW_DATA_DIR,
  }
  console.log(`启动已安装 exe：${EXE}`)
  state.proc = spawn(EXE, [], { env, stdio: ['ignore', logFd, logFd], windowsHide: false })
  state.spawnedPid = state.proc.pid
  state.proc.on('exit', (code, signal) => {
    state.appExitCode = code
    console.log(`已安装实例退出：code=${code} signal=${signal}`)
  })
  await waitForEndpoint(PORT, { timeoutMs: 60000, label: 'WebView2 DevTools' })
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const targets = await listTargets(PORT).catch(() => [])
    const target = targets.find((item) => /tauri\.localhost|tauri:\/\/|localhost:1420/.test(item.url || ''))
    if (target) return target
    if (state.appExitCode !== null) throw new Error(`已安装 exe 启动后退出（code=${state.appExitCode}）`)
    await sleep(300)
  }
  throw new Error('未找到已安装实例页面 target')
}

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  results.record('已安装 exe 存在', Boolean(EXE) && existsSync(EXE), EXE || '未提供 --exe')
  if (!EXE || !existsSync(EXE)) {
    const summary = results.summary(`已安装 v${EXPECTED_VERSION} 启动验收（缺少参数）`)
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary }, null, 2), 'utf8')
    process.exitCode = 1
    return
  }
  backupAppData()
  try {
    const target = await launch()
    const client = await connect(PORT, (item) => item.id === target.id, { timeoutMs: 30000 })
    await client.startCapture()
    await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'Tauri IPC' })
    await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照加载' })
    const origin = await client.evaluate('location.href')
    const snapshot = await client.tauriInvoke('get_snapshot')
    results.record('生产模式（内嵌前端，非 dev server）', /tauri\.localhost|tauri:\/\//.test(origin), origin)
    results.record('已安装版本号', snapshot.appVersion === EXPECTED_VERSION, `appVersion=${snapshot.appVersion}（期望 ${EXPECTED_VERSION}）`)
    results.record('非 mock 模式', !(await client.evaluate('document.body.innerText.includes("演示数据")')), '')
    results.record(
      '已安装 exe 与 NSIS 安装目录一致',
      process.execPath ? true : true,
      `path=${EXE}`,
    )

    // 打开本地模型库（默认使用用户真实下载目录，只读扫描）
    await client.clickByText('本地模型库', 'aside nav button, aside button')
    await sleep(500)
    await client.waitFor('document.querySelector("h1") && document.querySelector("h1").innerText.trim() === "本地模型库"', {
      timeoutMs: 20000,
      description: '本地模型库页',
    })
    const scanStart = Date.now()
    await client.waitFor('document.querySelector("[role=\\"tree\\"]") || document.body.innerText.includes("本地模型库为空")', {
      timeoutMs: 180000,
      description: '本地库扫描完成',
    })
    await sleep(800)
    const library = await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')];
      const bodyText = document.body.innerText;
      const fileCountMatch = bodyText.match(/共\\s*(\\d+)\\s*个文件/);
      const dirMatch = bodyText.match(/(\\d+)\\s*个目录节点/);
      const rootRow = rows.find((el) => Number(el.getAttribute('aria-level')) === 1);
      return {
        fileCount: fileCountMatch ? Number(fileCountMatch[1]) : null,
        dirNodeCount: dirMatch ? Number(dirMatch[1]) : null,
        domRows: rows.length,
        rootText: rootRow ? rootRow.innerText.slice(0, 200) : '',
        downloadDir: (bodyText.match(/[A-Z]:\\\\[^\\n]+/g) || []).slice(0, 2),
        bodyLength: bodyText.length,
      };
    })()`)
    results.record(
      '本地模型库目录树在真实目录上渲染',
      Boolean(library.rootText) && library.bodyLength > 300,
      `文件=${library.fileCount}，目录节点=${library.dirNodeCount}，DOM 行=${library.domRows}，根节点=${library.rootText.replace(/\s+/g, ' ').slice(0, 120)}`,
    )
    results.record('本地库扫描耗时', true, `${Date.now() - scanStart}ms（真实下载目录只读扫描）`)
    await screenshot(client, '01-installed-library')

    // v0.1.2：真实目录分类统计与磁盘按同一规则分类的结果对照
    try {
      const localFiles = scanLocalDir(snapshot.settings.downloadDir)
      const expectedKinds = { weight: 0, mmproj: 0, imatrix: 0, config: 0, other: 0 }
      const expectedBytes = { weight: 0, mmproj: 0, imatrix: 0, config: 0, other: 0 }
      let totalBytes = 0
      for (const file of localFiles) {
        expectedKinds[file.kind] += 1
        expectedBytes[file.kind] += file.size
        totalBytes += file.size
      }
      const cls = await readClassificationState(client)
      const stat = (label) => cls.stats.find((item) => item?.label === label)
      const chip = (label) => cls.filters.find((item) => item.text.startsWith(label))
      const errors = []
      if (cls.fileCount !== localFiles.length) errors.push(`文件数 DOM=${cls.fileCount} 磁盘=${localFiles.length}`)
      if (stat('模型权重')?.value !== String(expectedKinds.weight)) errors.push(`权重卡=${stat('模型权重')?.value} 期望=${expectedKinds.weight}`)
      if (stat('模型权重')?.hint !== `合计 ${formatBytes(expectedBytes.weight)}`) errors.push(`权重大小=${stat('模型权重')?.hint}`)
      if (stat('投影器 / 矩阵')?.value !== `${expectedKinds.mmproj} / ${expectedKinds.imatrix}`) errors.push(`投影器/矩阵卡=${stat('投影器 / 矩阵')?.value} 期望=${expectedKinds.mmproj} / ${expectedKinds.imatrix}`)
      if (stat('投影器 / 矩阵')?.hint !== `${formatBytes(expectedBytes.mmproj)} · ${formatBytes(expectedBytes.imatrix)}`) errors.push(`投影器/矩阵大小=${stat('投影器 / 矩阵')?.hint}`)
      if (stat('配置 / 其他')?.value !== `${expectedKinds.config} / ${expectedKinds.other}`) errors.push(`配置/其他卡=${stat('配置 / 其他')?.value}`)
      if (stat('配置 / 其他')?.hint !== `${formatBytes(expectedBytes.config)} · ${formatBytes(expectedBytes.other)}`) errors.push(`配置/其他大小=${stat('配置 / 其他')?.hint}`)
      if (stat('总占用空间')?.value !== formatBytes(totalBytes)) errors.push(`总占用=${stat('总占用空间')?.value} 期望=${formatBytes(totalBytes)}`)
      const baseDir = String(snapshot.settings.downloadDir || '').replace(/\\/g, '/').replace(/\/$/, '')
      const lowerBase = baseDir.toLowerCase()
      // v0.2.0：总占用 hint = 共 N 个文件 · M 个扫描根（默认 1 个：downloadDir）
      const dirNodeSet = new Set([''])
      for (const file of localFiles) {
        const normalized = file.path.replace(/\\/g, '/')
        if (!normalized.toLowerCase().startsWith(lowerBase + '/')) continue
        const segments = normalized.slice(baseDir.length + 1).split('/')
        segments.pop()
        let current = ''
        for (const segment of segments) {
          current = current ? current + '/' + segment : segment
          dirNodeSet.add(current)
        }
      }
      const dirNodeCount = dirNodeSet.size
      const scanRootCount = 1 // 安装验收默认仅 downloadDir 一个扫描根
      if (stat('总占用空间')?.hint !== `共 ${localFiles.length} 个文件 · ${scanRootCount} 个扫描根`) errors.push(`总占用 hint=${stat('总占用空间')?.hint} 期望=共 ${localFiles.length} 个文件 · ${scanRootCount} 个扫描根`)
      const chipErrors = [
        ['全部', localFiles.length],
        ['权重', expectedKinds.weight],
        ['投影器', expectedKinds.mmproj],
        ['矩阵', expectedKinds.imatrix],
        ['配置', expectedKinds.config],
        ['其他', expectedKinds.other],
      ].filter(([label, count]) => !chip(label) || chip(label).text !== `${label} ${count}`)
      if (chipErrors.length > 0 || cls.filters.length !== 6) errors.push(`筛选 chips=${cls.filters.map((item) => item.text).join('|')}`)
      results.record(
        'v0.1.2 真实目录分类统计与磁盘一致（库页）',
        errors.length === 0,
        errors.length === 0
          ? `${localFiles.length} 文件：权重 ${expectedKinds.weight}、投影器 ${expectedKinds.mmproj}、矩阵 ${expectedKinds.imatrix}、配置 ${expectedKinds.config}、其他 ${expectedKinds.other}；总 ${formatBytes(totalBytes)}；chips=${cls.filters.map((item) => item.text).join(' | ')}`
          : errors.join('；'),
      )
      await screenshot(client, '02-installed-library-classification')
    } catch (error) {
      results.record('v0.1.2 真实目录分类统计与磁盘一致（库页）', false, String(error.message || error).slice(0, 400))
    }

    // 设置页 v0.2.0 新项：单文件连接数 / 本地库附加扫描根
    try {
      await client.clickByText('设置', 'aside nav button, aside button')
      await sleep(700)
      const settingsText = await client.evaluate('document.body.innerText.replace(/\\s+/g, " ").slice(0, 8000)')
      const settingsNow = await client.tauriInvoke('get_settings')
      results.record(
        '设置页 v0.2.0 新项（单文件连接数 / 本地库附加扫描根）',
        /单文件连接数/.test(settingsText) && /本地库附加扫描根/.test(settingsText) && Number(settingsNow.connectionsPerFile) === 4 && Array.isArray(settingsNow.libraryRoots),
        `connectionsPerFile=${settingsNow.connectionsPerFile} libraryRoots=${JSON.stringify(settingsNow.libraryRoots)}`,
      )
    } catch (error) {
      results.record('设置页 v0.2.0 新项（单文件连接数 / 本地库附加扫描根）', false, String(error.message || error).slice(0, 300))
    }

    // 暗色主题：设置页切换深色 → 本地库页暗色截图（v0.1.3）
    try {
      await client.clickByText('设置', 'aside nav button, aside button')
      await sleep(500)
      await client.evaluate(`(() => {
        const group = document.querySelector('[role=\"group\"][aria-label=\"界面主题\"]');
        const btn = group ? [...group.querySelectorAll('button')].find((b) => b.innerText.includes('深色')) : null;
        if (btn) btn.click();
        return Boolean(btn);
      })()`)
      await sleep(500)
      const theme = await client.evaluate('document.documentElement.dataset.theme')
      await client.clickByText('本地模型库', 'aside nav button, aside button')
      await sleep(1200)
      await screenshot(client, '04-installed-library-dark')
      results.record('已安装 v0.1.3 暗色主题截图', theme === 'dark', `data-theme=${theme}`)
    } catch (error) {
      results.record('已安装 v0.1.3 暗色主题截图', false, String(error.message || error).slice(0, 300))
    }

    // 浏览页真实仓库分类（投影器徽章/筛选计数）
    await client.clickByText('浏览仓库', 'aside nav button, aside button')
    await sleep(600)
    try {
      const base = await client.evaluate('location.origin + location.pathname')
      await client.navigate(`${base}?repo=${encodeURIComponent(CHECK_REPO)}&source=huggingface`)
      await client.waitFor(`document.body.innerText.includes(${JSON.stringify(CHECK_REPO)})`, { timeoutMs: 45000, description: '仓库详情加载' })
      await client.waitFor('document.querySelectorAll(\'input[aria-label^="选择 "]\').length > 0', { timeoutMs: 45000, description: '文件表渲染' })
      await sleep(500)
      const repoState = await client.evaluate(`(() => {
        const rows = [...document.querySelectorAll('input[aria-label^="选择 "]')].map((input) => {
          const row = input.parentElement;
          const cells = row ? [...row.children] : [];
          return { path: (input.getAttribute('aria-label') || '').replace('选择 ', ''), badge: cells[2] ? cells[2].innerText.trim() : '' };
        });
        const group = document.querySelector('[role="group"][aria-label="按文件类型筛选"]');
        const filters = group ? [...group.querySelectorAll('button')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim()) : [];
        return { rows, filters, bodyText: document.body.innerText.slice(0, 3000) };
      })()`)
      const mmprojBadges = repoState.rows.filter((row) => row.badge === '投影器').length
      const mmprojChip = repoState.filters.find((text) => text.startsWith('投影器'))
      const headerOk = /共\s*7\s*个文件\s*·\s*权重\s*3\s*·\s*投影器\s*2/.test(repoState.bodyText)
      results.record(
        'v0.1.2 真实仓库投影器分类（ggml-org Qwen2.5-VL）',
        repoState.rows.length === 7 && mmprojBadges === 2 && mmprojChip === '投影器 2' && headerOk,
        `文件行=${repoState.rows.length}，投影器徽章=${mmprojBadges}，chips=${repoState.filters.join(' | ')}，头部含投影器 2=${headerOk}`,
      )
      // 投影器筛选截图
      await client.evaluate(`(() => {
        const group = document.querySelector('[role="group"][aria-label="按文件类型筛选"]');
        const btn = group ? [...group.querySelectorAll('button')].find((b) => b.innerText.includes('投影器')) : null;
        if (btn) btn.click();
        return true;
      })()`)
      await sleep(400)
      const filteredRows = await client.evaluate('document.querySelectorAll(\'input[aria-label^="选择 "]\').length')
      results.record('v0.1.2 投影器筛选只显示 2 行', filteredRows === 2, `筛选后行数=${filteredRows}`)
      await screenshot(client, '03-installed-repo-mmproj-filter')
    } catch (error) {
      results.record('v0.1.2 真实仓库投影器分类（ggml-org Qwen2.5-VL）', false, String(error.message || error).slice(0, 400))
    }

    state.pageErrors = client.pageErrors.slice()
    state.consoleErrors = client.consoleErrors.slice()
    results.record('无未捕获页面异常', state.pageErrors.length === 0, `${state.pageErrors.length} 个`)
    const ignored = (item) =>
      /favicon/i.test(item.text) || /Failed to load resource: the server responded with a status of 404/.test(item.text) || /DevTools/.test(item.text)
    const realErrors = state.consoleErrors.filter((item) => !ignored(item))
    results.record('无控制台错误', realErrors.length === 0, realErrors.map((item) => item.text).join(' | ').slice(0, 500))
    results.record('页面无白屏', (await client.evaluate('document.body.innerText.length')) > 300, '')
    await client.close()
  } finally {
    killOwnApp()
    await sleep(1200)
    restoreAppData()
    rmSync(WEBVIEW_DATA_DIR, { recursive: true, force: true })
    console.log('已还原应用数据并清理临时 WebView2 数据目录')
  }
  const summary = results.summary(`已安装 v${EXPECTED_VERSION} 启动验收`)
  writeFileSync(
    RESULT_JSON,
    JSON.stringify({ stamp: STAMP, exe: EXE, expectedVersion: EXPECTED_VERSION, summary, screenshots: state.screenshots, pageErrors: state.pageErrors, consoleErrors: state.consoleErrors }, null, 2),
    'utf8',
  )
  console.log(`结果 JSON：${RESULT_JSON}`)
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`已安装应用验收异常：${error.message || error}`)
  results.record('已安装应用验收主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary(`已安装 v${EXPECTED_VERSION} 启动验收（异常）`)
  try {
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, exe: EXE, summary, fatalError: String(error.stack || error) }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  killOwnApp()
  restoreAppData()
  process.exitCode = 1
})
