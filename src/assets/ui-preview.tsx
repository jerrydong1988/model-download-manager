/**
 * 组件画廊（仅开发期视觉验收，不参与生产构建）：
 * 访问 http://localhost:1420/src/assets/ui-preview.html?theme=light|dark
 * 用于 DESIGN-TOKENS 双主题截图与组件回归。
 */
import '@fontsource-variable/noto-sans-sc'
import { useEffect, useState, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import {
  AlertCircle,
  Check,
  Download,
  FileCog,
  FolderOpen,
  Gauge,
  HardDrive,
  Info,
  Projector,
  RefreshCw,
  Trash2,
} from '../components/icons'
import '../styles.css'
import type { TaskStatus } from '../types'
import { applyTheme, resolveTheme } from '../lib/theme'
import { useAppStore } from '../store/appStore'
import { Badge, FileKindBadge, SourceBadge, StatusBadge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Checkbox } from '../components/ui/Checkbox'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorBanner } from '../components/ui/ErrorBanner'
import { Field, Input } from '../components/ui/Input'
import { PathText } from '../components/ui/PathText'
import { ProgressBar } from '../components/ui/ProgressBar'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Skeleton, SkeletonRegion } from '../components/ui/Skeleton'
import { StatCard } from '../components/ui/StatCard'
import { Switch } from '../components/ui/Switch'
import { ToastViewport } from '../components/ui/Toasts'

const TASK_STATUSES: TaskStatus[] = [
  'queued',
  'active',
  'pausing',
  'paused',
  'completed',
  'error',
  'cancelled',
]

