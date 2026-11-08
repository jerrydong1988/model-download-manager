---
name: Model Download Manager
description: 浅灰目录、白色工作面与深薄荷绿强调的桌面模型目录。
colors:
  bg: "rgb(249 250 251)"
  surface: "rgb(255 255 255)"
  surface-2: "rgb(247 247 247)"
  surface-3: "rgb(238 238 238)"
  border: "rgb(222 229 238)"
  border-strong: "rgb(100 116 139)"
  fg: "rgb(34 30 31)"
  fg-secondary: "rgb(48 48 48)"
  fg-muted: "rgb(111 111 111)"
  fg-disabled: "rgb(158 158 168)"
  primary: "rgb(8 106 74)"
  primary-hover: "rgb(6 90 62)"
  primary-soft: "rgb(236 253 245)"
  on-primary: "rgb(255 255 255)"
  danger: "rgb(176 26 46)"
  danger-strong: "rgb(153 20 38)"
  success: "rgb(8 106 74)"
  warning: "rgb(138 90 0)"
  ring: "rgb(64 93 230)"
  dark-bg: "rgb(14 17 19)"
  dark-surface: "rgb(22 26 29)"
  dark-surface-2: "rgb(29 34 38)"
  dark-surface-3: "rgb(42 48 54)"
  dark-border: "rgb(42 48 54)"
  dark-border-strong: "rgb(168 176 184)"
  dark-fg: "rgb(238 241 243)"
  dark-fg-secondary: "rgb(199 205 211)"
  dark-fg-muted: "rgb(174 182 190)"
  dark-fg-disabled: "rgb(120 128 136)"
  dark-primary: "rgb(74 222 128)"
  dark-primary-hover: "rgb(52 211 153)"
  dark-primary-soft: "rgb(22 58 48)"
  dark-on-primary: "rgb(5 38 27)"
  dark-danger: "rgb(255 138 152)"
  dark-success: "rgb(74 222 128)"
  dark-warning: "rgb(248 201 106)"
  dark-ring: "rgb(123 147 255)"
typography:
  meta:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC Variable\", \"PingFang SC\", system-ui, sans-serif"
    fontSize: "12px"
    lineHeight: "16px"
  secondary:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC Variable\", \"PingFang SC\", system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: "20px"
  body:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC Variable\", \"PingFang SC\", system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: "21px"
  section:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC Variable\", \"PingFang SC\", system-ui, sans-serif"
    fontSize: "18px"
    lineHeight: "26px"
    fontWeight: "600"
  page:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC Variable\", \"PingFang SC\", system-ui, sans-serif"
    fontSize: "26px"
    lineHeight: "34px"
    letterSpacing: "-0.025em"
    fontWeight: "600"
  metric:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC Variable\", \"PingFang SC\", system-ui, sans-serif"
    fontSize: "24px"
    lineHeight: "30px"
    fontWeight: "600"
  mono-meta:
    fontFamily: "\"Cascadia Code\", \"Consolas\", \"SF Mono\", monospace"
    fontSize: "12px"
    lineHeight: "16px"
rounded:
  control: "8px"
  card: "14px"
  overlay: "14px"
  md: "6px"
  full: "9999px"
spacing:
  "0.5": "2px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
components:
  button-primary:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
  button-primary-hover:
    backgroundColor: "rgb(8 106 74 / 0.10)"
    textColor: "{colors.primary}"
  button-secondary:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
  button-ghost:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
    backgroundColor: "transparent"
    textColor: "{colors.fg-secondary}"
  button-danger:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
    backgroundColor: "{colors.danger}"
    textColor: "white"
  button-danger-ghost:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
  button-subtle:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg-secondary}"
  input:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
  nav-item:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
    textColor: "{colors.fg-secondary}"
  nav-item-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
  chip-neutral:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg-secondary}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
  toast:
    backgroundColor: "rgb(255 255 255 / 0.92)"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "16px"
    width: "320px"
