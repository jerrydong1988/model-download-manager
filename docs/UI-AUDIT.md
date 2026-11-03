# UI/UX 审计与优化方案（v0.1.2）

> 公开版本说明：本文件记录历史 UI 审计。含个人目录的历史截图已移除，当前图库使用演示数据重新生成；历史评分不代表对当前截图重新评分。

> 审计对象：模型下载管理器 v0.1.2（Tauri 2 + React 18 + TypeScript + Tailwind CSS）
> 审计日期：2026-11-03 ｜ 审计方法：`ui-ux-pro-max` 设计智能检索 + 代码/运行时证据 + WCAG 2.2 AA 对照
> 结论：**功能完整、视觉基础扎实，但存在 2 项无障碍阻断（低对比度小字、焦点环不可见）与一组密度/一致性问题；建议按 Phase 0–3 分阶段优化，优先 Phase 0（半天可完成）。**

---

## 0. 执行摘要

| 维度 | 评价 | 说明 |
|------|------|------|
| 信息架构 | 良好 | 侧栏（工作区/应用）+ 顶栏标题 + 底部状态栏，四页职责清晰 |
| 视觉一致性 | 中上 | 组件风格统一（Lucide + Tailwind + 品牌蓝），但字号/行高/卡片数量/控件高度存在多套标准 |
| 信息密度 | 偏低 | 桌面工具偏网页化留白：顶栏 68px、卡片 padding 16、10–11px 小字与 32px 图标按钮混用 |
| 可读性 | **不足（P0）** | `text-slate-400` 65 处（白底对比度 2.56:1，AA 要求 4.5:1）；`text-[10px]/[11px]` 43 处 |
| 键盘/焦点 | **不足（P0）** | 输入框焦点环 25% 透明（混合后 1.34:1）；无 skip link、无路由切换焦点管理 |
| 状态与反馈 | 中上 | 空态/骨架/错误重试/Toast/确认框齐全；但下载完成/失败无主动通知，页面切换状态丢失 |
| 动效 | 良好 | 150–300ms、`prefers-reduced-motion` 全局兜底；进度条动画用 width（应改 transform） |
| 主题 | 单一 | 无暗色模式（`dark:` 0 处）；同时色值全部走 Tailwind 调色板，主题化重构成本中等 |
| 数据表格 | 中上 | 浏览/本地库已窗口化、表头固定、数字 tabular；行高 44 vs 40 不一致，下载队列未窗口化 |

**问题统计**：P0 × 2、P1 × 7、P2 × 9、P3 × 6（详见第 4 节）。
**优化投入估算**：Phase 0 ≈ 0.5 人日，Phase 1 ≈ 1 人日，Phase 2 ≈ 1–1.5 人日，Phase 3（暗色+高级）≈ 1–1.5 人日。

历史证据标注图含个人目录，已从公开版本移除；第 4 节保留问题描述。

---

## 1. 审计方法与依据

### 1.1 设计智能检索（ui-ux-pro-max）

| 查询 | 结果 | 采用情况 |
|------|------|----------|
| `--design-system "file manager desktop application dashboard professional utility"`（variance 2 / motion 2 / density 8） | Product：**File Manager & Transfer**；Style：**Minimalism & Swiss Style**；色板 Primary `#2563EB` / Background `#F8FAFC` / Muted Foreground `#475569`；Light/Dark 均支持 | **采用**（已持久化 `design-system/model-download-manager/MASTER.md`） |
| `--domain product "desktop utility file manager dashboard"` | File Manager & Transfer：Flat + Minimalism；「功能性中性色 + 文件类型颜色编码」 | 采用 |
| `--domain style "minimal professional light utility data dense"` | **Data-Dense Dashboard**：KPI 卡行、数据表、12–14px 字号、行高 36px、卡片 padding 12px、gap 8px、侧栏 240px、顶栏 56px | 采用（作为密度基准，按桌面窗口微调） |
| `--domain color "professional light neutral blue utility dashboard"` | B2B 中性色 + 蓝色 CTA（Primary `#2563EB` 与现品牌蓝一致） | 采用（保留品牌蓝） |
| `--domain typography "chinese desktop utility professional interface"` | Chinese Simplified：Noto Sans SC | 部分采用：**离线桌面优先系统字体栈**（Segoe UI + 微软雅黑），可选内置 Noto Sans SC（见决策项） |
| `--domain ux`（contrast / focus / reduced-motion / empty-state / confirm-dialog / toast / table / inline-validation / modal） | 4.5:1 文字对比、可见焦点环（含模态内）、reduced-motion、空态引导、破坏性操作确认、Toast 3–5s 自动消失、图标按钮 aria-label 等 | 采用（第 8 节逐条映射） |
| `--stack html-tailwind`（focus ring / typography scale / spacing scale） | `focus-visible:ring-2`、统一字号/间距阶梯 | 采用 |
| `--stack html-tailwind "data table"` | **0 结果**（明确：数据库无匹配，非空值）；改用 data-dense 样式与通用桌面表格规范 | 已按规则声明，不做「伪匹配」 |
| `--domain icons "icon button accessible label"` | 装饰性图标 `aria-hidden`、图标控件需可访问名称 | 现状已基本满足（27 处 aria-label） |

### 1.2 代码与运行时证据

- 代码统计（`src/**`）：`text-slate-400` 65 处/18 文件；`text-[10px]` 7 处、`text-[11px]` 36 处；`text-xs` 54 处；`focus-visible:` 73 处、`focus:` 16 处；`title=` 52 处、`aria-label` 27 处；`dark:` **0**；`aria-busy` **0**；`prefers-reduced-motion` 1 处（styles.css 全局兜底）。
- WCAG 对比度实测（Python 计算，8-bit sRGB 相对亮度）：见附录 A。
- 截图证据：`docs/screenshots/02-downloads.png`、`03-library.png`、`04-settings.png` （原始现场截图已移出公开版本；当前截图为演示数据，不能用于重现旧版像素测量）。
- 组件/页面源码：`src/components/**`、`src/pages/**`、`src/App.tsx`、`src/styles.css`、`tailwind.config.js`。

