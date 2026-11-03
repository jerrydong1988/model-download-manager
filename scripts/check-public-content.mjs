// Run before publishing: check source paths, obvious credentials and gallery links.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const paths = [...new Set(execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {encoding:'utf8'}).split('\0').filter(Boolean))]
const failures = []
let checked = 0
for (const path of paths) {
  const full = join(root,path)
  if (!existsSync(full) || !statSync(full).isFile()) continue
  checked++
  if (/(^|\/)(node_modules|target|dist|\.temp)(\/|$)|(^|\/)(settings|tasks)\.json$|\.part(?:\.json)?$|(^|\/)\.env(?:$|\.(?!example$))/.test(path)) failures.push(`${path}: runtime/build data`)
  const bytes = readFileSync(full)
  if (bytes.includes(0)) continue
  const text = bytes.toString('utf8')
  const rules = [
    ['personal home path', /[A-Za-z]:[\\/]+Users[\\/]+[^\s\\/"'`<>]+/i],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['credential', /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{25,}|sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/],
  ]
  for (const [label,pattern] of rules) if (pattern.test(text)) failures.push(`${path}: ${label}`)
  if (path.endsWith('.md')) {
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const url=match[1].split(' ')[0]
      if (!/^(https?:|data:)/.test(url) && !existsSync(resolve(dirname(full),url))) failures.push(`${path}: missing image ${url}`)
    }
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode=1
} else console.log(`Public content checks passed (${checked} files). Review screenshot pixels before publishing.`)
