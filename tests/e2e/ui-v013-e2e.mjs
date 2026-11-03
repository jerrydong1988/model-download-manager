#!/usr/bin/env node
/**
 * tests/e2e/ui-v013-e2e.mjs — v0.1.3 UI 四阶段真机验收（暗色/字体/密度/键盘/KeepAlive/设置持久化）
 *
 * WebView2 CDP 驱动真实 debug exe（vite dev server 1420）：
 *   - 四页 light/dark × 1320×860/1040×680 共 16 张截图 + DOM 审计
 *     （<12px 文字=0、text-slate-400=0、Noto Sans SC 生效、焦点环实色、无白屏/异常）；
 *   - 主题三态（浅色/深色/跟随系统 + 系统偏好变化）、重启保持、首帧 data-theme 提前生效；
 *   - 快捷键（Ctrl+1..4 / Ctrl+F / F5 / Ctrl+, / ? / Esc）、skip link、SegmentedControl 方向键、
 *     目录树键盘、路由切换播报；
 *   - KeepAlive（浏览搜索词/仓库详情、本地库展开状态）；
 *   - 设置页错误摘要（role=alert + 跳转聚焦）、内联保存条不遮挡（static 非 sticky）；
 *   - 新设置项 theme/closeToTray/notificationsEnabled 保存 → 重启生效。
 *
 * 安全约束：不 kill 用户实例（只结束自己 spawn 的 PID 树）；WebView2 数据目录隔离；
 * settings/tasks 备份→还原；不修改源码。
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const EVIDENCE_DIR = join(ROOT, '.temp', 'qa', `ui-v013-e2e-${STAMP}`)
const RESULT_JSON = join(ROOT, '.temp', 'qa', 'ui-v013-e2e-result.json')
const APP_DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'com.modeldownload.manager')
const BACKUP_DIR = join(EVIDENCE_DIR, 'appdata-backup')
const WEBVIEW_DATA_DIR = join(EVIDENCE_DIR, 'ebwebview')

const results = createResults()
const state = {
  client: null,
  proc: null,
  spawnedPid: null,
  appExitCode: null,
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  audits: {},
  layout: {},
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
/* 进程与连接                                                          */
/* ------------------------------------------------------------------ */

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
    console.log(`已结束本脚本启动的应用实例 PID=${state.spawnedPid}`)
  } catch (error) {
    console.warn(`结束实例失败：${error.message}`)
  }
  state.spawnedPid = null
}

async function launchApp() {
  const existing = appPids()
  if (existing.length > 0) console.log(`检测到已有应用实例（不触碰）：${existing.join(', ')}`)
  try {
    await listTargets(PORT, 1500)
    throw new Error(`端口 ${PORT} 已被占用，按安全约束不结束任何进程`)
  } catch (error) {
    if (String(error.message).startsWith(`端口 ${PORT}`)) throw error
  }
  try {
    const r = await fetch('http://localhost:1420/')
    if (!r.ok) throw new Error(String(r.status))
  } catch (error) {
    throw new Error(`vite dev server 1420 不可用（debug exe 为 Tauri dev 模式，需要 npm run dev）：${error.message}`)
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
  state.appExitCode = null
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

async function connectApp(target) {
  const client = await connect(PORT, (item) => item.id === target.id, { timeoutMs: 30000 })
  await client.startCapture()
  await client.waitFor('Boolean(window.__TAURI_INTERNALS__)', { timeoutMs: 30000, description: 'Tauri IPC' })
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '快照加载' })
  return client
}

async function relaunchApp() {
  if (state.client) await state.client.close().catch(() => {})
  state.client = null
  killOwnApp()
  await sleep(1500)
  const target = await launchApp()
  state.client = await connectApp(target)
  return state.client
}

/* ------------------------------------------------------------------ */
/* 通用操作                                                            */
/* ------------------------------------------------------------------ */

async function goPage(client, label) {
  await client.clickByText(label, 'aside nav button, aside button')
  await client.waitFor(`document.querySelector('h1') && document.querySelector('h1').innerText.trim() === ${JSON.stringify(label)}`, {
    timeoutMs: 20000,
    description: `切换到 ${label}`,
  })
  await sleep(350)
}

async function clickSegOption(client, groupAriaLabel, optionText) {
  const clicked = await client.evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label=${JSON.stringify(groupAriaLabel)}]');
    if (!group) return false;
    const btn = [...group.querySelectorAll('button')].find((b) => b.innerText.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(optionText)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`分段控件选项不存在：${groupAriaLabel} > ${optionText}`)
  await sleep(250)
}

async function dispatchKey(client, { key, code, vk, modifiers = 0, text }) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(220)
}

async function activeElementInfo(client) {
  return client.evaluate(`(() => {
    const el = document.activeElement;
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName,
      id: el.id || '',
      cls: String(el.className || '').slice(0, 120),
      ariaLabel: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
      ariaExpanded: el.getAttribute('aria-expanded'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
      rect: (() => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    };
  })()`)
}

/* ------------------------------------------------------------------ */
/* DOM 审计                                                            */
/* ------------------------------------------------------------------ */