### 1.3 局限说明

- 未在 NVDA/讲述人下做真实读屏走查；未验证 Windows 缩放 150%/200% 与高对比度模式；当前无暗色模式可测。建议在 Phase 0/1 验收时补这三项。

---

## 2. 现状评分（10 分制）

| 维度 | 分数 | 主要扣分点 |
|------|------|-----------|
| 视觉层次 | 8.0 | 页面标题/区块/卡片层级清晰；顶栏与内容区留白偏大 |
| 一致性 | 7.0 | 行高 44/40、统计卡 3/4/5 列、按钮高度 28/32/36/40 混用 |
| 信息密度 | 6.0 | 桌面工具偏稀疏，一屏有效信息少 |
| 排版 | 5.5 | 10–11px 小字过多，字号阶梯未 token 化 |
| 色彩与对比 | 4.0 | 65 处低对比灰字；焦点环透明度问题 |
| 交互反馈 | 7.5 | 进度/状态/Toast 完整；缺完成通知、缺批量操作键盘路径 |
| 导航 | 7.5 | 结构清晰、aria-current 正确；无 skip link、无全局快捷键 |
| 表单与设置 | 7.0 | 可见 label/错误提示/保存状态齐全；sticky 保存条遮挡、错误缺摘要 |
| 无障碍 | 5.0 | 对比度/焦点 P0；图标按钮命名良好；缺路由焦点管理/loading 语义 |
| 动效与主题 | 6.5 | 动效克制且尊重 reduced-motion；无暗色模式；进度条动画属性不佳 |

---

## 3. 值得保留的亮点（优化时不要破坏）

1. **结构清晰**：侧栏分组导航（`aria-current="page"`）+ 顶栏页标题/副标题 + 底部状态栏（事件通道/下载目录/版本），桌面工具感强。
2. **下载信息完整**：状态徽章「颜色 + 文字 + 图标」三重编码、速度/已下载/总量/ETA/完成时间齐全，不依赖颜色单独表意。
3. **列表性能**：仓库文件表与本地库目录树均为固定行高窗口化（640 文件展开 695 行仅渲染约 22 行 DOM）。
4. **可靠的反馈组件**：确认对话框有焦点陷阱 + Esc + 初始焦点；Toast 有 `aria-live` + 4.6s 自动消失，错误用 `role="alert"`。
5. **空态/骨架/错误重试**覆盖较完整，文案具体（会给出下一步动作）。
6. **可访问性基础**：27 处图标按钮均有 `aria-label`；装饰图标统一 `aria-hidden`；数字列已用 `tabular-nums`（21 处）；全局 `prefers-reduced-motion` 兜底。
7. **无硬编码色值**（组件内无 hex），无 emoji 图标，Lucide 图标体系统一，`cursor-pointer` 已覆盖。
8. **窗口化/按需渲染意识**：浏览与本地库都已实现，为后续优化打好基础。

---

## 4. 问题清单

> 编号与标注图一一对应；「证据」给出文件行号或截图标记。

### 4.1 P0 — 无障碍阻断（必须优先修复）

| # | 问题 | 证据 | 影响 | 建议 |
|---|------|------|------|------|
| P0-1 | **低对比度文字大面积存在**：`text-slate-400`（#94a3b8）用于 12px/11px/10px 元信息，白底 2.56:1、`slate-50` 底 2.45:1，远低于 WCAG AA 4.5:1 | 65 处/18 文件（Settings 8、LibraryTreeTable 7、LibraryPage 7、BrowsePage 6、Sidebar 6、RepoDetailHeader 6…）；标注图 ①⑥⑦ | 弱视/低质量屏幕/强光下不可读；AA 不达标 | 引入语义色 `text-muted = #475569`（白底 7.58:1）/ `text-subtle = #64748b`（≥4.5:1，仅用于白/`slate-50` 底）；`slate-400` 仅用于 disabled/纯装饰且必须 `aria-hidden` |
| P0-2 | **输入框焦点环对比不足**：`focus:ring-2 ring-brand-500/25`，25% 透明叠加白底后约 **1.34:1**，WCAG 2.2 焦点指示要求 ≥3:1 | `src/components/ui/Input.tsx:6`（`ring-brand-500/25`），另有 3 处同类 | 键盘用户难以定位输入焦点 | 统一 `focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2`（#2563eb 白底 5.17:1），并保留 border 变色；所有可交互元素共用同一 focus token |

### 4.2 P1 — 高优先级（体验与可访问性）

