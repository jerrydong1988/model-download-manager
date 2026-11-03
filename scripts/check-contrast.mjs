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

const TOKENS = {
  light: {
    bg: '#f8fafc',
    surface: '#ffffff',
    surface2: '#f1f5f9',
    surface3: '#e2e8f0',
    fg: '#0f172a',
    fgSecondary: '#475569',
    fgMuted: '#64748b',
    fgDisabled: '#94a3b8',
    primary: '#2563eb',
    primaryHover: '#1d4ed8',
    onPrimary: '#ffffff',
    danger: '#dc2626',
    success: '#047857',
    warning: '#b45309',
    ring: '#2563eb',
    borderStrong: '#64748b',
    scrollbar: '#64748b',
  },
  dark: {
    bg: '#0b1220',
    surface: '#0f172a',
    surface2: '#1e293b',
    surface3: '#334155',
    fg: '#e2e8f0',
    fgSecondary: '#cbd5e1',
    fgMuted: '#94a3b8',
    fgDisabled: '#64748b',
    primary: '#3b82f6',
    primaryHover: '#60a5fa',
    onPrimary: '#0f172a',
    danger: '#f87171',
    success: '#34d399',
    warning: '#fbbf24',
    ring: '#60a5fa',
    borderStrong: '#94a3b8',
    scrollbar: '#94a3b8',
  },
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
