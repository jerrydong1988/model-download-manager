// v0.1.4 真机验证：恢复用户暂停任务 → 断言 UI 显示「下载中 + 速度」→ 重新暂停。
// 用法：node scripts/verify-v014-state.mjs [port] [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CDP = `http://127.0.0.1:${process.argv[2] || '9223'}`
const OUT = process.argv[3] || '.temp/v014-verify'
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
  if (!page) throw new Error('no page target')
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
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res?.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
    return res?.result?.value
  }
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    console.log('saved', join(OUT, `${name}.png`))
  }

  await evaluate(`location.hash = '#/downloads'`)
  await sleep(1600)
  const snapshot = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_snapshot')`)
  const task = (snapshot?.tasks ?? []).find((t) => t.status !== 'completed' && t.status !== 'cancelled')
  if (!task) throw new Error('没有可恢复的任务')
  console.log('task:', task.fileName, 'status=', task.status, 'downloaded=', task.downloaded)
  await shot('01-paused-before')

  console.log('resume_download →', await evaluate(`window.__TAURI_INTERNALS__.invoke('resume_download', { taskId: ${JSON.stringify(task.taskId)} })`))

  let dom = ''
  let passed = false
  for (let i = 0; i < 20; i += 1) {
    await sleep(600)
    dom = await evaluate(`document.body.innerText`)
    const hasActive = dom.includes('下载中')
    const hasWaiting = dom.includes('等待空闲并发槽')
    const speedMatch = dom.match(/([\d.]+)\s*(B|KB|MB|GB)\/s/)
    console.log(`poll ${i}: active=${hasActive} waiting=${hasWaiting} speed=${speedMatch ? speedMatch[0] : '-'}`)
    if (hasActive && speedMatch && !hasWaiting) {
      passed = true
      break
    }
  }
  await shot('02-active')
  console.log('ACTIVE_UI_OK=', passed)
  console.log('--- downloads page text ---')
  console.log(dom.slice(0, 900))

  console.log('pause_download →', await evaluate(`window.__TAURI_INTERNALS__.invoke('pause_download', { taskId: ${JSON.stringify(task.taskId)} })`))
  await sleep(2500)
  const paused = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_snapshot')`)
  const now = (paused?.tasks ?? []).find((t) => t.taskId === task.taskId)
  console.log('after pause: status=', now?.status, 'downloaded=', now?.downloaded)
  await shot('03-paused-after')

  ws.close()
  if (!passed) process.exit(1)
}

main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