const LONG_PATH =
  'C:\\Models\\unsloth\\flint-GGUF\\flint-UD-Q6_K_XL.gguf'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="mb-3 text-section text-fg">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function PreviewApp() {
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => resolveTheme((document.documentElement.dataset.theme as 'light' | 'dark') ?? 'light'),
  )
  const [check, setCheck] = useState(true)
  const [switched, setSwitched] = useState(true)
  const [filter, setFilter] = useState<'all' | 'weight' | 'mmproj'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [actionCount, setActionCount] = useState(0)
  const pushToast = useAppStore((state) => state.pushToast)

  useEffect(() => {
    applyTheme(theme)
    const url = new URL(window.location.href)
    url.searchParams.set('theme', theme)
    window.history.replaceState(null, '', url.toString())
  }, [theme])

  useEffect(() => {
    pushToast('success', '设置已保存', '新的下载参数已立即生效。')
    pushToast('error', '下载失败', 'HTTP 403：该仓库需要授权。')
    pushToast('info', '已加入下载队列', '共 3 个文件。')
    // 仅用于首次加载时展示带动作的 Toast（验证 ui/Toasts action API）。
    pushToast('success', '下载完成', 'flint-UD-Q6_K_XL.gguf 已保存到本地模型库。', {
      label: '打开位置',
      onClick: () => setActionCount((count) => count + 1),
    })
  }, [pushToast])

  return (
    <div className="min-h-screen bg-bg p-6 text-fg">
      <div className="mx-auto max-w-[1180px] space-y-4 pb-16">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-page text-fg">UI 组件画廊</h1>
            <p className="mt-1 text-meta text-fg-secondary">
              DESIGN-TOKENS v1 · 双主题视觉验收（开发期页面，不参与生产构建）
            </p>
          </div>
          <SegmentedControl
            ariaLabel="切换主题"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </header>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section title="Button">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" leftIcon={<Download className="h-4 w-4" />}>
                开始下载
              </Button>
              <Button variant="secondary" leftIcon={<RefreshCw className="h-4 w-4" />}>
                刷新
              </Button>
              <Button variant="ghost">清空选择</Button>
              <Button variant="subtle">分组</Button>
              <Button variant="danger" leftIcon={<Trash2 className="h-4 w-4" />}>
                删除文件
              </Button>
              <Button variant="dangerGhost" leftIcon={<Trash2 className="h-4 w-4" />}>
                删除记录
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs">xs 28</Button>
              <Button size="sm">sm 32</Button>
              <Button size="md">md 36</Button>
              <Button size="lg">lg 40</Button>
              <Button size="icon" aria-label="打开目录" title="打开目录">
                <FolderOpen className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button loading>保存中</Button>
              <Button disabled>禁用</Button>
            </div>
          </Section>

          <Section title="Badge / 来源 / 文件类型">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="blue">下载目录</Badge>
              <Badge tone="emerald">公开仓库</Badge>
              <Badge tone="amber">需授权</Badge>
              <Badge tone="red">失败</Badge>
              <Badge tone="violet">revision: main</Badge>
              <Badge tone="slate">+3</Badge>
              <SourceBadge source="huggingface" />
              <SourceBadge source="modelscope" />
              <SourceBadge source="huggingface" short />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <FileKindBadge kind="weight" />
              <FileKindBadge kind="mmproj" />
              <FileKindBadge kind="imatrix" />
              <FileKindBadge kind="config" />
              <FileKindBadge kind="other" />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {TASK_STATUSES.map((status) => (
                <StatusBadge key={status} status={status} />
              ))}
            </div>
          </Section>

          <Section title="Input / Field">
            <Field label="搜索仓库" htmlFor="preview-search" hint="按文件名或相对路径过滤，元信息最小 12px。">
              <Input id="preview-search" placeholder="搜索 HuggingFace 仓库…" />
            </Field>
            <Field
              label="下载目录"
              htmlFor="preview-dir"
              error="请填写绝对路径，例如 C:\\Models"
            >
              <Input id="preview-dir" defaultValue={LONG_PATH} />
            </Field>
            <Field label="Token" htmlFor="preview-token" optional hint="Token 仅保存在本机。">
              <Input id="preview-token" type="password" placeholder="hf_..." />
            </Field>
          </Section>

          <Section title="Switch / Checkbox / SegmentedControl">
            <div className="flex items-center justify-between gap-3">
              <span className="text-body text-fg">启动时自动继续</span>
              <Switch
                checked={switched}
                onChange={setSwitched}
                ariaLabel="启动时自动继续未完成任务"
              />
            </div>
            <label className="flex items-center gap-2 text-body text-fg">
              <Checkbox
                checked={check}
                onChange={setCheck}
                ariaLabel="同时删除下载记录"
              />
              同时删除下载记录
            </label>
            <SegmentedControl
              ariaLabel="文件类型筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: '全部', count: 127 },
                { value: 'weight', label: '权重', count: 42 },
                { value: 'mmproj', label: '投影器', count: 2, title: '多模态投影器（mmproj）' },
              ]}
            />
            <PathText path={LONG_PATH} onCopied={() => pushToast('success', '已复制路径')} />
            <PathText path="C:\\Models\\Qwen\\Qwen2.5-VL-7B-Instruct\\clip_vision_model.safetensors" />
          </Section>

          <Section title="StatCard / ProgressBar">
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label="总占用空间"
                value="255 GB"
                hint="共 127 个文件"
                icon={HardDrive}
                tone="blue"
              />
              <StatCard
                label="投影器 / 矩阵"
                value="2 / 1"
                hint="大小 2.02 GB / 1.18 MB"
                icon={Projector}
                tone="violet"
              />
              <StatCard
                label="配置 / 其他"
                value="73 / 9"
                hint="大小 41.2 MB / 5.02 GB"
                icon={FileCog}
                tone="emerald"
              />
              <StatCard label="已暂停" value="2" hint="失败 1 · 已取消 1" icon={Gauge} tone="amber" />
            </div>
            <div className="space-y-2.5">
              <ProgressBar value={46} status="active" ariaLabel="下载 Qwen2.5-7B 权重：下载中" />
              <ProgressBar value={100} status="completed" ariaLabel="下载 whisper 模型：已完成" />
              <ProgressBar value={63} status="paused" ariaLabel="下载 flint Q6：已暂停" />
              <ProgressBar value={28} status="error" ariaLabel="下载 Llama 权重：失败" />
              <ProgressBar value={0} indeterminate status="active" ariaLabel="下载未知大小文件：进行中" />
            </div>
          </Section>

          <Section title="EmptyState / ErrorBanner / Skeleton">
            <EmptyState
              icon={Info}
              title="没有匹配的文件"
              description="试试其他关键词或更换类型筛选。"
              compact
            />
            <ErrorBanner
              title="扫描本地模型库失败"
              message="无法读取下载目录，请检查路径是否存在或是否有读取权限。"
              onRetry={() => undefined}
            />
            <SkeletonRegion className="space-y-2" label="正在加载组件预览…">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-8 w-40" />
            </SkeletonRegion>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setDialogOpen(true)}
                leftIcon={<AlertCircle className="h-3.5 w-3.5" />}
              >
                打开确认框
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => pushToast('success', '下载完成', '已保存到本地模型库。')}
                leftIcon={<Check className="h-3.5 w-3.5" />}
              >
                触发成功 Toast
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  pushToast('success', '下载完成', 'flint-UD-Q6_K_XL.gguf 已保存。', {
                    label: '打开位置',
                    onClick: () => setActionCount((count) => count + 1),
                  })
                }
              >
                带动作 Toast
              </Button>
              <span className="text-meta text-fg-secondary">动作已执行 {actionCount} 次</span>
            </div>
          </Section>
        </div>
      </div>

      <ConfirmDialog
        open={dialogOpen}
        title="删除本地文件？"
        description="将从磁盘永久删除该文件，此操作无法撤销。"
        confirmLabel="删除文件"
        onConfirm={() => {
          setDialogOpen(false)
          pushToast('success', '已删除本地文件')
        }}
        onClose={() => setDialogOpen(false)}
      />
      <ToastViewport />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<PreviewApp />)
