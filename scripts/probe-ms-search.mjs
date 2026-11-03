// Capture ModelScope search XHR endpoints via Chrome DevTools Protocol.
// Prereq: Edge/Chrome running with --remote-debugging-port=9222.
// Usage: node scripts/probe-ms-search.mjs [url] [waitMs]

const CDP = 'http://127.0.0.1:9222'
const targetUrl = process.argv[2] || 'https://www.modelscope.cn/models?name=Qwen'
const waitMs = Number(process.argv[3] || 18000)

function getJson(url) {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ default: http }) => {
      http.get(url, (r) => {
        let data = ''
        r.on('data', (c) => (data += c))
        r.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
      }).on('error', reject)
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const targets = await getJson(`${CDP}/json/list`)
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  console.log('target:', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const requests = []
  const responses = []

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Network.requestWillBeSent') {
      const { request } = msg.params
      if (/\/api\/|modelscope\.cn\/api/.test(request.url)) {
        requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          postData: request.postData,
          type: msg.params.type,
        })
      }
    }
    if (msg.method === 'Network.responseReceived') {
      const { response } = msg.params
      if (/\/api\//.test(response.url)) {
        responses.push({ status: response.status, url: response.url, mime: response.mimeType })
      }
    }
  })

  await new Promise((resolve) => ws.addEventListener('open', resolve))
  await send('Network.enable', { maxPostDataSize: 8192 })
  await send('Page.enable')
  await send('Page.navigate', { url: targetUrl })
  await sleep(waitMs)

  // Deduplicate by method+url.
  const seen = new Set()
  console.log('\n=== API REQUESTS ===')
  for (const r of requests) {
    const key = `${r.method} ${r.url}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`${r.method} ${r.url}`)
    if (r.postData) console.log(`  body: ${r.postData.slice(0, 900)}`)
    const interesting = ['authorization', 'cookie', 'x-requested-with', 'content-type', 'x-csrf-token', 'referer']
    for (const h of interesting) {
      if (r.headers[h]) console.log(`  ${h}: ${String(r.headers[h]).slice(0, 200)}`)
    }
  }
  console.log('\n=== RESPONSES ===')
  const seenR = new Set()
  for (const r of responses) {
    const key = `${r.status} ${r.url}`
    if (seenR.has(key)) continue
    seenR.add(key)
    console.log(`${r.status} ${r.url}`)
  }
  ws.close()
}

main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
