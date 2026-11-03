/**
 * tests/e2e/cdp.mjs — 通用 Chrome DevTools Protocol (CDP) 客户端（零第三方依赖）
 *
 * 目标：同时服务 WebView2（Tauri 桌面应用，默认端口 9223）与 Edge/Chrome（默认端口 9222）。
 * 依赖：Node.js >= 22（需要全局 fetch / WebSocket；本机 Node 24 已验证）。
 *
 * 两种用法：
 *   1) 作为库：import { connect, waitForEndpoint, sha256File } from './cdp.mjs'
 *   2) 作为 CLI（自检 / 取证）：
 *        node tests/e2e/cdp.mjs list     [--port 9222]
 *        node tests/e2e/cdp.mjs eval     [--port 9222] [--expr "document.title"]
 *        node tests/e2e/cdp.mjs shot     [--port 9222] [--out .temp/qa/shot.png]
 *        node tests/e2e/cdp.mjs nav      [--port 9222] [--url "http://localhost:1420/?mock=1"]
 *        node tests/e2e/cdp.mjs watch    [--port 9222] [--seconds 10]
 *
 * 设计要点：
 *   - 事件（Runtime.consoleAPICalled / Runtime.exceptionThrown / Log.entryAdded）在连接后立即开启，
 *     navigate 之前捕获的错误也会计入 consoleErrors / pageErrors，供“无白屏/无控制台错误”验收。
 *   - 所有 send() 带超时，避免 CDP 卡死拖垮脚本。
 *   - waitFor 支持“页面内表达式”轮询（返回真值即通过），超时抛出带当前 body 摘要的错误。
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 默认 CDP HTTP 端点端口：WebView2=9223，Edge=9222。 */
export const PORT_WEBVIEW2 = 9223
export const PORT_EDGE = 9222

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 记录一条 PASS/FAIL（供各 e2e 脚本统一格式）。 */
export function createResults() {
  const rows = []
  return {
    rows,
    record(name, ok, detail = '') {
      rows.push({ name, ok: Boolean(ok), detail })
      const mark = ok ? 'PASS' : 'FAIL'
      console.log(`${mark}  ${name}${detail ? `  →  ${detail}` : ''}`)
      return ok
    },
    summary(title = 'E2E 摘要') {
      const passed = rows.filter((r) => r.ok).length
      const failed = rows.length - passed
      console.log(`\n================ ${title} ================`)
      for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? `  →  ${row.detail}` : ''}`)
      console.log(`---------------- 合计: ${passed} passed, ${failed} failed, ${rows.length} total ----------------`)
      return { passed, failed, total: rows.length }
    },
  }
}

export async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export function cdpBase(port) {
  return `http://127.0.0.1:${port}`
}

/** 列出所有 CDP targets。 */
export async function listTargets(port, timeoutMs = 5000) {
  return fetchJson(`${cdpBase(port)}/json/list`, timeoutMs)
}

/** 读取 CDP 版本信息（可用于确认“这个端口是不是 DevTools”）。 */
export async function versionInfo(port, timeoutMs = 5000) {
  return fetchJson(`${cdpBase(port)}/json/version`, timeoutMs)
}

/**
 * 轮询等待 CDP HTTP 端点上线（应用启动需要时间）。
 * @returns {Promise<Array>} targets 列表
 */
export async function waitForEndpoint(port, { timeoutMs = 120000, intervalMs = 300, label = 'CDP' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port, 3000)
      if (Array.isArray(targets) && targets.length > 0) return targets
      lastError = 'no targets yet'
    } catch (error) {
      lastError = String(error?.message || error)
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待 ${label} 端点超时（port=${port}, ${timeoutMs}ms, last=${lastError}）`)
}

/**
 * 等待满足条件的目标出现并连接。
 * @param {number} port
 * @param {(target:any)=>boolean} predicate 默认取第一个 type==='page'
 * @returns {Promise<Cdp>}
 */
export async function connect(port, predicate = (t) => t.type === 'page', options = {}) {
  const { timeoutMs = 120000, intervalMs = 300 } = options
  const deadline = Date.now() + timeoutMs
  let lastUrls = []
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port, 3000)
      lastUrls = targets.map((t) => `${t.type}:${t.url}`)
      const target = targets.find(predicate)
      if (target?.webSocketDebuggerUrl) return await Cdp.connect(target.webSocketDebuggerUrl, target)
    } catch {
      // 应用/浏览器尚未启动完成
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `连接 CDP 目标超时（port=${port}, ${timeoutMs}ms）；当前 targets=[${lastUrls.join(', ')}]`,
  )
}

/** 通用 CDP 连接（页面级 target）。 */
export class Cdp {
  static async connect(wsUrl, target = null, { timeoutMs = 15000 } = {}) {
    const client = new Cdp(wsUrl, target)
    await client.open(timeoutMs)
    return client
  }

  constructor(wsUrl, target = null) {
    this.wsUrl = wsUrl
    this.target = target
    this.nextId = 0
    this.pending = new Map()
    this.eventHandlers = new Map()
    this.closed = false
    /** @type {Array<{level:string, text:string, url?:string, line?:number}>} */
    this.consoleMessages = []
    /** @type {Array<{level:string, text:string}>} */
    this.consoleErrors = []
    /** @type {Array<{text:string, url?:string, line?:number}>} */
    this.pageErrors = []
    /** @type {Array<{level:string, text:string, source?:string}>} */
    this.logEntries = []
    /** 最近一次导航的 load 事件 promise 解析器 */
    this._loadWaiters = []
    this._captureEnabled = false
  }

  async open(timeoutMs = 15000) {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error(`WebSocket 连接超时（${timeoutMs}ms）：${this.wsUrl}`))
        }
      }, timeoutMs)
      this.ws.addEventListener(
        'open',
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      this.ws.addEventListener(
        'error',
        (event) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`WebSocket 连接失败：${this.wsUrl} (${event?.message || 'error'})`))
        },
        { once: true },
      )
    })
    this.ws.addEventListener('message', (event) => this._handleMessage(event))
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
     this.ws.addEventListener('error', () => {
      /* 单条错误由 send() 超时呈现 */
    })
    return this
  }

  _handleMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(timer)
      if (message.error) reject(new Error(`${message.error.message || 'CDP error'}${message.error.data ? ` (${message.error.data})` : ''}`))
      else resolve(message.result)
      return
    }
    if (message.method) {
      this._recordEvent(message)
      const handlers = this.eventHandlers.get(message.method)
      if (handlers) for (const handler of handlers) {
        try {
          handler(message.params)
        } catch {
          /* 用户回调异常不影响 CDP 读循环 */
        }
      }
      if (message.method === 'Page.loadEventFired') {
        const waiters = this._loadWaiters.splice(0)
        for (const waiter of waiters) waiter()
      }
    }
  }

  _recordEvent(message) {
    const { method, params } = message
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || [])
        .map((arg) => {
          if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
          if (arg.description) return arg.description
          if (arg.unserializableValue) return arg.unserializableValue
          return `<${arg.type}>`
        })
        .join(' ')
      const stack = params.stackTrace?.callFrames?.[0]
      const item = {
        level: params.type,
        text,
        url: stack?.url,
        line: stack?.lineNumber,
      }
      this.consoleMessages.push(item)
      if (params.type === 'error' || params.type === 'assert') this.consoleErrors.push(item)
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {}
      const description =
        details.exception?.description || details.text || '未知页面异常'
      this.pageErrors.push({
        text: description,
        url: details.url,
        line: details.lineNumber,
      })
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry || {}
      this.logEntries.push({ level: entry.level, text: entry.text, source: entry.source })
      if (entry.level === 'error') {
        this.consoleErrors.push({ level: 'log-error', text: entry.text, url: entry.url, line: entry.lineNumber })
      }
    }
  }

  /** 订阅 CDP 事件。 */
  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, [])
    this.eventHandlers.get(method).push(handler)
    return () => {
      const list = this.eventHandlers.get(method) || []
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    }
  }

  /** 发送 CDP 命令（带超时）。 */
  send(method, params = {}, { timeoutMs = 20000 } = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP 已关闭，无法发送 ${method}`))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 命令超时（${method}, ${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** 开启 Runtime / Log / Page / Network 域，并开始收集控制台错误与页面异常。 */
  async startCapture({ network = false } = {}) {
    if (this._captureEnabled) return
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    try {
      await this.send('Log.enable')
    } catch {
      /* WebView2 未实现 Log 域时忽略 */
    }
    if (network) await this.send('Network.enable')
    this._captureEnabled = true
  }

  /** 清空已收集的错误，便于按阶段断言。 */
  resetCapture() {
    this.consoleErrors.length = 0
    this.pageErrors.length = 0
    this.logEntries.length = 0
  }

  /** 页面内求值（返回 JS 值的 JSON 形式）。 */
  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 20000, userGesture = true } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue,
        userGesture,
        includeCommandLineAPI: true,
      },
      { timeoutMs },
    )
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        '页面求值异常'
      throw new Error(`页面求值失败: ${description}`)
    }
    return returnByValue ? result.result?.value : result.result
  }

  async navigate(url, { waitForLoad = true, timeoutMs = 30000 } = {}) {
    const loadPromise = waitForLoad ? this.waitForLoad({ timeoutMs }) : Promise.resolve()
    await this.send('Page.navigate', { url })
    await loadPromise
  }

  waitForLoad({ timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this._loadWaiters.indexOf(done)
        if (index >= 0) this._loadWaiters.splice(index, 1)
        reject(new Error(`等待页面 load 事件超时（${timeoutMs}ms）`))
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      this._loadWaiters.push(done)
    })
  }

  /** 等待页面内表达式返回真值；超时抛出并附 body 摘要。 */
  async waitFor(expression, { timeoutMs = 20000, intervalMs = 250, description = expression } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError = ''
    const wrapped = `(() => { try { return Boolean(${expression}) } catch (e) { return 'ERR:' + e.message } })()`
    while (Date.now() < deadline) {
      let value
      try {
        value = await this.evaluate(wrapped)
      } catch (error) {
        lastError = String(error.message || error)
        value = undefined
      }
      if (value === true) return true
      if (typeof value === 'string' && value.startsWith('ERR:')) lastError = value
      await sleep(intervalMs)
    }
    let body = ''
    try {
      body = (await this.evaluate('document.body ? document.body.innerText.slice(0, 500) : ""')) || ''
    } catch {
      /* ignore */
    }
    throw new Error(`等待条件超时（${timeoutMs}ms）：${description}${lastError ? `；最后错误: ${lastError}` : ''}\n页面文本: ${body}`)
  }

  async text(selector) {
    return this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : null })()`,
    )
  }

  async exists(selector) {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`)
  }

  async count(selector) {
    return this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`)
    if (!clicked) throw new Error(`点击失败：找不到元素 ${selector}`)
    return true
  }

  /** 按可见文本点击（按钮/链接/可点击元素）。 */
  async clickByText(text, selectors = 'button, a, [role="button"], label, summary') {
    const payload = JSON.stringify(String(text))
    const clicked = await this.evaluate(`(() => {
      const wanted = ${payload};
      const candidates = [...document.querySelectorAll(${JSON.stringify(selectors)})]
        .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
      let target = candidates.find((el) => (el.innerText || el.textContent || '').trim().startsWith(wanted));
      if (!target) target = candidates.find((el) => (el.innerText || el.textContent || '').trim().includes(wanted));
      if (!target) return null;
      target.scrollIntoView({ block: 'center' });
      target.click();
      return (target.innerText || target.textContent || '').trim().slice(0, 80);
    })()`)
    if (!clicked) throw new Error(`按文本点击失败：找不到可点击元素「${text}」`)
    return clicked
  }

  /** 输入框写值：触发 React 受控组件所需的 input 事件。 */
  async type(selector, value, { clear = true } = {}) {
    const payload = JSON.stringify(String(value))
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if (${clear}) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
      }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${payload});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (!ok) throw new Error(`输入失败：找不到元素 ${selector}`)
    return true
  }

  async pressEnter(selector) {
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', options));
      el.dispatchEvent(new KeyboardEvent('keyup', options));
      return true;
    })()`)
    // 某些 React 表单只监听原生 keydown，可再触发一次 form submit。
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const form = el && el.closest('form');
      if (form) { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true; }
      return false;
    })()`)
  }

  /** 浏览器窗口尺寸（Emulation 覆盖），用于固定截图尺寸。 */
  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    })
  }

  /** 截图到本地文件；返回 { path, bytes }。 */
  async screenshot(path, { format = 'png', fullPage = false } = {}) {
    const params = { format, captureBeyondViewport: fullPage }
    const { data } = await this.send('Page.captureScreenshot', params, { timeoutMs: 30000 })
    if (!data) throw new Error('截图失败：CDP 未返回数据')
    mkdirSync(dirname(path), { recursive: true })
    const buffer = Buffer.from(data, 'base64')
    writeFileSync(path, buffer)
    return { path, bytes: buffer.length }
  }

  async bodyText(limit = 4000) {
    return (await this.evaluate(`document.body ? document.body.innerText.slice(0, ${Number(limit)}) : ''`)) || ''
  }

  /** 读取 __TAURI_INTERNALS__.invoke 的真实后端调用（用于结构化断言，非 UI 替代）。 */
  async tauriInvoke(command, args = null) {
    const argsJson = JSON.stringify(args ?? {})
    return this.evaluate(
      `window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${argsJson}) : Promise.reject(new Error('__TAURI_INTERNALS__ 不存在（非 Tauri 环境）'))`,
    )
  }

  async isTauri() {
    try {
      return Boolean(await this.evaluate('Boolean(window.__TAURI_INTERNALS__)'))
    } catch {
      return false
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 文件 / 哈希工具（供下载验收对照）                                     */
/* ------------------------------------------------------------------ */

export function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next
        index += 1
      } else {
        options[key] = true
      }
    } else if (!options.command) {
      options.command = token
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const command = options.command || 'list'
  const port = Number(options.port || PORT_EDGE)
  if (command === 'list') {
    const version = await versionInfo(port)
    console.log(`CDP version: ${JSON.stringify({ Browser: version.Browser, 'Protocol-Version': version['Protocol-Version'] })}`)
    const targets = await listTargets(port)
    for (const target of targets) {
      console.log(`[${target.type}] ${target.title || ''}  ${target.url}`)
      console.log(`    ws: ${target.webSocketDebuggerUrl || '(none)'}`)
    }
    return
  }
  if (command === 'watch') {
    const seconds = Number(options.seconds || 10)
    const client = await connect(port)
    await client.startCapture()
    console.log(`已连接 ${client.target?.url || client.wsUrl}，监听 ${seconds}s ...`)
    const started = Date.now()
    while (Date.now() - started < seconds * 1000) {
      await sleep(1000)
    }
    console.log(`consoleErrors=${client.consoleErrors.length} pageErrors=${client.pageErrors.length}`)
    for (const item of client.consoleErrors) console.log(`  [console.${item.level}] ${item.text}`)
    for (const item of client.pageErrors) console.log(`  [exception] ${item.text}`)
    await client.close()
    return
  }
  const client = await connect(port)
  await client.startCapture()
  try {
    if (command === 'eval') {
      const value = await client.evaluate(options.expr || 'document.title')
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    } else if (command === 'shot') {
      const out = options.out || '.temp/qa/cdp-shot.png'
      const result = await client.screenshot(out)
      console.log(`saved ${result.path} (${result.bytes} bytes)`)
    } else if (command === 'nav') {
      await client.navigate(options.url || 'http://localhost:1420/?mock=1')
      await sleep(1000)
      console.log(`navigated: ${await client.evaluate('location.href')}`)
      console.log(`title: ${await client.evaluate('document.title')}`)
    } else {
      throw new Error(`未知命令：${command}`)
    }
  } finally {
    await client.close()
  }
}

const isDirectRun = process.argv[1] && /cdp\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))
if (isDirectRun) {
  main().catch((error) => {
    console.error('ERR', error.message || error)
    process.exit(1)
  })
}