async function auditDom(client) {
  return client.evaluate(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const offenders = [];
    let minFont = 999;
    let textCount = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.textContent || '').trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el) continue;
      if (el.closest('[aria-hidden="true"], .sr-only, [hidden]')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      if (el.getClientRects().length === 0) continue;
      const size = parseFloat(style.fontSize);
      if (!Number.isFinite(size) || size <= 0) continue;
      textCount += 1;
      if (size < minFont) minFont = size;
      if (size < 12 && offenders.length < 12) offenders.push({ text: text.slice(0, 30), size, tag: el.tagName, cls: String(el.className).slice(0, 60) });
      else if (size < 12) offenders.push({ text: text.slice(0, 12), size });
    }
    const slate400 = [...document.querySelectorAll('[class*="text-slate-400"]')]
      .filter((el) => el.getClientRects().length > 0 && (el.innerText || '').trim())
      .map((el) => ({ text: (el.innerText || '').trim().slice(0, 30), cls: String(el.className).slice(0, 80) }));
    const fontsLoaded = [...document.fonts].filter((f) => /Noto Sans SC/i.test(f.family)).map((f) => ({ family: f.family, status: f.status, weight: f.weight }));
    const bodyStyle = getComputedStyle(document.body);
    return {
      htmlTheme: document.documentElement.dataset.theme || '',
      colorScheme: document.documentElement.style.colorScheme,
      bodyBg: bodyStyle.backgroundColor,
      bodyColor: bodyStyle.color,
      fontFamily: bodyStyle.fontFamily,
      fontsLoaded: fontsLoaded.slice(0, 4),
      minFont,
      textCount,
      subTwelveCount: offenders.filter((item) => item.size < 12).length,
      subTwelve: offenders.slice(0, 8),
      slate400Count: slate400.length,
      slate400: slate400.slice(0, 5),
      bodyTextLen: document.body.innerText.length,
      h1: document.querySelector('h1') ? document.querySelector('h1').innerText.trim() : '',
    };
  })()`)
}

async function auditLayout(client, pageLabel) {
  return client.evaluate(`(() => {
    const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
    const header = document.querySelector('header');
    const aside = document.querySelector('aside');
    const shell = document.querySelector('main') ? document.querySelector('main').parentElement.parentElement : null;
    const statusBars = [...document.querySelectorAll('div,footer')].filter((el) => {
      const text = (el.innerText || '').trim();
      return /事件通道|本地存储|v0\\.1\\.3|打开数据目录/.test(text) && el.getBoundingClientRect().height > 20 && el.getBoundingClientRect().height < 40;
    });
    const treeRows = [...document.querySelectorAll('[role="treeitem"]')];
    const treeRowHeights = treeRows.slice(0, 5).map((el) => Math.round(el.getBoundingClientRect().height));
    const statLabels = ['进行中', '总速度', '已完成', '已暂停'];
    const statCards = statLabels.map((label) => {
      const p = [...document.querySelectorAll('p')].find((el) => (el.textContent || '').trim() === label);
      let node = p ? p.parentElement : null;
      for (let i = 0; i < 3 && node; i += 1) { if (node.getBoundingClientRect().height > 60 && node.className.includes('rounded-card')) break; node = node.parentElement; }
      return node ? Math.round(node.getBoundingClientRect().height) : null;
    });
    return {
      page: ${JSON.stringify(pageLabel)},
      viewport: { w: window.innerWidth, h: window.innerHeight },
      header: rectOf(header),
      aside: rectOf(aside),
      statusBarHeight: statusBars.length ? rectOf(statusBars[0]).h : null,
      treeRowHeights,
      statCardHeights: statCards,
      h1FontSize: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).fontSize : '',
    };
  })()`)
}

/* ------------------------------------------------------------------ */
/* 视觉 + 主题                                                         */
/* ------------------------------------------------------------------ */

const PAGES = [
  { key: 'browse', label: '浏览仓库' },
  { key: 'downloads', label: '下载队列' },
  { key: 'library', label: '本地模型库' },
  { key: 'settings', label: '设置' },
]

async function waitTheme(client, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let current = ''
  while (Date.now() < deadline) {
    current = await client.evaluate('document.documentElement.dataset.theme || ""')
    if (current === expected) return true
    await sleep(120)
  }
  throw new Error(`等待主题 ${expected} 超时（当前 ${current}）`)
}

async function captureFourPages(client, { theme, viewport }) {
  const audits = []
  for (const page of PAGES) {
    await goPage(client, page.label)
    await sleep(500)
    const audit = await auditDom(client)
    audits.push({ page: page.label, ...audit })
    state.audits[`${page.key}-${theme}-${viewport}`] = audit
    if (!audits[audits.length - 1].bodyTextLen) throw new Error(`${page.label} 白屏`)
    await screenshot(client, `${page.key}-${theme}-${viewport}`)
    if (page.key === 'downloads') state.layout[`downloads-${theme}-${viewport}`] = await auditLayout(client, page.label)
    if (page.key === 'library') {
      await client.waitFor('document.body.innerText.includes("共 124 个文件") || document.querySelector("[role=\\"tree\\"]")', { timeoutMs: 30000, description: '库扫描' })
      state.layout[`library-${theme}-${viewport}`] = await auditLayout(client, page.label)
    }
  }
  return audits
}

async function setTheme(client, label) {
  await goPage(client, '设置')
  await clickSegOption(client, '界面主题', label)
  await sleep(250)
  const expected = label === '浅色' ? 'light' : label === '深色' ? 'dark' : null
  if (expected) await waitTheme(client, expected)
  return expected
}

async function installFirstThemeProbe(client) {
  const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__QA_FIRST_THEME__ = null;
      const capture = () => {
        try {
          if (!window.__QA_FIRST_THEME__ && document.documentElement) {
            const t = document.documentElement.dataset ? document.documentElement.dataset.theme : '';
            if (t) window.__QA_FIRST_THEME__ = t;
          }
        } catch (e) { /* ignore */ }
      };
      try { new MutationObserver(capture).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) { /* ignore */ }
      let ticks = 0;
      const timer = setInterval(() => { capture(); ticks += 1; if (ticks > 400) clearInterval(timer); }, 5);
      document.addEventListener('DOMContentLoaded', capture, { once: true });
    })();`,
  })
  return identifier
}