| # | 问题 | 证据 | 影响 | 建议 |
|---|------|------|------|------|
| P1-1 | **10–11px 小字体系**：`text-[10px]` 7 处 + `text-[11px]` 36 处（统计卡 hint、表头、路径、状态栏、筛选计数、徽章…），低于 12px 可读下限 | 标注图 ③④⑥；`Sidebar.tsx:83/90/92/149`、`RepoDetailHeader.tsx:136`、`SegmentedControl.tsx:63` 等 | 长时间使用眼疲劳，中文小字更明显 | 建立字号阶梯（12/13/14/16/20/24），元信息最小 12px；表头 12px、表格内容 13px、正文 14px |
| P1-2 | **密度与尺寸标准不统一**：Browse 文件表行高 44、Library 树行高 40；统计卡 3 列/4 列/5 列；按钮 28/32/36/40 四种高度；顶栏 68px（data-dense 基准 56px） | `FileTable.tsx:12`、`LibraryTreeTable.tsx:25`、`DownloadsPage.tsx:304`、`LibraryPage.tsx:258`、`TopBar.tsx:21` | 视觉节奏散、空间利用率低 | 定义控件高度 token（28/32/36/40）与场景映射；表格行高统一 40；顶栏 60、状态栏 28、侧栏 240；统计卡布局统一（建议最多 4 张/页） |
| P1-3 | **页面切换丢失状态**：`App.tsx` 只挂载当前页 `<Page />`，切到下载队列再回来，浏览页的搜索词/筛选/选中仓库、本地库的展开路径全部重置 | `src/App.tsx:59-67`（单 Page 挂载） | 桌面工具高频切换场景下体验明显下降（state-preservation） | 方案 A：四页常驻 + `hidden` 切换（KeepAlive，最稳）；方案 B：关键状态提升到 zustand + hash；建议 A，注意挂载成本（页面均有懒加载需求时可用 `React.lazy` + 首次激活） |
| P1-4 | **下载完成/失败无主动通知**：`applyProgress`/`upsertTask` 只更新列表，不弹 Toast、无标题/系统通知；用户在其他页面时不知道完成 | `src/store/appStore.ts:215-249`（无完成分支） | 大文件下载的核心反馈缺失 | 在 store 监听 task 状态迁移：completed → success toast（含"打开位置"动作）；error → error toast（可重试）；状态栏增加 aria-live 摘要（`已完成 N 个任务`），避免每 250ms 进度骚扰 |
| P1-5 | **完整信息仅存在于 `title` tooltip**（52 处）：文件路径/仓库名截断后，键盘与触屏用户无法查看全量；`title` 也不是可靠的读屏来源 | `LibraryTreeTable.tsx:218/286/299`、`RepoDetailHeader.tsx:190`、`TaskRow.tsx:155` 等；标注图 ② | 长路径/长仓库名场景信息不可达 | 抽取 `PathText` 组件：中间省略显示 + 点击复制 + `aria-describedby` 关联屏幕外完整文本；或用可聚焦的 tooltip（`focus` 也触发） |
| P1-6 | **无 skip link / 路由切换无焦点管理**：每次切页键盘需重新 Tab 穿过侧栏；读屏不会播报页面已切换 | `AppShell.tsx`（`main` 无 `id`/`tabIndex`）、`Sidebar` 无 skip 链接 | 键盘/读屏效率低（WCAG 2.4.1/4.1.3） | `<a href="#main" class="sr-only focus:not-sr-only">跳到主要内容</a>`；切换页面后 `main.focus()`（`tabIndex={-1}`）+ `aria-live` 播报新页面标题 |
| P1-7 | **设置页 sticky 保存条遮挡内容**：`sticky bottom-0` 覆盖最后一组设置（860px 窗口高度下可见） | `SettingsPage.tsx:733`；标注图 ③（settings 图） | 最后一组设置被遮，需额外滚动 | 二选一：改为页面内联保存区（推荐，桌面场景无需 sticky）；或保留 sticky 但容器 `pb-[84px]` 且验证 1040×680 最小窗口 |

### 4.3 P2 — 中优先级（一致性与健壮性）

| # | 问题 | 证据 | 建议 |
|---|------|------|------|
| P2-1 | 无暗色模式（`dark:` 0 处），`color-scheme: light` 固定；桌面长时间夜间使用不友好 | `styles.css:10`、全库 | Phase 3：CSS 变量 + `data-theme` + `prefers-color-scheme`；暗色 token 见 §5.1（已算好对比度） |
| P2-2 | 下载任务列表未窗口化：`visibleTasks.map` 全量渲染，任务数上千时掉帧 | `DownloadsPage.tsx:429-455` | 复用 FileTable 固定行高窗口化；或限制「已完成」历史渲染上限（如最多 200 条 + 加载更多） |
| P2-3 | `aria-busy` 缺失：骨架屏 `aria-hidden`，但容器没有加载语义 | 全库 0 处；`Skeleton.tsx` | 加载容器加 `aria-busy="true"` + `role="status"` 文案「正在加载…」，完成后移除 |
| P2-4 | 进度条无无障碍名称：`role="progressbar"` 有 aria-valuenow，但读屏不知道属于哪个任务 | `ProgressBar.tsx:26-35`、`TaskRow.tsx:314` | 传 `aria-labelledby`（文件名 + 状态）或 `aria-label`；任务行整体 `aria-label` 汇总 |
| P2-5 | SegmentedControl 无方向键 roving focus（Tab 需逐个经过每个 chip） | `SegmentedControl.tsx` | 按 WAI-ARIA tabs 模式：←/→ 移动焦点、Home/End、`aria-controls`；当前 `aria-pressed` 语义可接受，但键盘效率低 |
| P2-6 | 滚动条视觉对比不足：thumb `slate-300` 1.48:1（非文本 3:1 目标） | `styles.css:44` | thumb 改 `slate-400`（悬停 `slate-500`）；暗色模式单独给 `slate-600/700` |
| P2-7 | 行内操作按钮 32×32 且相邻间距 2px（删除/定位易误触） | `LibraryTreeTable.tsx:282-303`；标注图 ⑤ | 图标按钮提升到 36×36，间距 ≥4px；危险操作 hover 才变红或加二次确认（已有确认框） |
| P2-8 | 统计卡 hint 单行截断（如「大小 22.0 GB / 215 …」），关键信息被省略号吞掉 | `StatCard.tsx:56`；标注图 ①（library） | hint 允许两行或改为 `title` + 可聚焦详情；投影器/矩阵卡建议「22.0 GB · 215 MB」短格式 |
| P2-9 | 错误提示无错误摘要：设置页多个校验错误时 Toast 单条展示，键盘用户需逐字段寻找 | `SettingsPage.tsx` 保存逻辑 | Phase 2：表单校验失败时顶部 error summary（`role="alert" tabindex="-1"`）+ 字段内联错误保留 |

### 4.4 P3 — 低优先级（细节打磨）

