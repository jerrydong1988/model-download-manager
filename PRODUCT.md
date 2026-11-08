# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

需要从 HuggingFace 和 ModelScope 挑选并下载模型文件的中文用户。用户已确认本次优先工作流为：浏览仓库 → 选择文件 → 批量下载。

## Product Purpose

模型下载管理器（Model Download Manager）是 Windows 桌面应用，集中处理仓库浏览、可靠下载和本地文件管理。成功意味着用户能清楚选择正确来源、revision、文件和保存目录，并理解下载状态及异常处理方式。

## Operating Context

Tauri 2 包装的 React/TypeScript 界面；Windows 优先。默认窗口 1320×860，最小窗口 1040×680。后台下载、托盘、系统通知和键盘操作是现有产品能力。浏览器 Mock 用于可重复的 UI 预览，不代表真实任务或模型库。

## Capabilities and Constraints

- 保留浏览仓库、下载队列、本地模型库、设置四个功能入口。
- 保留来源/revision 选择、搜索分页、文件筛选与多选、保存目录、任务控制、限速/并发、多根模型库和设置能力。
- 保留浅色、深色、跟随系统和既有快捷键、焦点管理、错误/空态/加载态。
- 不改变 Rust 下载引擎、IPC 契约和已修复的任务一致性逻辑。
- 使用现有 React 18、Tailwind、离线字体资源，以及由项目原创图形和 Lucide 通用图形组成的共享 SVG 图标系统。
- 按本次会话已确认的开发约束，不在本地进行生产编译或打包；必要的生产构建检查由远端 CI 完成。

## Brand Commitments

产品名称保持“模型下载管理器 / Model Download Manager”，中文操作文案。v0.4.2 确认的视觉是浅灰窗口、白色工作面和深薄荷绿强调，焦点环为靛蓝；布局仍是原来的四页目录。轻半透明只用于导航与浮层。已否决整页矿物绿、雾白图录的蓝紫主色，以及换成另一种产品的页面结构。

## Evidence on Hand

README.md、docs/IPC-CONTRACT.md、现有源代码和 DESIGN.md。docs/screenshots 采集于 v0.4.2 配色更新之前，只说明布局。Mock 数据为演示数据，不得当成用户模型库或真实下载结果。

## Product Principles

- 搜索、选择和批量下载是当前优先路径。
- 关键状态和下一步动作应直接可见。
- 仓库、revision、路径和文件信息必须准确且可区分。
- 视觉更新保持已有工作流程和键盘可操作性。

## Accessibility & Inclusion

保持清晰焦点、键盘导航、读屏状态提示和减少动态效果支持；文字与交互状态满足可读对比度。长模型名和路径必须可辨认，不能依靠颜色单独传达状态。
