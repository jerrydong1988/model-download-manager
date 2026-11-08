---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/styles.css","src/pages","src/components"]
---

## Direction contract

Mode: Operate. Build path: code-led.

THESIS: 把模型浏览和文件下载做成清楚、安静的桌面目录。用户已确认浏览仓库 → 选文件 → 批量下载。v0.4.2 保留这个目录结构，把强调色换成深薄荷绿。取消重复状态和层层套卡。

OWN-WORLD: 浅灰窗口 rgb(249 250 251)、白色工作面、墨色文字 rgb(34 30 31)、深薄荷绿 rgb(8 106 74) 用于文字和图标，浅薄荷绿 rgb(236 253 245) 用于大面积浅底；焦点环为靛蓝 rgb(64 93 230)。深色把绿色提亮为 rgb(74 222 128)。导航 45% 面色 / 24px 背景虚化，浮层 92% 面色 / 20px 背景虚化。Windows 原生无衬线字形、12/13/14/18/26 字阶、14px 面板圆角、8px 控件圆角、细分隔线；标题与模型名主导，元数据退后。

STORY: 用户先确定来源并搜索，在对齐的目录行比较模型名称、组织、类型、下载量。进入文件列表后辨别 revision、筛选与多选，再在固定操作栏确认保存目录、总大小和下载动作。队列、模型库、设置沿用一致语言。

FIRST VIEWPORT: 208px 浅灰侧栏，当前项为白底，只有图标是深薄荷绿；主工作区顶部 88px 标题/说明，右侧可一键切换明暗；宽搜索框占主要视线，来源切换在其上；结果是开放横向目录行，模型名 18px，组织/标签 12px，类型与统计对齐。主动作是搜索，其次整行打开文件。窄窗口收敛列数并保留关键名称。Signature interaction: 勾选文件同时高亮整行，固定下载栏以浅薄荷绿过渡更新选择汇总；减少动态效果时无动画。

FORM: 信息图谱结构保留。v0.4.2 把强调色从蓝紫换成深薄荷绿，不改页面结构，不复制其他产品的布局或私有字体。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
