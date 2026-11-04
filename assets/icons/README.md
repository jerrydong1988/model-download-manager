# 模型下载管理器图标系统

70 枚统一线性图标，覆盖品牌、导航、模型文件、下载状态、操作及设置。24×24 视框、1.75px 描边、圆端点、圆连接；界面沿用雾白／石墨／蓝紫设计。

快速查看：[浅色总览](catalog-light.jpg) · [深色总览](catalog-dark.jpg)。离线打开 `preview.html` 可搜索并切换主题。

## 资源

| 路径 | 用途 |
| --- | --- |
| `app-icon.svg` | 1024px 应用标识母版：模型容器与向下箭头 |
| `app-mark.svg` | 可随文字颜色变化的单色标识 |
| `tray-icon.svg` | 16–32px 托盘的简化轮廓 |
| `app-icon.ico` | Windows 多尺寸图标：16 / 24 / 32 / 48 / 64 / 256px |
| `png/app-*.png` | 16 / 20 / 24 / 32 / 48 / 64 / 128 / 256 / 512 / 1024px 应用图标 |
| `png/tray-*.png` | 16 / 20 / 24 / 32px 托盘图标 |
| `ui/*.svg` | 全部 70 枚 `currentColor` 矢量图标 |
| `ui-dark/*.svg` | 全部 70 枚固定浅色描边版本，适合在深色背景以 `<img>` 使用 |
| `manifest.json` | 名称、中文用途、分组、文件和来源索引 |
| `preview.html` | 可离线打开的完整目录，支持浅深色切换与搜索 |

## 界面用法

```tsx
import { Download, BrandMark } from '../components/icons'

<BrandMark className="h-7 w-7" aria-hidden="true" />
<button aria-label="下载文件"><Download className="h-4 w-4" /></button>
```

组件默认隐藏装饰性图标；传入 `aria-label` 或 `aria-labelledby` 的独立图标使用 `role="img"`。图标按钮的名称放在按钮上，状态保留可见文字，不能只靠颜色表达。布局尺寸由现有控件控制，图标变化不改变点击区域。

React 组件或内联 SVG 可通过 `currentColor` 自动适配主题。以 `<img>` 加载独立 SVG 时，外部文字颜色不会传入 SVG；深色表面使用 `ui-dark/`。品牌应用图标固定白色图形与蓝紫底色。

## 维护与导出

源目录是 `src/components/icons/catalog.json`，组件封装位于 `createIcon.tsx`；`index.ts` 和本目录的图形由脚本生成。

```sh
npm run icons
npm run check:icons
```

导出使用项目已安装的 Tauri 图标工具，生成资源而不编译应用。旧入口 `python scripts/gen-icons.py` 转到同一导出器。原生托盘加载独立的 `src-tauri/icons/tray-icon.png`；安装包和任务栏使用原生多尺寸资源。

PNG 内嵌来源、源 SVG 的 SHA-256 和授权信息；ICO 来源记录在同名 `.json` 文件中。重新导出会保留这套来源记录。

## 来源与许可

12 枚原创图形：BrandMark、Compass（仓库目录）、DownloadQueue、Library、Boxes（权重）、Projector、Grid3x3（矩阵）、FileCog、FolderTree、GitBranch、HardDrive、Gauge。它们按项目 [MIT 许可](LICENSE-project.txt) 提供。

其余 58 枚通用图形来自 Lucide 0.453.0，保留 [ISC 许可](LICENSE-lucide.txt)。没有模仿或改绘 HuggingFace、ModelScope、Apple 的品牌标识。
