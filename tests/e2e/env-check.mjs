#!/usr/bin/env node
/**
 * tests/e2e/env-check.mjs — 验收环境自检（Phase A/B 前置）
 *
 * 检查项：Node/cargo/rustc 版本、npm 依赖、WebView2 运行时、Edge 浏览器、
 * 应用数据目录、debug/release exe、dist、NSIS 工具链可达性、网络（hf-mirror / ModelScope）、端口占用。
 * 退出码非 0 表示存在必须修复的前置条件（警告项不阻塞）。
 *
 * 用法：node tests/e2e/env-check.mjs [--json]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..', '..')
const results = []

function record(name, ok, detail = '', { warn = false } = {}) {
  results.push({ name, ok, detail, warn })
  console.log(`${warn && !ok ? 'WARN' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  →  ${detail}` : ''}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options })
  if (result.error) throw new Error(String(result.error.message || result.error))
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || '').trim().split('\n')[0] || `exit=${result.status}`)
  return (result.stdout || '').trim()
}

async function httpStatus(url, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    return response.status
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log('=== 环境自检 ===')
  console.log(`项目根目录：${ROOT}\n`)

  /* ---- 运行时 ---- */
  try {
    const version = run('node', ['--version'])
    record('Node.js', Number(version.replace('v', '').split('.')[0]) >= 22, version)
  } catch (error) {
    record('Node.js', false, error.message)
  }
  try {
    record('cargo', true, run('cargo', ['--version']))
  } catch (error) {
    record('cargo', false, error.message)
  }
  try {
    record('rustc', true, run('rustc', ['--version']))
  } catch (error) {
    record('rustc', false, error.message)
  }
  record('npm 依赖已安装（node_modules/@tauri-apps/cli）', existsSync(join(ROOT, 'node_modules', '@tauri-apps', 'cli')), join(ROOT, 'node_modules'))

  /* ---- WebView2 / Edge ---- */
  const webview2Keys = [
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  ]
  let webview2Version = ''
  for (const key of webview2Keys) {
    try {
      const value = run('pwsh', ['-NoProfile', '-Command', `(Get-ItemProperty '${key}' -ErrorAction Stop).pv`])
      if (value) {
        webview2Version = value
        break
      }
    } catch {
      /* 继续尝试下一个注册表位置 */
    }
  }
  record('WebView2 运行时', Boolean(webview2Version), webview2Version || '未安装（Win10 需安装 Evergreen WebView2 Runtime）')
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  const edgePath = edgePaths.find((path) => existsSync(path))
  record('Edge 浏览器（备用 CDP 目标）', Boolean(edgePath), edgePath || '')

  /* ---- 构建产物 ---- */
  const debugExe = join(ROOT, 'src-tauri', 'target', 'debug', 'model-download-manager.exe')
  const releaseExe = join(ROOT, 'src-tauri', 'target', 'release', 'model-download-manager.exe')
  const distDir = join(ROOT, 'dist')
  const distIndex = join(distDir, 'index.html')
  record('前端 dist/index.html', existsSync(distIndex), distDir)
  record('debug exe', existsSync(debugExe), debugExe, { warn: true })
  record('release exe', existsSync(releaseExe), releaseExe, { warn: true })
  if (existsSync(distIndex)) {
    record('dist 资源目录', existsSync(join(distDir, 'assets')), join(distDir, 'assets'))
  }

  /* ---- NSIS / 打包工具链 ---- */
  const nsisCache = join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS')
  record('NSIS 缓存/Tauri 打包目录', existsSync(nsisCache), nsisCache, { warn: true })
  try {
    const status = await httpStatus('https://github.com/tauri-apps/binary-releases/releases')
    record('github.com（NSIS 下载源）可达', status >= 200 && status < 400, `HTTP ${status}`)
  } catch (error) {
    record('github.com（NSIS 下载源）可达', false, String(error.message || error))
  }

  /* ---- 网络：数据源 ---- */
  for (const [label, url] of [
    ['hf-mirror API', 'https://hf-mirror.com/api/models?search=tiny&limit=1'],
    ['hf-mirror resolve（tiny 小文件）', 'https://hf-mirror.com/hf-internal-testing/tiny-random-gpt2/resolve/main/config.json'],
    ['ModelScope API', 'https://www.modelscope.cn/api/v1/models/Qwen/Qwen2.5-0.5B-Instruct'],
    ['ModelScope resolve（config.json）', 'https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct/resolve/master/config.json'],
  ]) {
    try {
      const status = await httpStatus(url)
      record(`网络：${label}`, status >= 200 && status < 400, `HTTP ${status}`)
    } catch (error) {
      record(`网络：${label}`, false, String(error.message || error))
    }
  }

  /* ---- 端口占用 ---- */
  for (const [label, port] of [
    ['vite dev server 1420', 1420],
    ['Edge CDP 9222', 9222],
    ['WebView2 CDP 9223', 9223],
  ]) {
    let inUse = false
    try {
      const output = run('pwsh', [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${port} } | Measure-Object).Count`,
      ])
      inUse = Number(output) > 0
    } catch {
      inUse = false
    }
    record(`端口 ${port} 占用（${label}）`, true, inUse ? '已监听' : '未监听（按需启动）', { warn: false })
  }

  /* ---- 遗留进程 ---- */
  try {
    const processes = run('pwsh', [
      '-NoProfile',
      '-Command',
      "(Get-Process -Name 'model-download-manager','cargo','rustc' -ErrorAction SilentlyContinue | Select-Object ProcessName,Id | ConvertTo-Json -Compress)",
    ])
    const parsed = processes ? JSON.parse(processes) : []
    const list = Array.isArray(parsed) ? parsed : [parsed]
    record(
      '无遗留 cargo/rustc（避免 target 锁冲突）',
      list.filter((item) => ['cargo', 'rustc'].includes(item.ProcessName)).length === 0,
      list.map((item) => `${item.ProcessName}:${item.Id}`).join(', ') || '无',
      { warn: true },
    )
  } catch (error) {
    record('遗留进程检查', false, String(error.message || error), { warn: true })
  }

  const failed = results.filter((item) => !item.ok && !item.warn)
  const warned = results.filter((item) => !item.ok && item.warn)
  console.log(`\n合计：${results.length - failed.length - warned.length} PASS / ${warned.length} WARN / ${failed.length} FAIL`)
  if (failed.length > 0) {
    console.log('\n必须修复的前置条件：')
    for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`)
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ results, failed: failed.length }, null, 2))
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('环境自检异常：', error)
  process.exit(1)
})