---

# Design System: Model Download Manager

## Overview

**Creative North Star: "浅灰目录"**

浅灰窗口、白色工作面和少量深薄荷绿，组成清楚的桌面模型目录。布局仍是侧栏四页加工作区：浏览仓库、下载队列、本地模型库、设置。精致感来自对齐、细分隔线和把绿色只用在当前项、主操作与进度上。

v0.4.2 用这套配色替换雾白图录的蓝紫强调。用户保留原来的信息目录和操作，不接受整页矿物绿，也不接受把壳子改成另一种产品的布局。导航和短暂浮层继续用轻半透明；内容面保持实色。Windows 原生字体不变，不仿窗口装饰，也不引入专有字体。

**Key Characteristics:**

- 浅灰窗口与白色工作面，深薄荷绿只标出当前项、主操作和进度。
- 四页目录、字阶、圆角和轻玻璃导航保持不变。
- 焦点环使用靛蓝，不跟强调色走。
- 浅色与深色共用角色名；深色把薄荷绿提亮，以保证文字对比。

令牌提取自 v0.4.2 的 [styles.css](src/styles.css)、[tailwind.config.js](tailwind.config.js) 和共享组件。前置 YAML 记录规范值，运行时仍由源码驱动。机器扩展见 [design.json](.impeccable/design.json)。仓库截图采集于这次配色更新之前，只说明布局，不作为当前配色样张。

## Colors

前置令牌保持源码 RGB 通道格式。dark- 前缀是同名语义角色的深色覆盖，不可与浅色角色混用。

### Primary

浅色 primary 是深薄荷绿文字与图标色，primary-hover 用于需要再压深的悬停。primary-soft 是大面积浅底：主按钮、品牌块、当前来源页签、有选择时的操作栏、热门词悬停。on-primary 只保留给仍使用实心危险按钮的白字，不作为主按钮文字。成功色与 primary 相同。

深色 primary 提亮为亮绿，文字若落在该绿色上则使用 dark-on-primary。深色浅底使用 dark-primary-soft。

### Secondary

ring 是唯一的第二强调色，只用于焦点环。浅色为靛蓝，深色为提亮的靛蓝。它不参与按钮填充、导航选中或进度。

### Neutral

bg 是浅灰窗口底，surface 是白色工作面；surface-2 与 surface-3 承接内衬、悬停、按下和禁用背景。fg、fg-secondary、fg-muted 按信息重要性递减，fg-disabled 用于禁用文字。border 是偏冷的细分隔线，border-strong 用于输入框和需要更强边界的控件。深色用近黑的蓝灰层级替换白底，文字改为浅灰。

### Semantic status

danger 与 danger-strong 表示错误和破坏性操作。warning 表示警告。success 与 primary 同值，表示完成和可用。来源与类别徽章仍由 [labels.ts](src/lib/labels.ts) 和 [Badge.tsx](src/components/ui/Badge.tsx) 集中维护，并必须伴随文字：HuggingFace 琥珀、ModelScope 天蓝，权重靛蓝、投影器紫、权重矩阵琥珀、配置翠绿、其他灰蓝。这些徽章不扩展为页面背景。

**The Ink Not Fill Rule.** 薄荷绿用于文字、图标、细边和浅底。浅色主按钮是 primary-soft 底加 primary 字，不是实心 primary 配白字。纯色 `#10b981` 配白字对比不足，不作为填充。

**The Focus Is Indigo Rule.** 键盘焦点使用 ring，浅色 `rgb(64 93 230)`，深色 `rgb(123 147 255)`。不要把焦点环改成薄荷绿。

## Typography

界面使用前置 sans 字族：Segoe UI Variable Text / Segoe UI → Microsoft YaHei UI / Microsoft YaHei → 打包的 Noto Sans SC Variable → PingFang SC → 系统无衬线。标题与正文共享字体栈，没有单独的展示字体。等宽字族为 Cascadia Code → Consolas → SF Mono → monospace，用于路径、revision 和文件名；统计列使用等宽数字。

