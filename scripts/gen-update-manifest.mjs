/**
 * v0.5.0：生成 Tauri updater 更新清单 latest.json（CI 发布时执行）。
 *
 * 输入（约定路径/环境变量）：
 * - package.json 的 version；docs/RELEASE-NOTES.md 作为 notes；
 * - src-tauri/target/release/bundle/nsis/*.sig（tauri build 在 createUpdaterArtifacts 且
 *   配置了签名私钥时生成的 minisign 签名；不存在时跳过生成——无签名密钥的 fork PR 场景）。
 * - GITHUB_REPOSITORY（owner/repo）与 GITHUB_REF_NAME（发布 tag，缺省 v{version}）。
 *
 * 输出：release-assets/latest.json，url 指向发布时重命名后的 setup.exe 资产名。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const assetsDir = path.resolve(root, process.argv[2] ?? 'release-assets')

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')

const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const sigFile = path.join(bundleDir, `${config.productName}_${version}_x64-setup.exe.sig`)
const releaseTag = process.env.GITHUB_REF_TYPE === 'tag'
if (!existsSync(sigFile)) {
  if (releaseTag) throw new Error(`正式发布缺少安装包签名：${sigFile}`)
  console.log('未找到 updater 签名产物（.sig），跳过 latest.json 生成（无签名密钥时属正常）。')
  process.exit(0)
}

const repo = process.env.GITHUB_REPOSITORY
if (!repo || !repo.includes('/')) {
  throw new Error('缺少环境变量 GITHUB_REPOSITORY（owner/repo），无法生成 latest.json')
}
const tag = `v${version}`
if (releaseTag && process.env.GITHUB_REF_NAME !== tag) throw new Error('发布标签与应用版本不一致')
const signature = readFileSync(sigFile, 'utf8').trim()
if (!signature) throw new Error('安装包签名为空')
// 与 ci.yml 发布资产命名保持一致（setup.exe 重命名后的名字）。
const setupName = `Model-Download-Manager_${version}_x64-setup.exe`
const notes = readFileSync(path.join(root, 'docs', 'RELEASE-NOTES.md'), 'utf8')

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${setupName}`,
    },
  },
}

writeFileSync(path.join(assetsDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`latest.json 已生成：v${version} → ${setupName}`)
