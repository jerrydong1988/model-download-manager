// Verify the exact installer and update feed that will be attached to the release.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const assets = path.resolve(process.argv[2] ?? 'release-assets')
const manifest = JSON.parse(readFileSync(path.join(assets, 'latest.json'), 'utf8'))
const { version } = config
const tag = `v${version}`
const repo = process.env.GITHUB_REPOSITORY
assert.ok(repo && repo.includes('/'), '缺少发布仓库名')
assert.equal(process.env.GITHUB_REF_NAME, tag)
assert.equal(manifest.version, version)
const entry = manifest.platforms['windows-x86_64']
const filename = `Model-Download-Manager_${version}_x64-setup.exe`
assert.equal(entry.url, `https://github.com/${repo}/releases/download/${tag}/${filename}`)

// Tauri's minisign packets contain an algorithm (2 bytes), key ID (8 bytes)
// and an Ed25519 key or signature. ED signs the BLAKE2b-512 digest.
const envelope = base64 => Buffer.from(base64, 'base64').toString('utf8').trim().split(/\r?\n/)
const key = Buffer.from(envelope(config.plugins.updater.pubkey)[1], 'base64')
const [, sigLine, commentLine, globalLine] = envelope(entry.signature)
const packet = Buffer.from(sigLine, 'base64')
assert.equal(key.length, 42)
assert.equal(packet.length, 74)
assert.equal(packet.toString('ascii', 0, 2), 'ED')
assert.deepEqual(packet.subarray(2, 10), key.subarray(2, 10), '更新签名与应用公钥不匹配')
const publicKey = createPublicKey({
  format: 'der', type: 'spki',
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
})
const signature = packet.subarray(10)
const digest = createHash('blake2b512').update(readFileSync(path.join(assets, filename))).digest()
assert.ok(verify(null, digest, publicKey, signature), '安装包内容与签名不一致')
assert.ok(commentLine.startsWith('trusted comment: '))
const comment = commentLine.slice('trusted comment: '.length)
assert.ok(verify(null, Buffer.concat([signature, Buffer.from(comment)]), publicKey, Buffer.from(globalLine, 'base64')), '版本签名无效')
assert.ok(comment.split('\t').includes(`version:${version}`), '签名绑定的版本不符')
console.log(`Verified signed update feed for ${tag}`)
