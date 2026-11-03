/**
 * tests/e2e/library-fixture.mjs — 本地模型库目录树验收用测试目录构造器
 *
 * 与用户真实下载目录同类布局（不含用户真实文件，全部写入临时目录）：
 *   unsloth/flint-GGUF/{3 个 gguf, imatrix.gguf_file, configuration.json, assets/2 png}
 *   Qwen/Qwen2.5-0.5B-Instruct/{model.safetensors, config.json, tokenizer.json}
 *   根目录散落 {ggml-model-Q4_K_M.gguf, README.md}
 *   DemoLibrary/Nova/models/x/model-00001-of-00004.safetensors（深层目录链）
 *   bulk/ 下 100 个小文件（窗口化/性能）
 * 合计 113 个文件，展开全部后 124 行（11 个目录节点 + 113 个文件）。
 *
 * 用法（CLI）：node tests/e2e/library-fixture.mjs --root <目录> [--json]
 * 库用法：import { createLibraryFixture, fixtureSummary } from './library-fixture.mjs'
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEIGHT_EXTENSIONS = new Set([
  '.safetensors', '.bin', '.pt', '.pth', '.gguf', '.gguf_file', '.hgn', '.onnx',
  '.onnx_data', '.ckpt', '.h5', '.msgpack', '.npy', '.npz', '.engine', '.tflite',
  '.mlmodel', '.ot', '.pkl', '.pickle', '.joblib', '.keras', '.nemo', '.sft',
  '.mindir', '.om', '.plan', '.dat',
])
const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.txt', '.md', '.model', '.tiktoken', '.py',
  '.jinja', '.cfg', '.ini', '.toml', '.spm', '.vocab',
])

/** 契约 `classify_file`（v0.1.3）的前端等价实现（仅用于对比 DOM 统计，不改应用）。 */
export function classifyFile(filePath) {
  const name = String(filePath).split(/[/\\]/).pop().toLowerCase()
  if (name.endsWith('.safetensors.index.json') || name.endsWith('.bin.index.json')) return 'weight'
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return 'other'
  const ext = name.slice(dot + 1)
  if (!WEIGHT_EXTENSIONS.has('.' + ext)) return CONFIG_EXTENSIONS.has('.' + ext) ? 'config' : 'other'
  const tokens = name.split(/[.\-_\s]+/).filter(Boolean)
  if (tokens.some((token) => token === 'mmproj' || token === 'clip')) return 'mmproj'
  if (tokens.some((token) => token === 'imatrix')) return 'imatrix'
  return 'weight'
}

function bulkFiles() {
  return Array.from({ length: 100 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0')
    return { path: `bulk/bulk-${number}.dat`, size: 1024 }
  })
}

/** 测试树文件清单（路径相对测试根目录）。 */
export const FIXTURE_FILES = [
  { path: 'unsloth/flint-GGUF/flint-UD-Q6_K_XL.gguf', size: 1_572_864 },
  { path: 'unsloth/flint-GGUF/flint-UD-Q5_K_XL.gguf', size: 1_310_720 },
  { path: 'unsloth/flint-GGUF/flint-Q8_0.gguf', size: 2_097_152 },
  { path: 'unsloth/flint-GGUF/imatrix_unsloth.gguf_file', size: 4_096 },
  { path: 'unsloth/flint-GGUF/configuration.json', size: 1_024 },
  { path: 'unsloth/flint-GGUF/assets/size_vs_top1.png', size: 65_536 },
  { path: 'unsloth/flint-GGUF/assets/size_vs_kld.png', size: 49_152 },
  { path: 'Qwen/Qwen2.5-0.5B-Instruct/model.safetensors', size: 102_400 },
  { path: 'Qwen/Qwen2.5-0.5B-Instruct/config.json', size: 659 },
  { path: 'Qwen/Qwen2.5-0.5B-Instruct/tokenizer.json', size: 8_192 },
  { path: 'ggml-model-Q4_K_M.gguf', size: 40_960 },
  { path: 'README.md', size: 2_048 },
  { path: 'DemoLibrary/Nova/models/x/model-00001-of-00004.safetensors', size: 32_768 },
  ...bulkFiles(),
]

