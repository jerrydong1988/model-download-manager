#!/usr/bin/env node
/**
 * 设计令牌对比度校验（WCAG 2.2 AA）。
 *
 * 校验 DESIGN-TOKENS 中 light/dark 两套 token 的关键前景/背景配对：
 * - 正文/次要文字 >= 4.5:1
 * - 非文本（焦点环、滚动条、进度条、输入框边界）>= 3:1
 *
 * 用法：node scripts/check-contrast.mjs
 * 退出码：0 = 全部通过；1 = 存在失败配对。
 */

import { readFileSync } from 'node:fs'

// Read the shipping palette so a theme change cannot silently keep testing old colors.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const TOKEN_NAMES = {
  bg: 'bg', surface: 'surface', surface2: 'surface-2', surface3: 'surface-3',
  fg: 'fg', fgSecondary: 'fg-secondary', fgMuted: 'fg-muted', fgDisabled: 'fg-disabled',
  primary: 'primary', primaryHover: 'primary-hover', onPrimary: 'on-primary',
  danger: 'danger', success: 'success', warning: 'warning', ring: 'ring',
  borderStrong: 'border-strong', scrollbar: 'fg-muted',
}

function readPalette(selector) {
  const block = css.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))?.[1]
  if (!block) throw new Error(`Missing theme selector: ${selector}`)
  return Object.fromEntries(Object.entries(TOKEN_NAMES).map(([name, variable]) => {
    const raw = block.match(new RegExp(`--color-${variable}:\\s*(\\d+\\s+\\d+\\s+\\d+)\\s*;`))?.[1]
    if (!raw) throw new Error(`Missing RGB token --color-${variable} in ${selector}`)
    const rgb = raw.trim().split(/\s+/).map(Number)
    if (rgb.length !== 3 || rgb.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) throw new Error(`Invalid RGB token: ${variable}`)
    return [name, `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`]
  }))
}

const TOKENS = {
  light: readPalette(':root'),
  dark: readPalette("\\[data-theme='dark'\\]"),
}

const MIN_TEXT = 4.5
const MIN_NON_TEXT = 3.0

/** [名称, 前景, 背景, 阈值] */
const TEXT_PAIRS = [
  ['fg / surface', 'fg', 'surface', MIN_TEXT],
  ['fg / bg', 'fg', 'bg', MIN_TEXT],
  ['fg / surface2', 'fg', 'surface2', MIN_TEXT],
  ['fgSecondary / surface', 'fgSecondary', 'surface', MIN_TEXT],
  ['fgSecondary / bg', 'fgSecondary', 'bg', MIN_TEXT],
  ['fgSecondary / surface2', 'fgSecondary', 'surface2', MIN_TEXT],
  ['fgMuted / surface', 'fgMuted', 'surface', MIN_TEXT],
  ['fgMuted / bg', 'fgMuted', 'bg', MIN_TEXT],
  ['onPrimary / primary', 'onPrimary', 'primary', MIN_TEXT],
  ['white / danger', 'onPrimary', 'danger', MIN_TEXT],
  ['success / surface', 'success', 'surface', MIN_TEXT],
  ['warning / surface', 'warning', 'surface', MIN_TEXT],
  ['primary / surface', 'primary', 'surface', MIN_TEXT],
]

const NON_TEXT_PAIRS = [
  ['ring / surface', 'ring', 'surface', MIN_NON_TEXT],
  ['ring / bg', 'ring', 'bg', MIN_NON_TEXT],
  ['ring / surface2', 'ring', 'surface2', MIN_NON_TEXT],
  ['primary / surface2（进度条轨道）', 'primary', 'surface2', MIN_NON_TEXT],
  ['borderStrong / surface（输入框边界）', 'borderStrong', 'surface', MIN_NON_TEXT],
  ['scrollbar / surface（滚动条）', 'scrollbar', 'surface', MIN_NON_TEXT],
]

function luminance(hex) {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

let failures = 0
for (const themeName of ['light', 'dark']) {
  const theme = TOKENS[themeName]
  console.log(`\n[${themeName}]`)
  const rows = [
    ...TEXT_PAIRS.map(([name, fg, bg, min]) => ({ name, fg, bg, min, scope: 'text' })),
    ...NON_TEXT_PAIRS.map(([name, fg, bg, min]) => ({ name, fg, bg, min, scope: 'non-text' })),
  ]
  for (const { name, fg, bg, min, scope } of rows) {
    const ratio = contrast(theme[fg], theme[bg])
    const pass = ratio >= min
    if (!pass) failures += 1
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${ratio.toFixed(2).padStart(6)}:1  (>= ${min}, ${scope})`,
    )
  }
}

console.log(
  failures === 0
    ? '\n✅ 所有 token 对比度配对通过 WCAG AA 校验'
    : `\n❌ ${failures} 个配对未达阈值`,
)
process.exit(failures === 0 ? 0 : 1)
