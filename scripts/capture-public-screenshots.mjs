// Public gallery: capture only the browser mock with synthetic data.
// Start Vite and a dedicated headless Chromium profile, then run:
// node scripts/capture-public-screenshots.mjs http://127.0.0.1:14310 19310
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect, sleep } from '../tests/e2e/cdp.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = new URL(process.argv[2] || 'http://127.0.0.1:14310')
if (!['127.0.0.1', 'localhost'].includes(BASE.hostname) || BASE.protocol !== 'http:') {
  throw new Error('Use a dedicated local Vite server.')
}
const PORT = Number(process.argv[3] || 19310)
const OUT = join(ROOT, 'docs', 'screenshots')
const client = await connect(PORT)
const records = []
let navigationIndex = 0
try {
  await client.startCapture()
  await client.navigate('about:blank')
  await client.send('Log.clear')
  await client.send('Runtime.discardConsoleEntries')
  client.resetCapture()
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  // Freeze mock progress between captures; no application/backend state is touched.
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.setInterval = () => 0;' })
  const load = async (page, extra = '', theme = 'light') => {
    await client.navigate(`${BASE.origin}/?mock=1&capture=${Date.now()}-${++navigationIndex}${extra}#/${page}`)
    await client.waitFor("document.body.innerText.includes('演示数据') && document.body.innerText.includes('v0.2.1')", { timeoutMs: 30000 })
    await client.evaluate(`(async () => {
      if (window.__TAURI_INTERNALS__) throw new Error('Native application capture is forbidden');
      const ipc = await import('/src/lib/ipc.ts');
      if (!ipc.IS_MOCK_MODE) throw new Error('Mock mode required');
      const s = await ipc.getSettings(); await ipc.saveSettings({...s, theme: ${JSON.stringify(theme)}});
      await document.fonts.ready;
    })()`)
    await sleep(700)
  }
  const shot = async (name) => {
    const visible = await client.evaluate(`document.body.innerText + '\\n' + [...document.querySelectorAll('input')].map(e=>e.value).join('\\n')`)
    if (/[A-Za-z]:[\\/]+Users[\\/]+/i.test(visible) || /\b(?:hf_[A-Za-z0-9]{25,}|gh[pousr]_[A-Za-z0-9]{30,})\b/.test(visible)) {
      throw new Error(`Private path or credential in ${name}`)
    }
    if (!visible.includes('演示数据')) throw new Error(`Missing demo indicator in ${name}`)
    const info = await client.screenshot(join(OUT, `${name}.png`))
    records.push({ file: `${name}.png`, bytes: info.bytes, mock: true })
    console.log(`captured ${name}`)
  }
  const detail = async () => {
    const clicked = await client.evaluate(`(() => { const e=document.querySelector('button[aria-label="打开仓库 Qwen/Qwen2.5-7B-Instruct"]'); e?.click(); return !!e; })()`)
    if (!clicked) throw new Error('Demo repository card missing')
    await client.waitFor("!!document.querySelector('button[aria-label^=\"选择 HuggingFace revision\"]')")
    await sleep(500)
  }
  for (const [page, name] of [['browse','01-browse'],['downloads','02-downloads'],['library','03-library'],['settings','04-settings']]) {
    await load(page); await shot(name)
  }
  await load('browse'); await detail(); await shot('05-repo-detail')
  await load('downloads')
  await client.evaluate("import('/src/lib/ipc.ts').then(m=>m.pauseAll())")
  await sleep(500); await shot('06-paused-resume')
  await client.evaluate(`document.querySelector('button[aria-label="查看键盘快捷键（按 ? 打开）"]').click()`)
  await sleep(300); await shot('07-shortcuts-help')
  await load('library', '&multiroot=1'); await shot('11-library-multiroot')
  await load('browse'); await detail()
  await client.evaluate(`document.querySelector('button[aria-label^="选择 HuggingFace revision"]').click()`)
  await sleep(300); await shot('12-revision-selector')
  await load('settings')
  await client.evaluate(`(() => { const e=[...document.querySelectorAll('h2,h3')].find(e=>e.textContent.includes('下载引擎'));e?.scrollIntoView({block:'center'}); })()`)
  await sleep(200); await shot('13-settings-engine')
  await load('downloads'); await shot('14-task-revision-badge')
  for (const [page,name] of [['browse','dark-01-browse'],['downloads','dark-02-downloads'],['library','dark-03-library'],['settings','dark-04-settings']]) {
    await load(page,'','dark'); await shot(name)
  }
  if (client.pageErrors.length || client.consoleErrors.length) throw new Error(`Capture errors: ${JSON.stringify({page:client.pageErrors,console:client.consoleErrors})}`)
  mkdirSync(join(ROOT,'.temp'), {recursive: true})
  writeFileSync(join(ROOT,'.temp','public-screenshot-verification.json'),JSON.stringify({records,pageErrors:client.pageErrors,consoleErrors:client.consoleErrors},null,2))
} finally {
  await client.close()
}
