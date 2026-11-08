# 设计令牌兼容入口

> 当前视觉规范是 [根目录 DESIGN.md](../DESIGN.md)，机器扩展见 [design.json](../.impeccable/design.json)。v0.4.2 起，强调色为深薄荷绿，焦点环为靛蓝；雾白图录的蓝紫主色和更早的 v0.1.3 配色都不再使用。本文件只保留源码注释引用的章节入口，不维护第二套令牌。

## 1. 主题与色彩令牌

运行时值由 [styles.css](../src/styles.css) 定义，由 [tailwind.config.js](../tailwind.config.js) 映射。继续使用 bg、surface、line、fg、primary、danger、success、warning、ring 语义角色。来源、文件类型和任务状态的颜色加文字编码由 [labels.ts](../src/lib/labels.ts) 与 [Badge.tsx](../src/components/ui/Badge.tsx) 集中维护。

## 2. 字体与字号

准确字体栈与字阶见 DESIGN.md 的 Typography 和前置令牌。当前优先 Windows 原生字体，打包的 Noto Sans SC Variable 为离线回退。最小文字（12px），数字列使用等宽数字，路径与文件名使用等宽字体。

## 3. 间距 / 尺寸 / 圆角 / 阴影 / 动效

以 DESIGN.md 的 Layout、Elevation & Depth、Shapes 和组件令牌为准。全局实色焦点（2px）及间距（2px）、减少动态效果继续保留。文件表行高现为（48px）；旧侧栏、顶栏、状态栏与圆角值不再适用。

## 4. 组件契约

- 复用共享组件；图标按钮有可访问名称，加载操作保留忙碌状态。
- Field 保留标签、描述关联和错误 alert；分段控件保留方向键/Home/End 与选中语义。
- Dialog 保留 Escape、焦点限制与初始取消焦点；PathText 保留完整路径查看与复制。
- 持续操作栏保留 data-action-shelf；通知根据可见操作栏避让，最多三条、4.6 秒自动关闭，并保留关闭与状态/错误语义。

### 4.6 ProgressBar

轨道（8px），确定进度使用 scaleX、语义状态色与可访问名称；未知进度保留功能性 shimmer，减少动态效果覆盖生效。详见 [ProgressBar.tsx](../src/components/ui/ProgressBar.tsx)。

## 5. Dark mode

settings.theme 支持 light / dark / system；[theme.ts](../src/lib/theme.ts)、App.tsx 和 index.html 首帧脚本维护 html 的 data-theme，保留缓存及系统主题监听。主题即时切换。DESIGN.md 中 dark- 前缀表示同名 CSS 角色的深色覆盖。

## 6. 设置与行为约束

浅色/深色/跟随系统、关闭到托盘、系统通知继续遵循现有设置契约。视觉修改不改变 Rust 下载引擎与 IPC 命令/数据结构；参见 [IPC-CONTRACT.md](IPC-CONTRACT.md)。

## 7. 校验约定

视觉修改使用现有 npm run check:ui，并检查浅/深主题和 Windows 最小窗口。本次用户约束是不在本地生产编译或打包，生产构建由远端 CI 承担。历史 QA 仅证明当时版本；设计文档不替代当前验证记录。
