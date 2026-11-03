// Capture app screenshots (mock mode) via CDP for visual QA.
// Prereq: dev server on http://localhost:1420, Edge with --remote-debugging-port=9222.
// Usage: node scripts/shoot-ui.mjs [baseUrl] [outDir]

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const CDP = 'http://127.0.0.1:9222'
const baseUrl = process.argv[2] || 'http://localhost:1420/?mock=1'
const outDir = process.argv[3] || '.temp/shots'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  const http = await import('node:http')
  return new Promise((resolve, reject) => {
    http.default.get(url, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const targets = await getJson(`${CDP}/json/list`)
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id
    pending.set(msgId, resolve)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: baseUrl })
  await sleep(5000)

  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const path = join(outDir, `${name}.png`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    console.log('saved', path)
  }

  const clickByText = async (text) => {
    const expr = `(() => {
      const els = [...document.querySelectorAll('button, a, [role="button"], div')].filter(el => el.offsetParent !== null)
      const target = els.find(el => (el.innerText || '').trim().startsWith(${JSON.stringify(text)}))
      if (target) { target.click(); return target.innerText.trim().slice(0, 60) }
      return null
    })()`
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    return res.result?.value ?? null
  }

  // Dump current visible nav labels to adapt.
  const navDump = await send('Runtime.evaluate', {
    expression: `JSON.stringify([...document.querySelectorAll('aside button, nav button, aside a, nav a')].map(b => (b.innerText||'').trim()).filter(Boolean).slice(0, 20))`,
    returnByValue: true,
  })
  console.log('NAV:', navDump.result?.value)

  await shot('01-browse')

  const pages = [
    ['下载队列', '02-downloads'],
    ['本地模型库', '03-library'],
    ['设置', '04-settings'],
    ['浏览仓库', '05-browse-again'],
  ]
  for (const [label, name] of pages) {
    const clicked = await clickByText(label)
    console.log(`click ${label}:`, clicked)
    await sleep(1500)
    await shot(name)
  }

  // Console errors / page text length sanity.
  const text = await send('Runtime.evaluate', {
    expression: `document.body.innerText.slice(0, 600)`,
    returnByValue: true,
  })
  console.log('---BODY---\n' + (text.result?.value || ''))
  ws.close()
}

main().catch((e) => { console.error('ERR', e); process.exit(1) })
