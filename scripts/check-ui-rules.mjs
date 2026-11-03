#!/usr/bin/env node
/**
 * UI 规则静态检查（v0.1.3 验收辅助）。
 *
 * 检查 src/ 下不应再出现的写法：
 * 1. 任意 <12px 字号：text-[10px] / text-[11px] / text-[Npx] (N<12)
 * 2. 正文使用 text-slate-400（应为 text-fg-muted；仅 disabled/装饰允许白名单）
 * 3. 25% 透明焦点环：ring-brand-500/25
 * 4. 卡片/按钮 shadow-sm（flat 风格，阴影仅弹层/Toast）— 允许 Toast/Dialog 白名单
 * 5. 旧调色板作为主文字色：text-slate-900/800/700/600/500（应迁移语义 token）
 *    （白名单：src/components/ui/ 中的图标装饰色、labels.ts 明确保留的图标色）
 *
 * 用法：node scripts/check-ui-rules.mjs
 * 退出码：0 = 通过；1 = 存在违规。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

const RULES = [
  {
    id: 'tiny-font',
    re: /text-\[(\d+(?:\.\d+)?)px\]/g,
    test: (match) => Number(match[1]) < 12,
    message: '发现 <12px 字号（应使用 text-meta 及以上的 token）',
  },
  {
    id: 'slate-400-text',
    re: /text-slate-400/g,
    message: '正文/元信息使用了 text-slate-400（应为 text-fg-muted）',
  },
  {
    id: 'transparent-ring',
    re: /ring-brand-500\/(?!100|75|50|40|30|20|10)\d+/g,
    message: '发现低透明度焦点环（应使用实色 focus-visible:ring-ring）',
  },
  {
    id: 'legacy-text-palette',
    re: /text-slate-(900|800|700|600|500)\b/g,
    message: '使用了旧文字调色板（应迁移 text-fg / text-fg-secondary）',
  },
]

/** 允许合理保留旧色值的文件/场景（按相对路径匹配）。 */
const ALLOWLIST = [
  // ui 基座组件在迁移收尾前允许出现旧色（设计地基完成后再收紧）
  /^src[\\/]components[\\/]ui[\\/]/,
  // labels.ts 维护徽章/状态色（含 dark: 变体与图标色）
  /^src[\\/]lib[\\/]labels\.ts$/,
  // mock 数据文本
  /^src[\\/]mocks[\\/]/,
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (/\.(tsx?|css)$/.test(entry)) yield full
  }
}

const violations = []
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  const allowed = ALLOWLIST.some((re) => re.test(rel))
  if (allowed) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      for (const match of line.matchAll(rule.re)) {
        if (rule.test && !rule.test(match)) continue
        violations.push({
          file: rel,
          line: index + 1,
          rule: rule.id,
          message: rule.message,
          snippet: line.trim().slice(0, 140),
        })
      }
    }
  })
}

if (violations.length === 0) {
  console.log('✅ UI 规则静态检查通过')
  process.exit(0)
}

const byRule = new Map()
for (const v of violations) {
  const list = byRule.get(v.rule) ?? []
  list.push(v)
  byRule.set(v.rule, list)
}

console.log(`❌ 发现 ${violations.length} 处 UI 规则违规：\n`)
for (const [rule, list] of byRule) {
  console.log(`— ${rule}（${list.length} 处）`)
  for (const v of list.slice(0, 15)) {
    console.log(`  ${v.file}:${v.line}  ${v.snippet}`)
  }
  if (list.length > 15) console.log(`  … 其余 ${list.length - 15} 处省略`)
  console.log('')
}
process.exit(1)