| # | 问题 | 建议 |
|---|------|------|
| P3-1 | 图标尺寸混用 h-3/h-3.5/h-4/h-5 | token：icon-xs 12 / icon-sm 14 / icon-md 16 / icon-lg 20；同层级只允许一档 |
| P3-2 | 圆角混用 `rounded-md/lg/xl/2xl` | token：6（控件）/10（卡片）/14（弹层）；徽章 6 而非 full（当前 badge 已是 md） |
| P3-3 | 阴影混用 `shadow-sm/md/lg/2xl`；扁平风格下卡片/按钮阴影可去掉，仅弹层/Toast 保留 | flat 化：卡片用 border，交互控件去掉 `shadow-sm`，浮层用统一 `--shadow-overlay` |
| P3-4 | 字号/间距使用 arbitrary 值（`text-[10px]` 等） | 全部收敛到 token；CI 增加 arbitrary-value 检查（eslint 规则或脚本） |
| P3-5 | 顶栏副标题在窄窗口被压缩、状态栏信息优先级不明确 | 窄窗口隐藏副标题（`hidden xl:block`）；状态栏把「事件通道」收为图标 + tooltip，优先展示下载目录/版本 |
| P3-6 | 无全局键盘快捷键（Ctrl+1..4 / Ctrl+F / Space 暂停 / F5 重扫） | 统一快捷键层 + 帮助浮层；注意不要与输入框冲突 |

---

## 5. 优化方向与设计令牌 v2

**方向（基于检索验证）**：Data-Dense Utility + Minimalism & Swiss Style + Flat。
- 保留品牌蓝 `#2563EB` 为主色（与现设计一致，用户已有认知）；琥珀色作为「文件类型/提示」辅助色，不与主 CTA 争夺。
- 文件类型用「颜色 + 文本」双编码（现有做法正确，继续保留）。
- 不引入玻璃拟态/大阴影/3D/装饰插画；不使用 emoji 图标。
- 中文优先：系统字体栈优先（离线可用），Noto Sans SC 仅作可选打包。

### 5.1 色彩令牌（Light / Dark）

```css
/* styles.css —— 语义 token 骨架（Light） */
:root {
  --color-bg: 248 250 252;          /* #F8FAFC */
  --color-surface: 255 255 255;     /* #FFFFFF */
  --color-surface-2: 241 245 249;   /* #F1F5F9 */
  --color-border: 226 232 240;      /* #E2E8F0 */
  --color-border-strong: 203 213 225;/* #CBD5E1 */
  --color-fg: 15 23 42;             /* #0F172A 17.06:1 */
  --color-fg-secondary: 71 85 105;  /* #475569 7.24:1 */
  --color-fg-muted: 100 116 139;    /* #64748B 4.76:1（仅 surface/bg 底） */
  --color-fg-disabled: 148 163 184; /* #94A3B8 仅 disabled/装饰 */
  --color-primary: 37 99 235;       /* #2563EB 5.17:1（白字） */
  --color-primary-hover: 29 78 216; /* #1D4ED8 */
  --color-danger: 220 38 38;        /* #DC2626 白字 4.83:1 */
  --color-danger-strong: 185 28 28; /* #B91C1C 白字 6.47:1 */
  --color-success: 4 120 87;        /* #047857 */
  --color-warning: 180 83 9;        /* #B45309 */
  --color-ring: 37 99 235;          /* 焦点环 */
}
[data-theme='dark'] {
  --color-bg: 11 18 32;             /* #0B1220 */
  --color-surface: 15 23 42;        /* #0F172A */
  --color-surface-2: 30 41 59;      /* #1E293B */
  --color-border: 51 65 85;         /* #334155 */
  --color-border-strong: 71 85 105; /* #475569 */
  --color-fg: 226 232 240;          /* #E2E8F0 15.19:1 */
  --color-fg-secondary: 203 213 225;/* #CBD5E1 12.02:1 */
  --color-fg-muted: 148 163 184;    /* #94A3B8 6.96:1 */
  --color-primary: 59 130 246;      /* #3B82F6 on dark 5.09:1 */
  --color-ring: 96 165 250;         /* #60A5FA */
}
```

Tailwind 3.4 通过 `theme.extend.colors` 引用 CSS 变量（保证 `bg-surface`/`text-fg-muted` 等语义类可生成）：

```js
// tailwind.config.js
colors: {
  bg: 'rgb(var(--color-bg) / <alpha-value>)',
  surface: { DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)', 2: 'rgb(var(--color-surface-2) / <alpha-value>)' },
  border: { DEFAULT: 'rgb(var(--color-border) / <alpha-value>)', strong: 'rgb(var(--color-border-strong) / <alpha-value>)' },
  fg: {
    DEFAULT: 'rgb(var(--color-fg) / <alpha-value>)',
    secondary: 'rgb(var(--color-fg-secondary) / <alpha-value>)',
    muted: 'rgb(var(--color-fg-muted) / <alpha-value>)',
    disabled: 'rgb(var(--color-fg-disabled) / <alpha-value>)',
  },
  primary: { DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)', hover: 'rgb(var(--color-primary-hover) / <alpha-value>)' },
  ...
}
```

> 附录 A 已核验：浅色 `#475569` 在白底 7.58、`#64748b` 在白底 4.76/`slate-50` 4.55；深色 `#94a3b8` 在 `#0F172A` 6.96、在卡片 `#1E293B` 5.71。**注意**：`#64748B` 不可用于 `slate-100` 底（4.34 刚好不达 4.5），这类场景必须用 `#475569`。

**文件类型色（保持现有，全部达标）**：权重 indigo-700/50（7.07）、投影器 violet-700/50（6.48）、矩阵 amber-700/50（4.84）、配置 emerald-700/50（5.21）、其他 slate-600/100（6.92）。

### 5.2 字体与字号令牌

```ts
fontFamily: {
  sans: ['"Segoe UI Variable Text"','"Segoe UI"','"Microsoft YaHei UI"','"Microsoft YaHei"','"PingFang SC"','system-ui','sans-serif'],
  mono: ['"Cascadia Code"','Consolas','"SF Mono"','monospace'],
}
fontSize: {
  meta:   ['12px', { lineHeight: '16px', letterSpacing: '0.01em' }],  // 元信息最小字号
  secondary: ['13px', { lineHeight: '20px' }],                        // 次要正文/表格内容
  body:   ['14px', { lineHeight: '21px' }],                           // 正文/控件
  section:['15px', { lineHeight: '22px', fontWeight: '600' }],        // 区块标题
  page:   ['20px', { lineHeight: '28px', fontWeight: '600' }],        // 页面标题（顶栏）
  metric: ['24px', { lineHeight: '30px', fontWeight: '600' }],        // 统计卡数值
}
```