| 角色 | 用途 |
| --- | --- |
| page | 页面与仓库主标题 |
| section | 分组标题、模型名称、详情页紧凑全局标题 |
| metric | 队列与模型库汇总数字 |
| body | 常规操作、导航、表单输入 |
| secondary | 次级说明与列表数据 |
| meta | 组织、标签、状态、帮助、表头 |
| mono-meta | 紧凑路径与文件元数据 |

字号、行高和字重见前置令牌。这是桌面信息字阶，不使用营销展示比例。

**The Readable Hierarchy Rule.** 名称先于元数据；最小文字使用 meta 字阶，数字对齐，路径和文件名使用等宽字体。

## Layout

- 全高应用壳并列导航与主工作面。窄窗导航宽（68px），md 起（208px）。工作区上、右、下外间距（8px），圆角为 card。内容独立滚动，状态栏高（36px）。
- 标题区最小高（88px），右侧是主题切换和快捷键帮助。文件详情把标题收至（52px），隐藏重复说明。
- 内容壳最大宽（1280px）。水平内距（16px），md 起（32px）。标准页垂直内距（20px），md 起（24px）。
- sm（640px）显示补充操作文字。md（768px）展开导航文字。lg（1024px）展开目录元数据列与四列汇总。xl（1280px）扩展设置双栏和补充元数据。
- 仓库行采用自适应名称列，lg 下补充列为（112px / 100px / 92px）。文件表虚拟行高（48px），最小内容宽（600px），不足时在表内横向滚动。
- 下载与设置使用持续可见操作栏。通知与可见栏顶边至少间隔（12px），底部偏移至少（48px），上界留（16px）；堆叠过高时内部滚动。
- Windows 默认窗口（1320×860）、最小（1040×680）是主要约束。

**The Same Shell Rule.** 可以更换配色和控件着色，不改四页导航、顶栏、状态栏和浏览、选择、下载的顺序。

## Elevation & Depth

工作面靠中性色层级、圆角和细边线区分。普通内容和按钮没有默认投影。当前导航项使用工作面色加轻微阴影，用来从侧栏里抬起一行。导航使用工作面色（45%）、背景模糊（24px）及饱和度（1.05）。浮层使用工作面色（92%）、模糊（20px）及饱和度（1.1）。标题面使用工作面色（94%）。确认对话框本体保持实色，遮罩使用半透明深色和（2px）模糊。

overlay 阴影用于菜单、对话框、路径提示和键盘辅助链接。toast 阴影用于短暂通知。准确值在 sidecar 的 shadows 扩展中。层叠顺序为 dropdown（20）、overlay（40）、modal（50）、toast（60）；跳过导航链接在（100）。

**The Flat Content, Light Glass Rule.** 内容保持平面。轻玻璃用于导航和浮层。阴影用于当前导航项、浮层、提示和辅助内容。

## Shapes

control 圆角用于按钮、输入和导航项。card 与 overlay 用于面板、工作区和浮层。md 用于分段项和紧凑标记。full 用于状态点、开关和进度轨道。结构边线通常为（1px）。目录行保持开放的横向边界。

图标来自统一的 70 枚 SVG 目录：12 枚项目原创图形，58 枚 Lucide 通用图形。`src/components/icons/catalog.json` 是图形与来源的目录。共用（24×24）视框、默认描边（1.75px）、圆端点与圆连接。常用显示尺寸（12 / 14 / 16 / 20px）；导航图标（18px）。品牌标记在侧栏以（28px，描边 1.8px）放在（40×40px）浅薄荷绿圆角底上，标记本身使用 primary。应用图标与托盘图标的底色为浅色 primary。

## Components

### Buttons

