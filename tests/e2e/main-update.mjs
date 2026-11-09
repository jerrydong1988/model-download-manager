// Exercise the built UI with the mock installer. No native updater runs.
import assert from 'node:assert/strict'
import { connect } from './cdp.mjs'

const client = await connect(19325)
try {
  await client.startCapture()
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  for (const [entry, page] of [['toast', 'browse'], ['sidebar', 'downloads']]) {
    await client.navigate(`http://127.0.0.1:4173/?mock=1&update=1&entry=${entry}#/${page}`)
    const buttons = entry === 'toast' ? '[role="status"] button' : 'aside button'
    const action = `[...document.querySelectorAll('${buttons}')].find(b => b.innerText.trim().startsWith('立即升级'))`
    await client.waitFor(`Boolean(${action})`)
    await client.evaluate(`{ const button = ${action}; button.click(); button.click(); }`)
    await client.waitFor("document.querySelector('aside [role=status]')?.textContent.includes('正在下载更新')")
    await client.waitFor("document.querySelector('aside [role=status]')?.textContent.includes('正在重启')")
    assert.equal(await client.evaluate('location.hash'), `#/${page}`)
    assert.equal(await client.evaluate("window.__MDM_MOCK_CALLS__.filter(c => c.command === 'install_update').length"), 1)
    assert.equal(await client.evaluate("document.querySelector('[role=dialog]') !== null"), false)
    console.log(`Passed: ${entry} starts one installation and stays on ${page}`)
  }
} finally {
  await client.close()
}