规则：中文正文 14px / 行高 1.5；元信息 12px 为下限；路径等长文本用 `mono 12px`；数字列必须 `tabular-nums`（现状 21 处已做，扩展到全部数据列）。

### 5.3 间距 / 密度令牌

| Token | 值 | 用途 |
|-------|----|------|
| `--space-1..8` | 4/8/12/16/20/24/32/40 px | 4pt 基线，替代散落 px |
| 控件高度 | xs 28 / sm 32 / md 36 / lg 40 | 行内 icon 按钮 36；表单控件 36；主按钮 40 |
| 表格行高 | 40（数据）/ 44（需复选框的仓库文件表统一 40 或 44 二选一，推荐 40） | 与 12–13px 字号匹配 |
| 卡片 padding | 16（标准）/ 12（密集） | 统计卡、设置卡 |
| 顶栏 / 状态栏 | 60 / 28 | 替代 68 / 32 |
| 侧栏宽度 | 240 | 与窗口 1040 最小宽兼容 |
| 页面内容宽度 | max 1280（设置 1120 保持） | 现状已合理 |
| 区块间距 | 16（卡间 12） | 现状 12–16 混用 |

### 5.4 圆角 / 阴影 / 层级 / 动效

```ts
borderRadius: { control: '6px', card: '10px', overlay: '14px' },
boxShadow: {
  card: 'none',                          // flat：卡片用 border
  overlay: '0 10px 30px -12px rgb(15 23 42 / 0.18)',
  toast: '0 8px 24px -12px rgb(15 23 42 / 0.22)',
},
zIndex: { base: 0, dropdown: 20, overlay: 40, modal: 50, toast: 60 },
transitionDuration: { micro: '120ms', state: '180ms', overlay: '240ms' },
```

- 动效原则：hover/颜色 120ms；展开/Toast 180ms；弹层 240ms；退出≈进入的 60–70%；只用 `transform`/`opacity`。
- **进度条改 `transform: scaleX()`**（当前 `transition-[width]` 违反 transform-performance）；`prefers-reduced-motion` 全局兜底保留。
- 焦点：统一 `focus-visible:ring-2 ring-ring ring-offset-2 ring-offset-bg`；输入框实色环（替代 25% 透明）。

---

## 6. 组件改造规范

| 组件 | 当前问题 | 改造要点 | 验收 |
|------|----------|----------|------|
| Button | 4 种高度混用；焦点环在非白底有白色 offset 光晕 | 尺寸 token 化（28/32/36/40）；icon 按钮最小 36；`aria-label` 强制（构建期检查）；loading 加 `aria-busy` | 键盘 Tab 全可见；点击目标 ≥36 |
| Input / Field | 焦点环 1.34:1；hint/可选文字 11px slate-400 | 实色 ring + border 变化；hint `text-meta text-fg-secondary`；error `role="alert"` + `aria-describedby`；可选标记 12px | 对比度脚本；读屏能读出 label/hint/error |
| SegmentedControl | 仅 Tab 可达；计数 10px slate-400 | ←/→/Home/End roving focus；计数 12px；`aria-controls` | 纯键盘可切换全部筛选 |
| StatCard | hint 截断；卡数不一致 | hint 12px + 允许两行/短格式；每页统一卡数与列布局 | 1320/1040 两档截图 |
| 表格（浏览/本地库） | 行高 44/40 不一致；表头 11px；单元格 13px 未定 | 行高 40；表头 12px/600 sticky；数据 13px；数字右对齐 tabular；行 hover + 键盘行导航 | 大仓库/大树滚动流畅；表头固定 |
| ProgressBar | 6px 矮；无名称；width 动画 | 8px；`aria-label`/`aria-labelledby`；scaleX 动画；不确定态 shimmer | 读屏播报任务+百分比 |
| TaskRow | 次要信息 11px slate-400；按钮 32 | 主 14/次 13；按钮 36；完成/失败通知（store 层）；错误详情可展开 | E2E 断言完成 toast |
| ConfirmDialog | 基本达标 | 复用 Modal 基座（焦点陷阱/Esc/scrim token）；危险按钮红色 + 明确后果文案（现状已较好） | 键盘/读屏回归 |
| Toast | 达标；缺完成通知 | success=polite、error=assertive（现状 role 正确）；完成/失败触发；`打开位置` 操作按钮 | 跨页面完成可见 |
| EmptyState / Skeleton / ErrorBanner | 达标；缺 aria-busy | 容器 `aria-busy`；错误含恢复路径（重试/设置） | 读屏可感知加载/失败 |
| Sidebar / TopBar / StatusBar | 小字低对比；信息优先级 | 分组标签 12px/500 `fg-muted`；状态栏 12px；事件状态收为图标 tooltip；顶栏 60 | 窄窗 1040 不溢出 |

---

## 7. 页面级优化方案

### 7.1 浏览仓库
- 搜索区：输入 36px、按钮 40px、最近搜索 chip 12px；搜索中骨架稳定（现状良好）。
- 仓库卡片：密度提升（padding 12–16、标签最多 2 行 + `+n` 可展开）；文件名 14/600、指标 12px（`fg-muted`）。
- 详情页：表头 sticky（现状已实现窗口化，确认 sticky 与 `aria`）；批量操作栏（全选模型文件/已选合计/开始下载）常驻可见；行高 40；选中行动态高亮。
- 键盘：表内 ↑/↓ 移动、Space 勾选、Enter 打开详情；`Esc` 返回搜索结果。

### 7.2 下载队列
- 默认分组：进行中置顶、其余按状态分组可折叠（现状有分组，建议记住折叠状态）。
- 完成/失败通知（P1-4）+ 状态栏 aria-live 摘要；失败行支持展开错误详情与「重试」。
- 任务行：主信息 14、次要 13；速度/ETA 数字列固定宽度 tabular；按钮 36。
- 大量历史：已完成分组窗口化或「显示更多」上限（P2-2）。
- 批量操作：全部暂停/继续/清除已完成——均已存在，补充 `Esc` 取消选择与操作结果 Toast。

