# 设计令牌与实施规范 v1（v0.1.3）

> 本文件是 Phase 0–3 UI 改造的**唯一实现口径**。前端拆分任务时，`frontend-design` 与 `frontend-pages`
> 都必须使用本文件的 token 命名；未定义的 token 不得自造，需先通知 Lead。
> 依据：`docs/UI-AUDIT.md` + `design-system/model-download-manager/MASTER.md`（已按桌面工具适配）。

## 1. 主题与色彩令牌

`document.documentElement.dataset.theme = 'light' | 'dark'`；`system` 模式下监听 `prefers-color-scheme`。
Tailwind 3.4 映射方式：CSS 变量 + `theme.extend.colors`（`rgb(var(--x) / <alpha-value>)`）。

```css
:root {
  --color-bg: 248 250 252;            /* #F8FAFC */
  --color-surface: 255 255 255;       /* #FFFFFF */
  --color-surface-2: 241 245 249;     /* #F1F5F9 */
  --color-surface-3: 226 232 240;     /* #E2E8F0 */
  --color-border: 226 232 240;        /* #E2E8F0 */
  --color-border-strong: 100 116 139; /* #64748B（输入框边界，非文本 3:1+） */
  --color-fg: 15 23 42;               /* #0F172A */
  --color-fg-secondary: 71 85 105;    /* #475569 */
  --color-fg-muted: 100 116 139;      /* #64748B：仅 surface/bg 底，禁止 slate-100 底 */
  --color-fg-disabled: 148 163 184;   /* #94A3B8（仅 disabled/装饰） */
  --color-primary: 37 99 235;         /* #2563EB */
  --color-primary-hover: 29 78 216;   /* #1D4ED8 */
  --color-primary-soft: 239 246 255;  /* #EFF6FF */
  --color-on-primary: 255 255 255;
  --color-danger: 220 38 38;          /* #DC2626 */
  --color-danger-strong: 185 28 28;   /* #B91C1C */
  --color-success: 4 120 87;          /* #047857 */
  --color-warning: 180 83 9;          /* #B45309 */
  --color-ring: 37 99 235;
}
[data-theme='dark'] {
  --color-bg: 11 18 32;               /* #0B1220 */
  --color-surface: 15 23 42;          /* #0F172A */
  --color-surface-2: 30 41 59;        /* #1E293B */
  --color-surface-3: 51 65 85;        /* #334155 */
  --color-border: 51 65 85;           /* #334155 */
  --color-border-strong: 148 163 184; /* #94A3B8（深色下 6.96:1） */
  --color-fg: 226 232 240;            /* #E2E8F0 */
  --color-fg-secondary: 203 213 225;  /* #CBD5E1 */
  --color-fg-muted: 148 163 184;      /* #94A3B8 */
  --color-fg-disabled: 100 116 139;   /* #64748B */
  --color-primary: 59 130 246;        /* #3B82F6 */
  --color-primary-hover: 96 165 250;  /* #60A5FA */
  --color-primary-soft: 30 58 138;    /* #1E3A8A 作为深色 soft 底 */
  --color-on-primary: 15 23 42;
  --color-danger: 248 113 113;        /* #F87171 */
  --color-success: 52 211 153;        /* #34D399 */
  --color-warning: 251 191 36;        /* #FBBF24 */
  --color-ring: 96 165 250;           /* #60A5FA */
}
```

Tailwind 语义色扩展（类名固定，页面禁止再直接使用 `slate-*`/`white` 作为背景与文字）：

```js
colors: {
  bg: 'rgb(var(--color-bg) / <alpha-value>)',
  surface: { DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)', 2: 'rgb(var(--color-surface-2) / <alpha-value>)', 3: 'rgb(var(--color-surface-3) / <alpha-value>)' },
  line: { DEFAULT: 'rgb(var(--color-border) / <alpha-value>)', strong: 'rgb(var(--color-border-strong) / <alpha-value>)' },   // 避免与 Tailwind borderColor 默认冲突，用 line
  fg: { DEFAULT: 'rgb(var(--color-fg) / <alpha-value>)', secondary: 'rgb(var(--color-fg-secondary) / <alpha-value>)', muted: 'rgb(var(--color-fg-muted) / <alpha-value>)', disabled: 'rgb(var(--color-fg-disabled) / <alpha-value>)' },
  primary: { DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)', hover: 'rgb(var(--color-primary-hover) / <alpha-value>)', soft: 'rgb(var(--color-primary-soft) / <alpha-value>)', on: 'rgb(var(--color-on-primary) / <alpha-value>)' },
  danger: { DEFAULT: 'rgb(var(--color-danger) / <alpha-value>)', strong: 'rgb(var(--color-danger-strong) / <alpha-value>)' },
  success: 'rgb(var(--color-success) / <alpha-value>)',
  warning: 'rgb(var(--color-warning) / <alpha-value>)',
  ring: 'rgb(var(--color-ring) / <alpha-value>)',
}
```

