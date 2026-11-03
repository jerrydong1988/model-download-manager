import type { FileKind, Source, TaskStatus } from '../types'

/** 来源显示名 */
export const SOURCE_LABEL: Record<Source, string> = {
  huggingface: 'HuggingFace',
  modelscope: 'ModelScope',
}

/** 紧凑场景（任务行等）使用的来源缩写 */
export const SOURCE_SHORT: Record<Source, string> = {
  huggingface: 'HF',
  modelscope: 'MS',
}

/** 来源配色（完整 class 字符串，保证 Tailwind 可扫描；含 dark: 变体） */
export const SOURCE_STYLE: Record<
  Source,
  { chip: string; icon: string; dot: string }
> = {
  huggingface: {
    chip: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300',
    icon: 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300',
    dot: 'bg-amber-500',
  },
  modelscope: {
    chip: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-300',
    icon: 'bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300',
    dot: 'bg-sky-500',
  },
}

/** 文件分类显示名 */
export const FILE_KIND_LABEL: Record<FileKind, string> = {
  weight: '权重',
  mmproj: '投影器',
  imatrix: '权重矩阵',
  config: '配置',
  other: '其他',
}

/** 文件分类配色（颜色 + 文本双编码；dark: 变体见 DESIGN-TOKENS §1） */
export const FILE_KIND_STYLE: Record<FileKind, string> = {
  weight:
    'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-300',
  mmproj:
    'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-300',
  imatrix:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300',
  config:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  other:
    'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
}

/** 任务状态显示名 */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  active: '下载中',
  pausing: '正在暂停',
  paused: '已暂停',
  completed: '已完成',
  error: '失败',
  cancelled: '已取消',
}

/** 任务状态徽章 / 进度条 / 指示点配色（含 dark: 变体） */
export const TASK_STATUS_STYLE: Record<
  TaskStatus,
  { badge: string; bar: string; dot: string; text: string }
> = {
  queued: {
    badge: 'border-line bg-surface-2 text-fg-secondary',
    bar: 'bg-line-strong',
    dot: 'bg-fg-disabled',
    text: 'text-fg-secondary',
  },
  active: {
    badge: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/60 dark:bg-blue-950/40 dark:text-blue-300',
    bar: 'bg-primary',
    dot: 'bg-primary',
    text: 'text-primary',
  },
  pausing: {
    badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300',
    bar: 'bg-warning',
    dot: 'bg-warning',
    text: 'text-warning',
  },
  paused: {
    badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300',
    bar: 'bg-warning',
    dot: 'bg-warning',
    text: 'text-warning',
  },
  completed: {
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300',
    bar: 'bg-success',
    dot: 'bg-success',
    text: 'text-success',
  },
  error: {
    badge: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300',
    bar: 'bg-danger',
    dot: 'bg-danger',
    text: 'text-danger',
  },
  cancelled: {
    badge: 'border-line bg-surface-2 text-fg-muted',
    bar: 'bg-line-strong',
    dot: 'bg-fg-disabled',
    text: 'text-fg-muted',
  },
}

/** 任务分组/筛选顺序 */
export const TASK_STATUS_ORDER: TaskStatus[] = [
  'active',
  'pausing',
  'queued',
  'paused',
  'error',
  'completed',
  'cancelled',
]

/** HuggingFace pipeline_tag 的中文展示（未收录时原样展示）。 */
const PIPELINE_LABELS: Record<string, string> = {
  'text-generation': '文本生成',
  'feature-extraction': '特征抽取',
  'automatic-speech-recognition': '语音识别',
  'text-to-image': '文生图',
  'image-text-to-text': '图文对话',
  'text-to-speech': '语音合成',
  'image-classification': '图像分类',
  'text-classification': '文本分类',
  'fill-mask': '掩码填充',
  'sentence-similarity': '句向量',
}

export function pipelineTagLabel(tag: string): string {
  return PIPELINE_LABELS[tag] ?? tag
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}

/** active / pausing 视为“下载中” */
export function isRunningStatus(status: TaskStatus): boolean {
  return status === 'active' || status === 'pausing'
}