async function checkFirstFrameTheme(client, { expected, reload = true }) {
  const scriptId = await installFirstThemeProbe(client)
  if (reload) await client.send('Page.reload', { ignoreCache: false })
  await client.waitFor('document.readyState === "complete"', { timeoutMs: 30000, description: '页面重载' })
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '应用重载' })
  const first = await client.evaluate('window.__QA_FIRST_THEME__ || ""')
  const current = await client.evaluate('document.documentElement.dataset.theme || ""')
  try {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })
  } catch {
    /* ignore */
  }
  return { first, current, ok: first === expected && current === expected }
}

async function runVisualAndTheme(client) {
  console.log('\n──────── 阶段 2A：四页 light/dark × 两尺寸 + DOM 审计 ────────')
  // 默认主题（system → 当前系统偏好，先记录）
  const initialTheme = await client.evaluate('document.documentElement.dataset.theme')
  results.record('初始主题已应用', ['light', 'dark'].includes(initialTheme), `data-theme=${initialTheme}`)

  await setTheme(client, '浅色')
  results.record('主题切换：浅色', (await client.evaluate('document.documentElement.dataset.theme')) === 'light', '')
  const lightAudits1320 = await captureFourPages(client, { theme: 'light', viewport: '1320x860' })

  await setTheme(client, '深色')
  results.record('主题切换：深色', (await client.evaluate('document.documentElement.dataset.theme')) === 'dark', '')
  const darkAudits1320 = await captureFourPages(client, { theme: 'dark', viewport: '1320x860' })

  await client.setViewport(1040, 680)
  await sleep(400)
  await setTheme(client, '浅色')
  const lightAudits1040 = await captureFourPages(client, { theme: 'light', viewport: '1040x680' })
  await setTheme(client, '深色')
  const darkAudits1040 = await captureFourPages(client, { theme: 'dark', viewport: '1040x680' })
  await client.send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)

  const allAudits = [...lightAudits1320, ...darkAudits1320, ...lightAudits1040, ...darkAudits1040]
  const subTwelve = allAudits.reduce((sum, item) => sum + item.subTwelveCount, 0)
  const slate400 = allAudits.reduce((sum, item) => sum + item.slate400Count, 0)
  results.record(
    'DOM：全部页面/主题/尺寸无 <12px 文字',
    subTwelve === 0,
    `最小字号=${Math.min(...allAudits.map((item) => item.minFont))}px；违规=${JSON.stringify(allAudits.flatMap((item) => item.subTwelve).slice(0, 4))}`,
  )
  results.record('DOM：无 text-slate-400 正文类', slate400 === 0, `出现 ${slate400} 处：${JSON.stringify(allAudits.flatMap((item) => item.slate400).slice(0, 3))}`)
  const fontOk = allAudits.every((item) => /Noto Sans SC/i.test(item.fontFamily))
  const fontsLoaded = allAudits.flatMap((item) => item.fontsLoaded)
  results.record('字体：body font-family 含 Noto Sans SC', fontOk, allAudits[0]?.fontFamily || '')
  const fontAudit = await client.evaluate(`(async () => {
    await document.fonts.ready;
    let loadStatus = 'n/a';
    try {
      const loaded = await document.fonts.load('14px "Noto Sans SC Variable"', '模型下载管理器 下载队列 本地模型库');
      loadStatus = loaded.length > 0 ? 'loaded' : 'empty';
    } catch (error) {
      loadStatus = 'error:' + (error && error.message ? error.message : String(error));
    }
    const resources = performance.getEntriesByType('resource')
      .filter((r) => /noto-sans-sc.*\\.woff2/.test(r.name))
      .map((r) => ({ name: r.name.split('/').pop(), size: r.transferSize || r.decodedBodySize }));
    const loadedFamilies = [...document.fonts].filter((f) => f.status === 'loaded' && /Noto Sans SC/i.test(f.family)).length;
    return { check: document.fonts.check('14px "Noto Sans SC Variable"'), loadStatus, resourceCount: resources.length, resources: resources.slice(0, 3), loadedFamilies };
  })()`, { timeoutMs: 30000 })
  results.record(
    '字体：Noto Sans SC 字体资源实际加载',
    fontAudit.check === true && (fontAudit.resourceCount > 0 || fontAudit.loadedFamilies > 0),
    JSON.stringify(fontAudit),
  )
  const themeColors = { light: allAudits.find((a) => a.htmlTheme === 'light')?.bodyBg, dark: allAudits.find((a) => a.htmlTheme === 'dark')?.bodyBg }
  results.record('暗色/浅色背景色不同且符合 token', themeColors.light !== themeColors.dark && Boolean(themeColors.light) && Boolean(themeColors.dark), JSON.stringify(themeColors))
  results.record('四页均有内容（无白屏）', allAudits.every((item) => item.bodyTextLen > 200), `最小文本长度=${Math.min(...allAudits.map((item) => item.bodyTextLen))}`)

  // 布局密度
  const layout = state.layout[`downloads-light-1320x860`] || {}
  const layoutLib = state.layout[`library-light-1320x860`] || {}
  results.record(
    '布局密度：TopBar 60 / 状态栏 28 / 侧栏 240',
    layout.header?.h === 60 && layout.aside?.w === 240 && layoutLib.statusBarHeight === 28,
    `header=${layout.header?.h} aside=${layout.aside?.w} statusBar=${layoutLib.statusBarHeight} h1=${layout.h1FontSize}`,
  )
  results.record(
    '布局密度：统计卡等高、树行高 40',
    Boolean(layout.statCardHeights?.length) && new Set(layout.statCardHeights).size === 1 && layoutLib.treeRowHeights?.every((h) => h === 40),
    `统计卡=${JSON.stringify(layout.statCardHeights)} 树行=${JSON.stringify(layoutLib.treeRowHeights)}`,
  )

  // 跟随系统
  await setTheme(client, '跟随系统')
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await waitTheme(client, 'dark')
  const sysDark = await client.evaluate('document.documentElement.dataset.theme')
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await waitTheme(client, 'light')
  const sysLight = await client.evaluate('document.documentElement.dataset.theme')
  await client.send('Emulation.setEmulatedMedia', { features: [] })
  results.record('主题「跟随系统」实时跟随 prefers-color-scheme', sysDark === 'dark' && sysLight === 'light', `dark→${sysDark}, light→${sysLight}`)

  // 焦点环 + skip link：重载页面后做一次「从零开始的 Tab 顺序」
  await client.send('Page.reload')
  await client.waitFor('document.body.innerText.includes("本地存储")', { timeoutMs: 30000, description: '页面重载' })
  await sleep(500)
  await client.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()')
  await dispatchKey(client, { key: 'Tab', code: 'Tab', vk: 9 })
  const focusInfo = await activeElementInfo(client)
  const outlineRing = focusInfo?.outlineStyle === 'solid' && focusInfo?.outlineWidth === '2px' && !/rgba\(0, 0, 0, 0\)|transparent/.test(focusInfo?.outlineColor || '')
  const shadowRing = Boolean(focusInfo?.boxShadow) && focusInfo.boxShadow !== 'none' && /rgb/.test(focusInfo.boxShadow)
  results.record(
    'skip link：重载后首次 Tab 聚焦且焦点环实色',
    Boolean(focusInfo) && focusInfo.cls.includes('skip-link') && (outlineRing || shadowRing),
    `active=${focusInfo?.tag}.${focusInfo?.cls.slice(0, 50)} outline=${focusInfo?.outlineStyle}/${focusInfo?.outlineWidth}/${focusInfo?.outlineColor} shadow=${(focusInfo?.boxShadow || '').slice(0, 90)}`,
  )
  await dispatchKey(client, { key: 'Enter', code: 'Enter', vk: 13, text: '\r' })
  const afterSkip = await client.evaluate('document.activeElement ? document.activeElement.id : ""')
  results.record('skip link 激活后焦点移到 main', afterSkip === 'main', `activeElement.id=${afterSkip}`)
  await screenshot(client, 'skip-link-focused')
}