映射速查（旧 → 新）：
| 旧 | 新 |
|----|----|
| `bg-white` / `bg-slate-50`（页面底） | `bg-surface` / `bg-bg` |
| `bg-slate-50/100`（卡片内衬底） | `bg-surface-2` |
| `border-slate-200` / `border-slate-100` | `border-line` |
| `border-slate-300`（控件） | `border-line-strong` |
| `text-slate-900/800/700` | `text-fg` |
| `text-slate-600/500` | `text-fg-secondary` |
| `text-slate-400`（文字） | `text-fg-muted`（≥12px 且非 slate-100 底）；disabled/装饰才保留 `text-fg-disabled` |
| `text-brand-600/700` | `text-primary`（链接/hover 用 `primary-hover`） |
| `bg-brand-600 text-white` | `bg-primary text-primary-on` |
| `bg-brand-50` | `bg-primary-soft` |
| `text-red-600/700` | `text-danger` |
| `text-emerald-600/700` | `text-success` |
| `text-amber-600/700` | `text-warning` |

**文件类型徽章**（颜色 + 文本双编码，`dark:` 变体在 `labels.ts` 统一定义）：
| kind | light | dark |
|------|-------|------|
| weight | `border-indigo-200 bg-indigo-50 text-indigo-700` | `dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-300` |
| mmproj | `border-violet-200 bg-violet-50 text-violet-700` | `dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-300` |
| imatrix | `border-amber-200 bg-amber-50 text-amber-700` | `dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300` |
| config | `border-emerald-200 bg-emerald-50 text-emerald-700` | `dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300` |
| other | `border-slate-200 bg-slate-100 text-slate-600` | `dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300` |

来源徽章、任务状态徽章、Toast、警告条同理增加 `dark:` 变体（对应 -300 文字 / -950/40 底 / -800/60 边）。

## 2. 字体与字号

- 字体：`font-sans` = `'Noto Sans SC Variable', 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif`
  - 通过 `@fontsource-variable/noto-sans-sc` 打包（依赖已批准，约 4.9MB 源文件，构建后按实际 woff2 计入）。
  - 在 `main.tsx` 或 `styles.css` 引入；字体加载策略 `font-display: swap`（fontsource 默认），首屏不得 FOIT。
  - 中文正文用 Noto Sans SC 渲染，西文与数字优先 Segoe UI（字体栈顺序保证）。
- 字号 token：

```js
fontSize: {
  meta: ['12px', { lineHeight: '16px' }],
  secondary: ['13px', { lineHeight: '20px' }],
  body: ['14px', { lineHeight: '21px' }],
  section: ['15px', { lineHeight: '22px', fontWeight: '600' }],
  page: ['20px', { lineHeight: '28px', letterSpacing: '-0.01em', fontWeight: '600' }],
  metric: ['24px', { lineHeight: '30px', fontWeight: '600' }],
}
```

规则：**任何地方不得出现 <12px 的文字**（`text-[10px]`/`text-[11px]` 必须清除）；数字列 `tabular-nums`。

## 3. 间距 / 尺寸 / 圆角 / 阴影 / 动效

```js
height: { xs: '28px', sm: '32px', md: '36px', lg: '40px', control: '36px' },
spacing: { 0.5:'2px', 1:'4px', 2:'8px', 3:'12px', 4:'16px', 5:'20px', 6:'24px', 8:'32px', 10:'40px' },
borderRadius: { control: '6px', card: '10px', overlay: '14px' },
boxShadow: { overlay: '0 10px 30px -12px rgb(2 6 23 / 0.35)', toast: '0 8px 24px -12px rgb(2 6 23 / 0.30)' },
```

- 卡片一律 `bg-surface border-line rounded-card`；**禁止卡片/按钮 `shadow-sm`**（flat），阴影仅用于 modal/toast/popover。
- 顶栏 60px、状态栏 28px、侧栏 240px；表格行高 40px（浏览文件表与本地库树统一 40）；下载任务行紧凑（padding y 10–12）。
- 控件高度：icon 按钮 36（`size-9`），普通按钮 32/36/40；输入框 36。
- 图标尺寸：12/14/16/20 四档，同层一致；Lucide 保持 stroke 2。
- 动效：`duration-micro=120ms`（hover/颜色）、`duration-state=180ms`（展开/Toast）、`duration-overlay=240ms`（弹层）；退出≈进入 60–70%；只动 `transform`/`opacity`。
- 进度条：8px 高；使用 `transform: scaleX()` 动画（禁止 width 动画）。
- 焦点：全局 `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg`；输入框额外 `focus-visible:border-primary`。禁止 25% 透明焦点环。
- 滚动条：thumb light `#64748B`（4.76:1）、dark `#94A3B8`（6.96:1）；宽度 10px。
- 进度条轨道：`surface-2`（light #F1F5F9 / dark #1E293B），填充 `primary`（两组均 ≥3:1；暗色 3.98:1）。
- `prefers-reduced-motion` 全局兜底保留；不做 reveal/视差装饰动画。