### 7.3 本地模型库
- 统计卡：统一为 4 张（总占用 / 模型权重 / 投影器+矩阵 / 配置+其他），顶层目录与最近写入合并为筛选区副标题；若保留 5 张，统一高度与 hint 格式。
- 筛选区：搜索 + 6 chips 同一行，窄窗换行；chips 32px。
- 树表：行高 40、表头 12px；路径列中间省略 + 复制；根节点「下载目录」徽章 12px；目录聚合数值 tabular。
- 详情抽屉：打开时焦点移入、Esc 关闭并返回原行（现状部分实现，补齐焦点归还）；`<1280px` 抽屉 scrim 对比达标。
- 删除确认：保留「同时删除下载记录」；危险按钮红色；操作完成 Toast + 撤销（可选）。

### 7.4 设置
- 左栏分组锚点（下载/凭据/网络/引擎/关于）或保持 2 列但降低卡片高度（分组内间距 16→12，卡片 padding 20→16）。
- sticky 保存条：改为内联保存区（推荐）或底部预留 84px；保存状态明确（脏标记 + Toast）。
- Token 字段：type=password + 显隐（现状有）；提示文案 12px `fg-secondary`；「可选」12px。
- 校验：字段级错误 + 顶部 error summary（多错误时聚焦摘要）。
- 连接测试：按钮 loading + 结果行内展示（现状有，统一字号）。
- 危险/重置操作：二次确认（恢复默认目录已有 icon 按钮，建议文字化）。

### 7.5 外壳
- Skip link → `#main`；路由切换 `main.focus()` + 标题播报。
- 全局快捷键：`Ctrl/Cmd+1..4` 切页、`Ctrl+F` 聚焦搜索、`Space` 暂停/继续选中任务、`F5` 重扫（页面相关）、`Ctrl+,` 设置；提供快捷键帮助浮层（`?`）。
- 窗口 1040×680 最小尺寸验证；窄窗口隐藏顶栏副标题、状态栏次要信息。
- 保持 `prefers-reduced-motion` 全局兜底。

---

## 8. 无障碍专项（WCAG 2.2 AA 映射）

| 准则 | 现状 | 行动 |
|------|------|------|
| 1.4.3 文本对比 4.5:1 | ❌ 65 处 slate-400 | Phase 0 语义色替换 |
| 1.4.11 非文本对比 3:1 | ⚠️ 滚动条 1.48、部分图标 slate-400 | 滚动条/图标提深；焦点环实色 |
| 2.1.1 键盘可操作 | ⚠️ 树/对话框/分段控件可用；无全局快捷键、无 skip link | Phase 1–2 |
| 2.4.3 焦点顺序 | ✅ 视觉顺序一致 | 保持 |
| 2.4.7 焦点可见 | ⚠️ 输入框 1.34:1 | Phase 0 |
| 2.4.11 焦点不被遮挡 | ⚠️ 设置 sticky 条 | Phase 1 |
| 2.5.8 指针目标 24px | ✅ icon-sm=32；建议 36 | Phase 2 |
| 3.3.1/3.3.2 标签与错误 | ✅ 可见 label + 行内错误；缺错误摘要 | Phase 1–2 |
| 4.1.2 名称/角色/值 | ⚠️ 进度条缺名称、loading 缺语义 | Phase 1 |
| 4.1.3 状态消息 | ⚠️ Toast 有 live；完成/失败无播报 | Phase 1 |
| 2.3.3 动效 | ✅ reduced-motion 全局兜底 | 保持；进度条改 transform |

---

## 9. 分阶段实施计划

### Phase 0 — 无障碍与令牌地基（≈0.5 人日，建议立即执行）
**改动**：`tailwind.config.js` 语义色/字号/间距/圆角/阴影/动效 token；`styles.css` CSS 变量（light + dark 骨架）、skip-link 样式、焦点环全局规则；`Button/Input/Field/Badge/SegmentedControl/StatCard` 类名迁移；全库 `text-slate-400`→语义色（按背景选择 `fg-secondary/fg-muted`）、`text-[10px]/[11px]`→12px 阶梯。
**验收**：对比度脚本全绿；`npm run check:types` + `npm run build`；键盘 Tab 走查截图；1040×680 与 1320×860 截图对比。

### Phase 1 — 交互与信息可达性（≈1 人日）
**改动**：`App.tsx` 页面 KeepAlive + 路由焦点/播报 + skip link；store 完成/失败通知；`PathText`（复制 + 可访问 tooltip）；`ProgressBar` aria 名称 + scaleX；`Settings` sticky 修复 + error summary；`SegmentedControl` 方向键；`aria-busy`；下载历史渲染上限/窗口化。
**验收**：下载完成跨页面 Toast；键盘全流程（搜索→打开仓库→勾选→下载→暂停→继续）；E2E 回归 + axe 扫描。

### Phase 2 — 密度、一致性与视觉打磨（≈1–1.5 人日）
**改动**：顶栏 60/状态栏 28/侧栏 240；统计卡统一 4 张与布局；表格/树/下载行高统一 40；控件高度阶梯；卡片 padding；表头 12px；图标尺寸 token；Hover/Focus 行状态；路径列中间省略；窄窗断点验证。
**验收**：全站一致性截图对照；性能（下载 500 任务滚动、库 2000 文件展开）；无布局溢出。

### Phase 3 — 主题与高级体验（≈1–1.5 人日，可选/需确认）
**改动**：暗色模式（CSS 变量 + 设置项 + 跟随系统 + 双主题对比校验）；Windows 通知（需要 `tauri-plugin-notification` 依赖，需批准）；全局快捷键 + 帮助浮层；可选的「紧凑/舒适」密度切换。
**验收**：暗色双主题对比脚本全绿 + 两主题截图；通知开关；快捷键不与输入冲突。

> 每阶段都保持后端 IPC 不变，`cargo test` 不受影响；前端每次提交跑 `npm run check:types` + `npm run build` + 现有 E2E（download-e2e / library-tree / classification）。

---

## 10. 验收与测试方法