/* ------------------------------------------------------------------ */
/* 快捷键 / 键盘 / KeepAlive                                           */
/* ------------------------------------------------------------------ */

async function shortcut(client, key, code, vk, modifiers = 2) {
  await dispatchKey(client, { key, code, vk, modifiers })
}

async function runKeyboardAndShortcuts(client) {
  console.log('\n──────── 阶段 2B：快捷键 / 键盘 / KeepAlive ────────')
  const pageByDigit = [['1', '浏览仓库'], ['2', '下载队列'], ['3', '本地模型库'], ['4', '设置']]
  let shortcutOk = true
  const details = []
  for (const [digit, label] of pageByDigit) {
    await shortcut(client, digit, `Digit${digit}`, 48 + Number(digit))
    const title = await client.evaluate('document.querySelector("h1").innerText.trim()')
    details.push(`Ctrl+${digit}→${title}`)
    if (title !== label) shortcutOk = false
  }
  results.record('快捷键 Ctrl+1..4 切换四页', shortcutOk, details.join('，'))

  // Ctrl+F 聚焦搜索框（浏览页/本地库）
  await shortcut(client, '1', 'Digit1', 49)
  await sleep(400)
  await shortcut(client, 'f', 'KeyF', 70)
  const focusBrowse = await activeElementInfo(client)
  await goPage(client, '本地模型库')
  await sleep(600)
  await shortcut(client, 'f', 'KeyF', 70)
  const focusLibrary = await activeElementInfo(client)
  results.record(
    '快捷键 Ctrl+F 聚焦当前页搜索框',
    focusBrowse?.ariaLabel === '搜索仓库' && focusLibrary?.ariaLabel === '搜索文件名或路径',
    `浏览=${focusBrowse?.ariaLabel}，本地库=${focusLibrary?.ariaLabel}`,
  )

  // F5 不整页刷新（preventDefault）
  await client.evaluate('window.__qaMarker = 12345')
  await dispatchKey(client, { key: 'F5', code: 'F5', vk: 116 })
  await sleep(500)
  const marker = await client.evaluate('window.__qaMarker || null')
  const readyState = await client.evaluate('document.readyState')
  results.record('快捷键 F5 刷新数据而非整页重载', marker === 12345 && readyState === 'complete', `marker=${marker} readyState=${readyState}`)
  await screenshot(client, 'shortcut-f5')

  // Ctrl+, 打开设置
  await shortcut(client, ',', 'Comma', 188)
  const afterComma = await client.evaluate('document.querySelector("h1").innerText.trim()')
  results.record('快捷键 Ctrl+, 打开设置', afterComma === '设置', `h1=${afterComma}`)

  // ? 打开帮助，Esc 关闭
  await dispatchKey(client, { key: '?', code: 'Slash', vk: 191, modifiers: 8, text: '?' })
  await client.waitFor('Boolean(document.querySelector(\'[role="dialog"]\')) && document.body.innerText.includes("键盘快捷键")', {
    timeoutMs: 8000,
    description: '快捷键帮助浮层',
  })
  await screenshot(client, 'shortcuts-help')
  await dispatchKey(client, { key: 'Escape', code: 'Escape', vk: 27 })
  await client.waitFor('!document.querySelector(\'[role="dialog"]\')', { timeoutMs: 8000, description: 'Esc 关闭帮助' })
  results.record('快捷键 ? 打开帮助 / Esc 关闭', true, '')

  // 路由切换播报（aria-live）
  await shortcut(client, '2', 'Digit2', 50)
  await sleep(400)
  const announced = await client.evaluate(`(() => {
    const regions = [...document.querySelectorAll('[role="status"][aria-live="polite"]')].map((el) => (el.innerText || '').trim()).filter(Boolean);
    return regions.join(' | ');
  })()`)
  results.record('路由切换有 aria-live 播报', announced.includes('下载队列'), announced || '（无播报文本）')

  // SegmentedControl 方向键（浏览页来源切换）
  await shortcut(client, '1', 'Digit1', 49)
  await sleep(500)
  await client.evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="切换模型来源"]');
    const first = group ? group.querySelector('button') : null;
    if (first) first.focus();
    return Boolean(first);
  })()`)
  await dispatchKey(client, { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
  const segState = await client.evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="切换模型来源"]');
    return group ? [...group.querySelectorAll('button')].map((b) => ({ text: b.innerText.trim(), pressed: b.getAttribute('aria-pressed') === 'true' })) : [];
  })()`)
  const segRightOk = segState.some((item) => item.text.startsWith('ModelScope') && item.pressed)
  await dispatchKey(client, { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 })
  const segBack = await client.evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="切换模型来源"]');
    return group ? [...group.querySelectorAll('button')].find((b) => b.innerText.includes('HuggingFace'))?.getAttribute('aria-pressed') === 'true' : false;
  })()`)
  results.record('SegmentedControl ←/→ 方向键切换并选中', segRightOk && segBack, JSON.stringify(segState))

  // KeepAlive：浏览页搜索词 + 仓库详情
  await client.type('input[aria-label="搜索仓库"]', 'Qwen')
  await client.waitFor('document.querySelectorAll(\'button[aria-label^="打开仓库 "]\').length > 0', { timeoutMs: 40000, description: '搜索结果' })
  const repoLabel = await client.evaluate(`document.querySelector('button[aria-label^="打开仓库 "]').getAttribute('aria-label')`)
  await client.evaluate(`document.querySelector('button[aria-label^="打开仓库 "]').click()`)
  await client.waitFor('document.querySelector("h2") && document.body.innerText.includes(' + JSON.stringify(repoLabel.replace('打开仓库 ', '')) + ')', { timeoutMs: 30000, description: '仓库详情' })
  await shortcut(client, '2', 'Digit2', 50)
  await sleep(400)
  await shortcut(client, '1', 'Digit1', 49)
  await sleep(500)
  const keepBrowse = await client.evaluate(`(() => ({
    detail: document.body.innerText.includes(${JSON.stringify(repoLabel.replace('打开仓库 ', ''))}) && Boolean(document.querySelector('h2')),
    hasSearch: Boolean(document.querySelector('input[aria-label="搜索仓库"]')),
  }))()`)
  let keepQuery = null
  if (keepBrowse.hasSearch) {
    keepQuery = await client.evaluate('document.querySelector(\'input[aria-label="搜索仓库"]\').value')
  } else {
    // 详情页打开时搜索框被卸载：点「返回搜索结果」后应恢复此前输入内容（KeepAlive 保持 BrowsePage 状态）
    await client.clickByText('返回搜索结果')
    await client.waitFor('Boolean(document.querySelector(\'input[aria-label="搜索仓库"]\'))', { timeoutMs: 10000, description: '返回搜索' })
    keepQuery = await client.evaluate('document.querySelector(\'input[aria-label="搜索仓库"]\').value')
  }
  results.record(
    'KeepAlive：浏览页搜索词 + 仓库详情切换页面后保留',
    keepBrowse.detail === true && keepQuery === 'Qwen',
    `详情保留=${keepBrowse.detail}，搜索词=${JSON.stringify(keepQuery)}`,
  )
  await screenshot(client, 'keepalive-browse')
  // 清空搜索回到初始列表，避免影响后续用例
  await client.evaluate(`(() => { const el = document.querySelector('input[aria-label="搜索仓库"]'); if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`)

  // KeepAlive + 目录树键盘：本地库展开状态保留
  await goPage(client, '本地模型库')
  await client.waitFor('document.body.innerText.includes("个文件")', { timeoutMs: 30000, description: '库扫描' })
  await sleep(600)
  const dirInfo = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')];
    const target = rows.find((el) => Number(el.getAttribute('aria-level')) === 2 && el.getAttribute('aria-expanded') !== null);
    if (!target) return null;
    const btn = target.querySelector('button[aria-label^="打开目录 "]');
    return { label: btn ? btn.getAttribute('aria-label') : '', expanded: target.getAttribute('aria-expanded') };
  })()`)
  if (dirInfo && dirInfo.expanded === 'true') {
    // 折叠该目录（点击行）
    await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')];
      const target = rows.find((el) => Number(el.getAttribute('aria-level')) === 2 && el.getAttribute('aria-expanded') !== null);
      if (target) target.click();
      return true;
    })()`)
    await sleep(300)
  }
  const expandedBefore = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')];
    const target = rows.find((el) => Number(el.getAttribute('aria-level')) === 2 && el.getAttribute('aria-expanded') !== null);
    return target ? target.getAttribute('aria-expanded') : null;
  })()`)
  await shortcut(client, '2', 'Digit2', 50)
  await sleep(350)
  await shortcut(client, '3', 'Digit3', 51)
  await sleep(600)
  const expandedAfter = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')];
    const target = rows.find((el) => Number(el.getAttribute('aria-level')) === 2 && el.getAttribute('aria-expanded') !== null);
    return target ? target.getAttribute('aria-expanded') : null;
  })()`)
  results.record('KeepAlive：本地库目录展开状态切换页面后保留', expandedBefore === expandedAfter && expandedBefore !== null, `before=${expandedBefore} after=${expandedAfter}`)

  // 目录树键盘：聚焦行 → ArrowRight 展开 / ArrowLeft 折叠 / ArrowDown 移动
  const keyboardTree = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')];
    const target = rows.find((el) => Number(el.getAttribute('aria-level')) === 2 && el.getAttribute('aria-expanded') !== null);
    if (!target) return null;
    target.focus();
    return target.getAttribute('aria-expanded');
  })()`)
  if (keyboardTree !== null) {
    if (keyboardTree === 'true') await dispatchKey(client, { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 })
    else await dispatchKey(client, { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
    const afterArrow = await client.evaluate('document.activeElement ? document.activeElement.getAttribute("aria-expanded") : null')
    const downBefore = await client.evaluate('document.activeElement ? { level: document.activeElement.getAttribute("aria-level"), text: (document.activeElement.innerText || "").replace(/\\s+/g, " ").slice(0, 40) } : null')
    await dispatchKey(client, { key: 'ArrowDown', code: 'ArrowDown', vk: 40 })
    const downAfter = await client.evaluate('document.activeElement ? { level: document.activeElement.getAttribute("aria-level"), text: (document.activeElement.innerText || "").replace(/\\s+/g, " ").slice(0, 40) } : null')
    const moved = Boolean(downAfter) && Boolean(downBefore) && (downAfter.text !== downBefore.text || downAfter.level !== downBefore.level)
    results.record(
      '目录树键盘：←/→ 展开折叠 + ↑/↓ 行移动',
      afterArrow !== null && afterArrow !== keyboardTree && moved,
      `初始=${keyboardTree}→方向键后=${afterArrow}；ArrowDown 前=${JSON.stringify(downBefore)} 后=${JSON.stringify(downAfter)}`,
    )
  } else {
    results.record('目录树键盘：方向键展开/折叠与行移动', false, '未找到可测试目录行')
  }
  await screenshot(client, 'library-tree-keyboard')
}

/* ------------------------------------------------------------------ */
/* 设置：错误摘要 / 保存条 / 新字段持久化                              */
/* ------------------------------------------------------------------ */

async function runSettingsChecks(client) {
  console.log('\n──────── 阶段 2C：设置错误摘要 / 保存条 / 三字段持久化 ────────')
  await setTheme(client, '深色')
  await sleep(400)

  // 内联保存条不遮挡
  const saveBar = await client.evaluate(`(() => {
    const saveBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '保存设置');
    if (!saveBtn) return null;
    let section = saveBtn;
    while (section && section.tagName !== 'SECTION') section = section.parentElement;
    if (!section) return null;
    const style = getComputedStyle(section);
    const inputs = [...document.querySelectorAll('main input')];
    const lastInput = inputs[inputs.length - 1];
    const sectionRect = section.getBoundingClientRect();
    const inputRect = lastInput ? lastInput.getBoundingClientRect() : null;
    const scroller = [...document.querySelectorAll('div')].find((el) => {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50;
    });
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return { position: style.position, top: Math.round(sectionRect.top), height: Math.round(sectionRect.height), lastInputBottom: inputRect ? Math.round(inputRect.bottom) : null };
  })()`)
  await sleep(400)
  const saveBarAfterScroll = await client.evaluate(`(() => {
    const saveBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '保存设置');
    if (!saveBtn) return null;
    let section = saveBtn;
    while (section && section.tagName !== 'SECTION') section = section.parentElement;
    const inputs = [...document.querySelectorAll('main input')];
    const lastInput = inputs[inputs.length - 1];
    const sectionRect = section.getBoundingClientRect();
    const inputRect = lastInput ? lastInput.getBoundingClientRect() : null;
    return { position: getComputedStyle(section).position, sectionTop: Math.round(sectionRect.top), lastInputBottom: inputRect ? Math.round(inputRect.bottom) : null };
  })()`)
  results.record(
    '设置页内联保存条不遮挡内容（static 非 sticky/fixed）',
    saveBar?.position === 'static' && saveBarAfterScroll?.position === 'static' && (saveBarAfterScroll?.lastInputBottom ?? 0) <= (saveBarAfterScroll?.sectionTop ?? 0) + 4,
    JSON.stringify({ saveBar, saveBarAfterScroll }),
  )

  // 错误摘要
  await client.type('#settings-hf-endpoint', 'ftp://bad-endpoint')
  await client.clickByText('保存设置')
  await client.waitFor('document.body.innerText.includes("项设置需要修正")', { timeoutMs: 8000, description: '设置错误摘要' })
  const summary = await client.evaluate(`(() => {
    const alert = [...document.querySelectorAll('[role="alert"]')].find((el) => el.innerText.includes('项设置需要修正'));
    return alert ? { text: alert.innerText.replace(/\\s+/g, ' ').slice(0, 200), links: alert.querySelectorAll('button').length } : null;
  })()`)
  await screenshot(client, 'settings-error-summary')
  const clickedSummary = await client.evaluate(`(() => {
    const alert = [...document.querySelectorAll('[role="alert"]')].find((el) => el.innerText.includes('项设置需要修正'));
    const btn = alert ? alert.querySelector('button') : null;
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
  await sleep(300)
  const focusedField = await client.evaluate('document.activeElement ? document.activeElement.id : ""')
  results.record(
    '设置校验失败：错误摘要 role=alert 且点击可定位字段',
    Boolean(summary) && summary.links >= 1 && clickedSummary && focusedField === 'settings-hf-endpoint',
    `summary=${JSON.stringify(summary)} focusedField=${focusedField}`,
  )
  await client.type('#settings-hf-endpoint', 'https://hf-mirror.com')
  await client.clickByText('保存设置')
  await client.waitFor('!document.body.innerText.includes("项设置需要修正")', { timeoutMs: 10000, description: '修复后保存' })
  results.record('修正后保存成功（错误摘要消失）', true, '')

  // 新三字段：设为 dark / closeToTray=false / notifications=false 并保存
  const switchState = async (target) => target.evaluate(`(() => {
    const tray = document.querySelector('[role="switch"][aria-label="关闭窗口时最小化到托盘并在后台继续下载"]');
    const notify = document.querySelector('[role="switch"][aria-label="下载完成或失败时发送系统通知"]');
    return {
      tray: tray ? tray.getAttribute('aria-checked') : null,
      notify: notify ? notify.getAttribute('aria-checked') : null,
    };
  })()`)
  let switches = await switchState(client)
  const clickSwitch = async (ariaLabel, targetChecked) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const checked = await client.evaluate(`(() => { const el = document.querySelector('[role="switch"][aria-label="' + ${JSON.stringify(ariaLabel)} + '"]'); return el ? el.getAttribute('aria-checked') : null; })()`)
      if (checked === String(targetChecked)) return true
      await client.evaluate(`(() => { const el = document.querySelector('[role="switch"][aria-label="' + ${JSON.stringify(ariaLabel)} + '"]'); if (el) el.click(); return true; })()`)
      await sleep(300)
    }
    return false
  }
  const trayToggled = await clickSwitch('关闭窗口时最小化到托盘并在后台继续下载', false)
  const notifyToggled = await clickSwitch('下载完成或失败时发送系统通知', false)
  results.record('设置页托盘/通知开关点击生效', trayToggled && notifyToggled, `tray=${trayToggled} notify=${notifyToggled}`)
  await sleep(600)
  await client.clickByText('保存设置')
  await sleep(1200)
  let settings = await client.tauriInvoke('get_settings')
  if (settings.closeToTray !== false || settings.notificationsEnabled !== false) {
    // v0.2.0 设置页新增字段导致偶发草稿同步竞争：重新断言开关后再保存一次
    await clickSwitch('关闭窗口时最小化到托盘并在后台继续下载', false)
    await clickSwitch('下载完成或失败时发送系统通知', false)
    await sleep(500)
    await client.clickByText('保存设置')
    await sleep(1500)
    settings = await client.tauriInvoke('get_settings')
  }
  let diskSettings = null
  try {
    diskSettings = JSON.parse(readFileSync(join(APP_DATA_DIR, 'settings.json'), 'utf8'))
  } catch {
    /* ignore */
  }
  results.record(
    '新设置项保存生效（theme/closeToTray/notificationsEnabled）',
    settings.theme === 'dark' && settings.closeToTray === false && settings.notificationsEnabled === false &&
      diskSettings?.theme === 'dark' && diskSettings?.closeToTray === false && diskSettings?.notificationsEnabled === false,
    `get_settings=${JSON.stringify({ theme: settings.theme, closeToTray: settings.closeToTray, notificationsEnabled: settings.notificationsEnabled })}；settings.json=${JSON.stringify({ theme: diskSettings?.theme, closeToTray: diskSettings?.closeToTray, notificationsEnabled: diskSettings?.notificationsEnabled })}`,
  )
  await screenshot(client, 'settings-v013-fields')

  // 重启 → 持久化 + 首帧主题
  const restartClient = await relaunchApp()
  const afterRestart = await restartClient.tauriInvoke('get_settings')
  const themeNow = await restartClient.evaluate('document.documentElement.dataset.theme')
  results.record(
    '重启后新三字段持久化生效',
    afterRestart.theme === 'dark' && afterRestart.closeToTray === false && afterRestart.notificationsEnabled === false,
    `theme=${afterRestart.theme} closeToTray=${afterRestart.closeToTray} notificationsEnabled=${afterRestart.notificationsEnabled}`,
  )
  results.record('重启后暗色主题立即生效', themeNow === 'dark', `data-theme=${themeNow}`)
  const firstFrame = await checkFirstFrameTheme(restartClient, { expected: 'dark', reload: true })
  results.record(
    '首帧不闪白：index.html 内联脚本在 React 之前应用 data-theme=dark',
    firstFrame.ok,
    `__QA_FIRST_THEME__=${firstFrame.first} data-theme=${firstFrame.current}`,
  )
  await goPage(restartClient, '设置')
  await sleep(500)
  const switchesAfter = await switchState(restartClient)
  results.record('重启后设置页开关回显正确', switchesAfter.tray === 'false' && switchesAfter.notify === 'false', JSON.stringify(switchesAfter))
  await screenshot(restartClient, 'settings-after-restart')
  state.client = restartClient
  await setTheme(restartClient, '深色')
  await sleep(200)
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(join(EVIDENCE_DIR, 'shots'), { recursive: true })
  mkdirSync(APP_DATA_DIR, { recursive: true })
  console.log(`证据目录：${EVIDENCE_DIR}`)
  results.record('应用 exe 存在', existsSync(EXE), EXE)
  if (!existsSync(EXE)) {
    const summary = results.summary('v0.1.3 UI 真机验收（缺少前置构建）')
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary }, null, 2), 'utf8')
    process.exitCode = 1
    return
  }
  backupAppData()
  try {
    const target = await launchApp()
    results.record('测试实例启动（9223 + WebView2 数据目录隔离）', true, `spawnedPid=${state.spawnedPid}`)
    state.client = await connectApp(target)
    const snapshot = await state.client.tauriInvoke('get_snapshot')
    results.record('真实模式 / 版本号', snapshot.appVersion === '0.2.0' && !(await state.client.evaluate('document.body.innerText.includes("Mock 数据模式")')), `appVersion=${snapshot.appVersion}`)

    await runVisualAndTheme(state.client)
    await runKeyboardAndShortcuts(state.client)
    await runSettingsChecks(state.client)

    state.pageErrors = state.client.pageErrors.slice()
    state.consoleErrors = state.client.consoleErrors.slice()
    results.record('全流程无未捕获页面异常', state.pageErrors.length === 0, `${state.pageErrors.length} 个：${state.pageErrors.map((e) => e.text).join(' | ').slice(0, 500)}`)
    const ignored = (item) =>
      /favicon/i.test(item.text) || /Failed to load resource: the server responded with a status of 404/.test(item.text) || /DevTools/.test(item.text)
    const realErrors = state.consoleErrors.filter((item) => !ignored(item))
    results.record('全流程无控制台错误', realErrors.length === 0, realErrors.map((item) => item.text).join(' | ').slice(0, 800))
  } finally {
    if (state.client) await state.client.close().catch(() => {})
    killOwnApp()
    await sleep(1200)
    restoreAppData()
    rmSync(WEBVIEW_DATA_DIR, { recursive: true, force: true })
    console.log('已还原应用数据并清理临时 WebView2 数据目录')
    console.log(`当前剩余应用实例：${appPids().join(', ') || '无'}`)
  }
  const summary = results.summary('v0.1.3 UI 四阶段真机验收')
  writeFileSync(
    RESULT_JSON,
    JSON.stringify({ stamp: STAMP, exe: EXE, summary, screenshots: state.screenshots, audits: state.audits, layout: state.layout, consoleErrors: state.consoleErrors, pageErrors: state.pageErrors }, null, 2),
    'utf8',
  )
  console.log(`结果 JSON：${RESULT_JSON}`)
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`\nUI 验收异常：${error.message || error}`)
  results.record('UI 验收主流程', false, String(error.message || error).slice(0, 800))
  const summary = results.summary('v0.1.3 UI 四阶段真机验收（异常终止）')
  try {
    writeFileSync(RESULT_JSON, JSON.stringify({ stamp: STAMP, summary, fatalError: String(error.stack || error) }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  if (state.client) state.client.close().catch(() => {})
  killOwnApp()
  restoreAppData()
  process.exitCode = 1
})