## 4. 组件必须满足的验收点

1. **Button**：尺寸 token；icon 按钮最小 36×36；必须 `aria-label`（icon-only）；loading 时 `aria-busy`；hover/active 用颜色变化（不位移）。
2. **Input/Field**：36px 高；实色 focus ring；label 显式关联；hint 12px；error 12px + `role="alert"` + `aria-describedby`。
3. **SegmentedControl**：←/→/Home/End roving focus；count 12px；`aria-pressed` 保留。
4. **StatCard**：label 12px、value 24px、hint 12px `fg-muted`；允许 hint 两行或短格式；同页卡数/高度一致。
5. **表格/树**：表头 12px 600 `fg-secondary` sticky；行 40px；单元格 13px；数字右对齐 tabular；键盘行导航（↑↓/Home/End/Enter/空格）；hover 行 `bg-surface-2`。
6. **ProgressBar**：8px；`aria-label` 或 `aria-labelledby` 提供任务名+状态；不确定态 shimmer；完成态视觉独立（success 色 + 完成图标在行侧）。
7. **Toast**：success `role="status"`、error `role="alert"`；4–5s 自动消失；最多 3 条堆叠；完成通知带「打开位置」动作。
8. **Dialog**：复用现有焦点陷阱/Esc；scrim `bg-slate-950/50 backdrop-blur-[2px]`（暗色也适用）；危险按钮 `danger`。
9. **EmptyState/Skeleton/ErrorBanner**：加载容器 `aria-busy="true"` + `role="status"`；错误含恢复路径。
10. **PathText**（新增 `src/components/ui/PathText.tsx`）：中间省略（保留头尾）+ focus 时显示完整 tooltip（`aria-describedby`）+ 复制按钮（成功 Toast）。

## 5. Dark mode 落地方式

- `src/lib/theme.ts`：`resolveTheme(setting)`、`applyTheme(theme)`、`subscribeSystemTheme(cb)`；在 `App.tsx`（或 `main.tsx`）随 `settings.theme` 更新。
- `index.html` 的 `<html>` 初始 `data-theme` 由内联脚本按 localStorage 缓存设置，避免闪白（Tauri 环境 localStorage 可用；首帧默认 `light`）。
- 所有页面/组件不得再使用固定浅色类（`bg-white`、`text-slate-900` 等），统一语义 token + `dark:`；QA 双主题截图对照。
- 设置页新增「外观」分组：主题三选一（浅色/深色/跟随系统）；更改立即生效并保存。

## 6. 新增设置项 UI（配合后端 Settings v0.1.3）

| 设置 | 控件 | 文案 |
|---|---|---|
| `theme` | 三选一分段控件 | 浅色 / 深色 / 跟随系统 |
| `closeToTray` | Switch | 「关闭窗口时最小化到托盘」；说明：后台继续下载，托盘菜单可退出 |
| `notificationsEnabled` | Switch | 「下载完成/失败时发送系统通知」 |

## 7. 禁止事项

- ❌ 新增 UI 依赖库（除已批准的 fontsource 字体包）；
- ❌ 修改 IPC 命令名/参数/返回结构（设置字段新增除外，按契约）；
- ❌ 保留 <12px 文字、`text-slate-400` 正文、25% 透明焦点环；
- ❌ 玻璃拟态/大阴影/装饰性动画/emoji 图标；
- ❌ 改动后端下载引擎语义（除非 p 任务明确要求）。

---

## 8. 落地状态（v0.1.3 已完成）

本规范已在 v0.1.3 全量落地并通过自动校验：
- `node scripts/check-contrast.mjs`：light/dark 全部 token 配对通过 WCAG AA；
- `node scripts/check-ui-rules.mjs`：**0 违规**（无 <12px 字号 / `text-slate-400` 正文 / 透明焦点环 / 旧调色板）；
- QA 真机复验：四页 light+dark × 1320/1040、最小字号 12px、焦点环实色、主题重启保持、首帧不闪白、KeepAlive、快捷键（见 `docs/QA-REPORT.md` §14）；
- 组件双主题画廊：`src/assets/ui-preview.html?theme=dark`（dev-only，不参与生产构建）；
- 字体产物：Noto Sans SC Variable，98 个 unicode-range woff2 共 4.28 MB。

后续新增/修改 UI 时，必须先跑上述两个校验脚本，并在 light/dark 两套主题下截图验证。