1. **对比度自动化**：新增 `scripts/check-contrast.mjs`，读取 token 表计算所有前景/背景配对（阈值 4.5/3.0），CI/本地可跑。
2. **axe-core 注入**：通过 WebView2 CDP 在真实应用页面执行 axe（`Runtime.evaluate` 注入本地 axe.min.js），输出 violations；0 critical/serious 才通过。
3. **键盘走查清单**（手动 + CDP 断言）：Tab 顺序、焦点可见、Esc 关闭弹层、↑↓ 表格/树、快捷键、焦点归还。
4. **视觉回归**：每阶段固定 1320×860 / 1040×680 两档截图，覆盖四页 + 空态/加载/错误/弹窗/Toast。
5. **读屏抽测**：Windows 讲述人（NVDA 更佳）走查：导航、搜索、开始下载、暂停、完成通知。
6. **缩放**：Windows 150%/200% 显示缩放与高对比度模式抽测。

---

## 11. 风险、约束与不采纳项

- **不改 IPC/功能**：本轮纯前端改造；TS 类型与命令不变。
- **Tailwind 版本**：当前 Tailwind 3.4，`@theme` 是 v4 语法；方案使用 CSS 变量 + `theme.extend`（MASTER.md 中 v4 示例仅作参考）。
- **字体**：Tauri 离线应用不应用 Google Fonts CDN；系统字体栈优先（已安装微软雅黑/Noto Sans）。如需统一跨平台观感可打包 Noto Sans SC（体积 +约 5–8MB，需确认）。
- **不采纳**：玻璃拟态/大范围动效/渐变装饰/暗色优先重做/引入 UI 组件库（保持现有组件资产）。
- **回归风险**：Phase 2 密度调整会改动大量类名，建议按「组件 → 页面」小步提交并保留截图对比；先做 Phase 0 再评估后续。

---

## 12. 需要确认的决策项

1. **暗色模式**：是否纳入 Phase 3？（推荐：纳入，桌面夜间使用价值高；工作量约 1 人日）
2. **字体打包**：是否允许随安装包附带 Noto Sans SC（+~5–8MB）？默认不打包，用系统字体。
3. **Windows 通知**：下载完成是否要系统 Toast（需新增 `tauri-plugin-notification` 依赖）？默认只做应用内 Toast。
4. **快捷键**：是否需要全局快捷键（推荐需要，Phase 2）。
5. **实施节奏**：是否先落地 Phase 0（半天，可立即开始），确认效果后再排 Phase 1–2？

---

## 附录 A：关键对比度计算（8-bit sRGB）

| 前景 | 背景 | 对比度 | 判定 |
|------|------|--------|------|
| slate-400 `#94A3B8` | white | **2.56:1** | ❌ AA |
| slate-400 `#94A3B8` | slate-50 `#F8FAFC` | **2.45:1** | ❌ AA |
| slate-400 `#94A3B8` | slate-100 `#F1F5F9` | **2.34:1** | ❌ AA |
| slate-500 `#64748B` | white | 4.76:1 | ✅（≥12px 且不用在 slate-100 上） |
| slate-500 `#64748B` | slate-100 `#F1F5F9` | **4.34:1** | ❌ 不得用于此背景 |
| slate-600 `#475569` | white / slate-50 | 7.58 / 7.24:1 | ✅ |
| brand-600 `#2563EB` | white | 5.17:1 | ✅ |
| white | brand-500 `#3B82F6` | 3.68:1 | ⚠️ 大文本/非文本可用；正文不用 |
| focus ring（brand-500/25 叠白） | white | **1.34:1** | ❌ 焦点指示 |
| brand-600（实色环） | white | 5.17:1 | ✅ |
| 滚动条 slate-300 `#CBD5E1` | white | **1.48:1** | ❌ 非文本 3:1 |
| border `#E2E8F0` | white | 1.23:1 | 装饰性边框可接受（非控件边界） |
| border-strong `#CBD5E1` | white | 1.48:1 | ⚠️ 输入框边界建议 `#94A3B8`→或加 inner shadow（3:1） |
| 白字 | red-600 `#DC2626` | 4.83:1 | ✅ |
| 暗色 muted `#94A3B8` | `#0F172A` / card `#1E293B` | 6.96 / 5.71:1 | ✅ |
| 暗色 subtle `#64748B` | `#0F172A` | 3.75:1 | ⚠️ 仅限非正文/大文本 |
| 白字 | brand-600（主按钮） | 5.17:1 | ✅ |

## 附录 B：证据索引

| 主题 | 位置 |
|------|------|
| 低对比灰字 | `src/pages/SettingsPage.tsx`、`src/components/library/LibraryTreeTable.tsx`、`src/pages/LibraryPage.tsx`、`src/pages/BrowsePage.tsx`、`src/components/layout/Sidebar.tsx`、`src/components/browse/RepoDetailHeader.tsx` |
| 输入焦点环 | `src/components/ui/Input.tsx:6`（另 3 处 `ring-brand-500/25`） |
| 小字号 | `Sidebar.tsx:83/90/92/149`、`RepoDetailHeader.tsx:136`、`SegmentedControl.tsx:63`、`AppShell.tsx:56`、`TaskRow.tsx:294` 等 |
| 行高/尺寸 | `src/components/browse/FileTable.tsx:12`（44）、`src/components/library/LibraryTreeTable.tsx:25`（40）、`TopBar.tsx:21`（68）、`Sidebar.tsx:74`（236） |
| 统计卡布局 | `BrowsePage.tsx:287/321`（3 列）、`DownloadsPage.tsx:304`（4 列）、`LibraryPage.tsx:258`（5 列） |
| 页面状态丢失 | `src/App.tsx:59-67` |
| 无完成通知 | `src/store/appStore.ts:215-249` |
| 下载列表未窗口化 | `src/pages/DownloadsPage.tsx:429-455` |
| sticky 保存条 | `src/pages/SettingsPage.tsx:733` |
| title-only 信息 | `title=` 52 处，见 §4.2 P1-5 |
| 无障碍良好实践 | `ConfirmDialog.tsx`（焦点陷阱/Esc）、`Toasts.tsx`（aria-live/自动消失）、`ProgressBar.tsx`（role）、`styles.css:58`（reduced-motion） |