默认 secondary / md，字重（500）。高度 xs（28px）、sm（32px）、md（36px）、lg（40px）、xl（48px），图标按钮（36×36px）。

Primary 是浅薄荷绿底、深薄荷绿字，以及约 25% primary 的细边。悬停把边线加到约 40%，底改为约 10% primary。不要改回实心紫或实心亮绿配白字。Secondary 使用工作面、细边线和正文色。Ghost 透明，文字为次级色。Subtle 使用 surface-2。Danger 在浅色使用错误色和白字；深色实心 danger 的文字改用背景色。dangerGhost 使用错误文字和透明底。

反馈只改变颜色，常规过渡（120ms）。禁用透明度（50%）。全局焦点为靛蓝（2px）描边和（2px）间距。

每个页面标题右侧有一个 ghost 图标按钮，在当前实际外观的浅色与深色之间一键切换并立即保存。深色时显示太阳，浅色时显示月亮。设置里仍保留浅色、深色和跟随系统。从跟随系统点这个按钮，会改成与当时外观相反的固定主题。

### Chips and segmented controls

来源页签的选中项使用 primary-soft 底和正文色，不是实心色条。过滤分段的选中项使用工作面、正文色和轻阴影，轨道为 surface-2。未选中项为次级文字。热门词和最近项悬停时使用 primary-soft 与 primary 字。量化档和分片组选中时使用 secondary 按钮，而不是另一套芯片色。

徽章使用 meta、细边线和紧凑内距。任务状态同时使用（12px）语义图标和可见中文文字。保留方向键、Home、End 与 aria-pressed。

### Cards / Containers

panel 为工作面、细边线和 card 圆角，无默认投影。设置使用横向分组线，汇总使用开放统计条。文件已选择时，底部选择栏改为 primary-soft；未选择时为 surface-2。栏的颜色过渡为（180ms）。

### Inputs / Fields

输入框使用 border-strong、实色面和正文。焦点边线转为 primary，并保留靛蓝焦点环。禁用使用 surface-2 和禁用文字。标签、描述和错误提示保留；占位文字不替代标签。浏览页搜索框为（48px）高的场景变体。

### Navigation

轻玻璃底承载导航。当前项是白色工作面、加粗正文和轻阴影，只有图标使用 primary。未选项为次级文字，悬停略提亮。窄窗收起可见文字，但保留可访问名称和 aria-current。四项仍是浏览仓库、下载队列、本地模型库、设置。下载进行中的数量使用 primary-soft 底和 primary 字。

### Icons and native assets

界面图标使用 `currentColor`，随所在文字或 primary 着色。通过图片使用外部 SVG 时，深色表面使用固定浅色版本。应用图标和托盘图标导出为浅色 primary 底、白色图形。图标按钮的名称放在按钮上。

### Feedback and overlays

通知最多（3）条，每条（4.6s）自动消失，宽（320px）。错误使用 alert，其他使用 status。对话框保留 Escape、焦点陷阱和初始取消焦点。进度轨道高（8px），确定进度使用 primary。减少动态效果时，动画和过渡收至（0.01ms）。

## Do's and Don'ts

### Do:

- Do 使用语义令牌和共享组件，并同时核对浅色与深色。
- Do 把薄荷绿用在当前图标、浅底主按钮、进度和已选择的操作栏上。
- Do 用靛蓝焦点环、可见状态文字和图标按钮名称保持可访问性。
- Do 保持四页壳、顶栏主题按钮和设置里的三态主题一致。

### Don't:

- Don't 恢复雾白图录的蓝紫主色，或把矿物绿铺成整页背景。
- Don't 用实心 `#10b981` 配白字做主按钮，或把焦点环改成绿色。
- Don't 把当前导航画成整条实心色，或改掉四页布局和下载流程。
- Don't 使用低于 12px 的文字、装饰性显示字体或 emoji 图标。
- Don't 把 v0.4.2 之前的截图或旧规范当作当前配色依据。
