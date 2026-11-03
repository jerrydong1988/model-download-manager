// 从已安装的 v0.1.3 应用通过 CDP 截图（真实数据模式，light + dark）。
// 用法：node scripts/shoot-installed-v013.mjs [port] [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CDP = `http://127.0.0.1:${process.argv[2] || '9223'}`
// Real application captures can contain private paths and must stay out of the public gallery.
const OUT = process.argv[3] || '.temp/private-screenshots'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRelative = relative(projectRoot, resolve(OUT))
const outputInProject = outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`) && !isAbsolute(outputRelative)
if (outputInProject && outputRelative !== '.temp' && !outputRelative.startsWith(`.temp${sep}`)) {
  throw new Error('真实应用截图请保存到私有临时目录；公开图库使用 capture-public-screenshots.mjs。')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  const http = await import('node:http')
  return new Promise((resolve, reject) => {
    http.default
      .get(url, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const targets = await getJson(`${CDP}/json/list`)
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  if (!page) throw new Error(`no page target: ${JSON.stringify(targets.map((t) => t.url))}`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result)
      pending.delete(msg.id)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  await send('Page.enable')
  await send('Runtime.enable')

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return res?.result?.value
  }

  const go = async (hash, wait = 1500) => {
    await evaluate(`location.hash = ${JSON.stringify(`#/${hash}`)}`)
    await sleep(wait)
  }

  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    console.log('saved', join(OUT, `${name}.png`))
  }

  // Light theme
  await evaluate(`document.documentElement.dataset.theme='light'; document.documentElement.style.colorScheme='light'`)
  await sleep(600)

  await go('browse', 2000)
  await shot('01-browse')

  // 仓库详情：点击第一个仓库卡片
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('/'));
    if (!btn) return null;
    btn.click();
    return (btn.innerText || '').slice(0, 80);
  })()`)
  console.log('repo card clicked:', clicked)
  await sleep(3500)
  await shot('05-repo-detail')

  await go('downloads', 1200)
  await shot('02-downloads')

  await go('library', 3000)
  await shot('03-library')

  await go('settings', 1500)
  await shot('04-settings')

  // Dark theme
  await evaluate(`document.documentElement.dataset.theme='dark'; document.documentElement.style.colorScheme='dark'`)
  await sleep(700)

  await go('browse', 1500)
  await shot('dark-01-browse')
  await go('downloads', 1000)
  await shot('dark-02-downloads')
  await go('library', 2000)
  await shot('dark-03-library')
  await go('settings', 1200)
  await shot('dark-04-settings')

  // 恢复浅色，避免影响用户界面
  await evaluate(`document.documentElement.dataset.theme='light'; document.documentElement.style.colorScheme='light'; location.hash='#/browse'`)
  ws.close()
}

main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
