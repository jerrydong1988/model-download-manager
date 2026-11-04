---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/styles.css","src/pages","src/components"]
---

## Direction contract

Mode: Operate. Build path: code-led.

THESIS: 把模型浏览和文件下载做成清楚、安静的桌面目录。用户已确认浏览仓库 → 选文件 → 批量下载，并要求将信息图谱的绿色替换为雾白图录配色、达到类似 Apple 原生应用的精致程度。取消重复状态和层层套卡。

OWN-WORLD: 雾白 #f5f5f7、白色工作面、石墨 #202124、低饱和蓝紫 #5956a6；深色使用中性炭灰而非海军蓝。用户在选择页补充 Apple 式轻毛玻璃：导航 45% 面色 / 24px 背景虚化，浮层 92% 面色 / 20px 背景虚化。Windows 原生无衬线字形、12/13/14/18/26 字阶、14px 面板圆角、8px 控件圆角、细分隔线；标题与模型名主导，元数据退后。

STORY: 用户先确定来源并搜索，在对齐的目录行比较模型名称、组织、类型、下载量。进入文件列表后辨别 revision、筛选与多选，再在固定操作栏确认保存目录、总大小和下载动作。队列、模型库、设置沿用一致语言。

FIRST VIEWPORT: 208px 雾灰侧栏；主工作区顶部 88px 标题/说明；宽搜索框占主要视线，来源切换在其上；结果是开放横向目录行，模型名 18px，组织/标签 12px，类型与统计对齐。主动作是搜索，其次整行打开文件。窄窗口收敛列数并保留关键名称。Signature interaction: 勾选文件同时高亮整行，固定下载栏以短促的颜色过渡更新选择汇总；减少动态效果时无动画。

FORM: 信息图谱，第 5 个候选；seed:4684b6d0396dee8d。用户聊天明确指定材质转换，结构沿用信息图谱，配色替换为中性雾白/蓝紫。参照 Finder 的内容优先布局及系统设置的整齐分组，不复制 macOS 窗口装饰或私有字体。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