## 附录 C：设计系统参考

- 已持久化：`design-system/model-download-manager/MASTER.md`（Product: File Manager & Transfer；Style: Minimalism & Swiss；Light/Dark 支持；density 8/10）。
- **差异说明（重要）**：MASTER.md 由通用模板生成，其中「Landing Page Pattern / 主按钮 amber / 卡片 hover 抬升 / 16px 输入」等属于网页营销场景，**不适用于本桌面工具**；本项目以第 5 节的令牌与第 6–7 节为准（保留品牌蓝主按钮、扁平卡片、防布局跳动）。

---

## 13. v0.1.3 实施结果（已完成）

> 本节记录审计方案在 v0.1.3 的落地与复验证据。原始现场截图已移出公开版本；当前图库仅展示演示数据。

### 13.1 问题闭环

| 审计项 | 状态 | 落地方式 |
|--------|------|----------|
| P0-1 低对比度文字 | ✅ | 语义 token：正文 `text-fg`、次要 `text-fg-secondary`（7.24:1）、弱化 `text-fg-muted`（4.55–4.76:1，限制使用背景）；`check-contrast.mjs` 全绿 |
| P0-2 焦点环不可见 | ✅ | 全局 `focus-visible` 2px 实色 ring + 2px offset（light 5.17:1 / dark 7.02:1）；输入框实色环 |
| P1-1 10–11px 小字 | ✅ | 字号 token（meta 12 / secondary 13 / body 14 / section 15 / page 20 / metric 24）；DOM 实测最小字号 12px、<12px 为 0 |
| P1-2 密度/尺寸不统一 | ✅ | 顶栏 60、状态栏 28、侧栏 240、表格/树行 40、icon 按钮 36、统计卡统一 4 张、卡片 padding 统一 |
| P1-3 页面切换丢状态 | ✅ | 四页 KeepAlive（hidden 切换），浏览搜索/详情、本地库展开、下载筛选均保留 |
| P1-4 完成/失败无通知 | ✅ | store 状态迁移驱动 toast（含打开位置/重试 action）+ Rust 侧 Windows 系统通知（桌面实拍验证） |
| P1-5 title-only 信息 | ✅ | 新增 `PathText`：中间省略 + focus 完整提示 + 复制按钮；接入状态栏/任务行/文件表/库树/详情 |
| P1-6 无 skip link/路由焦点 | ✅ | `.skip-link` → `#main`；切页后 focus main + aria-live 页面播报 |
| P1-7 设置保存条遮挡 | ✅ | 改为内联保存区（position: static），多错误顶部 error summary（role=alert + 聚焦） |
| P2-1 无暗色模式 | ✅ | CSS 变量 + `data-theme` + 跟随系统；首帧内联脚本防闪白；双主题独立校验 |
| P2-2 下载列表未窗口化 | ✅（上限渲染） | >300 条时已完成分组 80/批渲染 + 再显示（332 任务实测仅渲染 103 行） |
| P2-3 `aria-busy` 缺失 | ✅ | SkeletonRegion（role=status + aria-busy） |
| P2-4 进度条无名称 | ✅ | ProgressBar 支持 aria-label/aria-labelledby；8px 高、scaleX 动画 |
| P2-5 SegmentedControl 键盘 | ✅ | ←/→/Home/End roving focus |
| P2-6 滚动条对比 | ✅ | light #64748B(4.76:1) / dark #94A3B8(6.96:1) |
| P2-7 行内按钮目标小 | ✅ | 36×36、间距 ≥4px |
| P2-8 统计卡 hint 截断 | ✅ | hint 允许两行 + 短格式；本地库统计卡合并为 4 张 |
| P2-9 表单错误摘要 | ✅ | 顶部 error summary + 字段内联错误保留 |
| P3-1~P3-6 | ✅ 大部分 | 图标/圆角/阴影 token 化、arbitrary 值清零（`check-ui-rules.mjs` 0 违规）、快捷键与帮助浮层、顶栏副标题窄窗隐藏 |
| 暗色 + 字体 + 系统通知 + 托盘后台 | ✅ | 见 README v0.1.3 功能与 QA 报告 §14 |

### 13.2 复验数据（真实执行）

| 项 | 结果 |
|----|------|
| 自动化校验 | `check-contrast.mjs` 全绿；`check-ui-rules.mjs` **0 违规**；`cargo test` **57/57** |
| UI/暗色/无障碍 | **37/37**：四页 light+dark（1320×860 / 1040×680）、最小字号 12px、`text-slate-400` 正文 0、焦点环实色、主题重启保持、首帧 `__QA_FIRST_THEME__=dark` 不闪白、KeepAlive、快捷键、错误摘要 |
| 托盘后台/通知 | **31/31**：关窗后进程存活 / 窗口隐藏 / `.part` 持续增长 / 二次启动唤起窗口；Windows 通知桌面实拍；closeToTray=false 退出落盘 |
| 回归 | download-e2e 61/61、library-tree 44/44、classification 37/37；本地目录扫描验收通过，个人目录统计已省略 |
| 安装包 | v0.1.3 NSIS 6.47 MiB，安装→启动→卸载通过 |

### 13.3 剩余事项（不阻塞）

1. 下载列表采用「已完成分组上限渲染」而非严格虚拟滚动（数据量大时可后续升级）。
2. `closeToTray=false` 退出落盘瞬间任务状态可能为 `pausing`（数据完整，重启恢复为 paused）；后续可在退出前等待暂停完成。
3. 托盘右键菜单/系统通知的 UI Automation 在 Win11 托盘折叠下无法全自动断言，已用桌面实拍 + 日志证据补充。
4. `Ctrl+F` 仅在含搜索框页面生效（浏览/本地库/仓库详情）。
5. 本地库多扫描根目录（参考工具的「添加模型目录」）仍属 v0.2 需求。

**实施视角**：P0/P1 全部清零并可自动化复验；P2/P3 仅剩上述非阻断项。