/** 构造测试目录；返回 manifest（含每个文件绝对路径/大小/类型与目录聚合）。 */
export function createLibraryFixture(rootDir, { clean = true } = {}) {
  if (clean) rmSync(rootDir, { recursive: true, force: true })
  mkdirSync(rootDir, { recursive: true })
  const files = []
  FIXTURE_FILES.forEach((spec, index) => {
    const absolute = join(rootDir, ...spec.path.split('/'))
    mkdirSync(dirname(absolute), { recursive: true })
    // 确定性内容（同一文件多次构造字节一致），便于删除/校验。
    const buffer = Buffer.alloc(spec.size)
    const seed = (index * 37 + 11) % 251
    for (let offset = 0; offset < spec.size; offset += 1) {
      buffer[offset] = (seed + offset) % 256
    }
    writeFileSync(absolute, buffer)
    files.push({
      ...spec,
      absolute,
      kind: classifyFile(spec.path.split('/').pop()),
    })
  })
  return { rootDir, files, ...computeAggregates(rootDir, files) }
}

/** 从磁盘重新统计（用于“与磁盘实测对照”）。 */
export function computeAggregates(rootDir, files) {
  const totals = {
    files: files.length,
    bytes: 0,
    kinds: { weight: 0, mmproj: 0, imatrix: 0, config: 0, other: 0 },
    kindBytes: { weight: 0, mmproj: 0, imatrix: 0, config: 0, other: 0 },
  }
  const dirs = new Map()
  dirs.set('', { fileCount: 0, totalSize: 0 })
  const ensure = (path) => {
    if (!dirs.has(path)) dirs.set(path, { fileCount: 0, totalSize: 0 })
    return dirs.get(path)
  }
  for (const file of files) {
    totals.bytes += file.size
    totals.kinds[file.kind] += 1
    totals.kindBytes[file.kind] += file.size
    const relative = file.path ?? file.relativePath
    const segments = relative.split('/')
    segments.pop() // 文件名
    let current = ''
    const rootBucket = ensure('')
    rootBucket.fileCount += 1
    rootBucket.totalSize += file.size
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      const bucket = ensure(current)
      bucket.fileCount += 1
      bucket.totalSize += file.size
    }
  }
  return { totals, dirs: Object.fromEntries([...dirs.entries()].map(([key, value]) => [key, { ...value }])) }
}

/** 期望的树摘要（目录节点数、展开全部行数等）。 */
export function fixtureSummary(manifest) {
  const allDirs = Object.keys(manifest.dirs).filter((path) => path !== '')
  return {
    fileCount: manifest.totals.files,
    totalBytes: manifest.totals.bytes,
    kinds: manifest.totals.kinds,
    kindBytes: manifest.totals.kindBytes,
    dirCount: allDirs.length, // 不含根
    dirNodeCount: allDirs.length + 1, // 含根
    expandedAllRowCount: allDirs.length + 1 + manifest.totals.files,
    topLevelDirs: ['bulk', 'DemoLibrary', 'Qwen', 'unsloth'],
  }
}

export function removeLibraryFixture(rootDir) {
  rmSync(rootDir, { recursive: true, force: true })
  return !existsSync(rootDir)
}

/* CLI */
const isDirectRun = process.argv[1] && /library-fixture\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))
if (isDirectRun) {
  const args = process.argv.slice(2)
  const rootIndex = args.indexOf('--root')
  const root = rootIndex >= 0 ? args[rootIndex + 1] : null
  if (!root) {
    console.error('用法：node tests/e2e/library-fixture.mjs --root <目录> [--json]')
    process.exit(2)
  }
  const manifest = createLibraryFixture(root)
  const summary = fixtureSummary(manifest)
  if (args.includes('--json')) {
    console.log(JSON.stringify({ summary, manifest }, null, 2))
  } else {
    console.log(`已构造测试目录：${manifest.rootDir}`)
    console.log(`文件 ${summary.fileCount} 个，总大小 ${summary.totalBytes} B；类型统计=${JSON.stringify(summary.kinds)}`)
    console.log(`目录节点 ${summary.dirNodeCount} 个（含根）；展开全部应为 ${summary.expandedAllRowCount} 行`)
  }
}
