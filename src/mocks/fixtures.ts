/**
 * 浏览器 mock 模式的固定数据。
 * 仅在 ?mock=1 / VITE_MOCK=1 时被 mocks/mockIpc.ts 使用，Tauri 生产环境不会加载。
 */

import type {
  DownloadTask,
  LocalFile,
  RepoDetail,
  RepoFile,
  RepoSummary,
  RevisionList,
  Settings,
} from '../types'
import { defaultRevisionFor } from '../lib/format'

export const MOCK_APP_VERSION = '0.4.2'
export const MOCK_DATA_DIR = 'C:\\DemoAppData\\com.modeldownload.manager'
export const MOCK_DEFAULT_DOWNLOAD_DIR = 'C:\\Models'
/** v0.5.0：在线升级验收（?mock=1&update=1 时模拟发现新版本）。 */
export const MOCK_UPDATE_VERSION = '0.5.0'
export const MOCK_UPDATE_NOTES =
  'v0.5.0 更新内容：\n· 应用内在线升级（设置页一键下载安装）\n· 启动自动检查新版本（可在设置中关闭）'
/** v0.2.0：多扫描根验收用的附加根目录（仅 ?mock=1&multiroot=1 时写入 settings.libraryRoots）。 */
export const MOCK_LIBRARY_ROOT_2 = 'D:\\AI\\Models-Roots\\Research'
export const MOCK_LIBRARY_ROOT_3 = 'E:\\LLM-Cache'
/** 与后端默认值保持一致：国内网络默认走 hf-mirror 镜像（huggingface.co 不可达时仍可搜索/下载）。 */
export const MOCK_HF_ENDPOINT = 'https://hf-mirror.com'
export const MOCK_HF_MIRROR = 'https://hf-mirror.com'
export const MOCK_MS_ENDPOINT = 'https://www.modelscope.cn'

export function createMockSettings(): Settings {
  return {
    downloadDir: MOCK_DEFAULT_DOWNLOAD_DIR,
    hfToken: '',
    msToken: '',
    hfEndpoint: MOCK_HF_ENDPOINT,
    msEndpoint: MOCK_MS_ENDPOINT,
    proxy: '',
    concurrency: 3,
    bandwidthLimit: 0,
    maxRetries: 3,
    autoResume: true,
    // v0.1.3：主题默认跟随系统；关闭窗口隐藏到托盘并继续后台下载；完成/失败发系统通知。
    theme: 'system',
    closeToTray: true,
    notificationsEnabled: true,
    // v0.2.0：单文件 4 连接；默认只扫描 downloadDir（附加根为空）。
    connectionsPerFile: 4,
    libraryRoots: [],
    // v0.5.0：默认自动检查更新；更新源留空 = 内置 GitHub 源。
    autoCheckUpdates: true,
    updateEndpoint: '',
  }
}

/* ------------------------------------------------------------------ */
/* 仓库搜索数据                                                        */
/* ------------------------------------------------------------------ */

type RepoSeed = Omit<RepoSummary, 'source'>

function repo(seed: RepoSeed, source: RepoSummary['source']): RepoSummary {
  return { ...seed, source }
}

const HF_REPOS: RepoSummary[] = [
  repo(
    {
      id: 'Qwen/Qwen2.5-7B-Instruct',
      downloads: 8_432_110,
      likes: 1_240,
      lastModified: '2025-01-28T08:12:00Z',
      tags: ['transformers', 'safetensors', 'qwen2', 'text-generation', '7B', 'chat'],
      pipelineTag: 'text-generation',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
      downloads: 3_921_456,
      likes: 892,
      lastModified: '2025-03-10T06:45:00Z',
      tags: ['transformers', 'safetensors', 'deepseek', 'text-generation', 'distill'],
      pipelineTag: 'text-generation',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'meta-llama/Llama-3.1-8B-Instruct',
      downloads: 12_840_220,
      likes: 6_312,
      lastModified: '2024-12-05T18:20:00Z',
      tags: ['transformers', 'safetensors', 'llama', 'text-generation', '8B'],
      pipelineTag: 'text-generation',
      gated: true,
    },
    'huggingface',
  ),
  repo(
    {
      id: 'BAAI/bge-m3',
      downloads: 5_120_330,
      likes: 1_754,
      lastModified: '2024-09-18T10:00:00Z',
      tags: ['sentence-transformers', 'pytorch', 'feature-extraction', 'm3', 'multilingual'],
      pipelineTag: 'feature-extraction',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'openai/whisper-large-v3',
      downloads: 2_310_880,
      likes: 4_102,
      lastModified: '2024-11-02T12:30:00Z',
      tags: ['transformers', 'safetensors', 'audio', 'automatic-speech-recognition', 'whisper'],
      pipelineTag: 'automatic-speech-recognition',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'microsoft/Phi-3-mini-4k-instruct',
      downloads: 1_982_440,
      likes: 782,
      lastModified: '2024-08-21T05:16:00Z',
      tags: ['transformers', 'safetensors', 'phi3', 'text-generation', '4k'],
      pipelineTag: 'text-generation',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'black-forest-labs/FLUX.1-dev',
      downloads: 4_201_330,
      likes: 10_240,
      lastModified: '2025-02-14T15:40:00Z',
      tags: ['diffusers', 'text-to-image', 'flux', 'image-generation'],
      pipelineTag: 'text-to-image',
      gated: true,
    },
    'huggingface',
  ),
  repo(
    {
      id: 'Qwen/Qwen3-235B-A22B',
      downloads: 1_203_400,
      likes: 2_912,
      lastModified: '2025-04-28T09:00:00Z',
      tags: ['transformers', 'safetensors', 'qwen3', 'text-generation', 'moe', '235B'],
      pipelineTag: 'text-generation',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'moonshotai/Kimi-K2-Instruct',
      downloads: 340_120,
      likes: 1_310,
      lastModified: '2025-07-11T07:22:00Z',
      tags: ['transformers', 'safetensors', 'kimi', 'text-generation', 'moe'],
      pipelineTag: 'text-generation',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'Qwen/Qwen2.5-0.5B-Instruct',
      downloads: 2_104_330,
      likes: 318,
      lastModified: '2025-01-28T08:12:00Z',
      tags: ['transformers', 'safetensors', 'qwen2', 'text-generation', '0.5B'],
      pipelineTag: 'text-generation',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'Qwen/Qwen2.5-VL-7B-Instruct',
      downloads: 1_410_500,
      likes: 663,
      lastModified: '2025-02-01T03:30:00Z',
      tags: ['transformers', 'safetensors', 'qwen2-vl', 'image-text-to-text', 'vision'],
      pipelineTag: 'image-text-to-text',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'nvidia/parakeet-tdt-0.6b-v2',
      downloads: 88_220,
      likes: 412,
      lastModified: '2025-05-19T11:10:00Z',
      tags: ['transformers', 'onnx', 'audio', 'automatic-speech-recognition', 'nemo'],
      pipelineTag: 'automatic-speech-recognition',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'sentence-transformers/all-MiniLM-L6-v2',
      downloads: 45_003_210,
      likes: 9_820,
      lastModified: '2024-07-02T09:45:00Z',
      tags: ['sentence-transformers', 'pytorch', 'feature-extraction', 'bert', 'mini'],
      pipelineTag: 'feature-extraction',
    },
    'huggingface',
  ),
  repo(
    {
      id: 'stabilityai/stable-diffusion-xl-base-1.0',
      downloads: 3_001_200,
      likes: 8_930,
      lastModified: '2024-10-15T16:25:00Z',
      tags: ['diffusers', 'text-to-image', 'stable-diffusion', 'sdxl'],
      pipelineTag: 'text-to-image',
      gated: true,
    },
    'huggingface',
  ),
]

const MS_REPOS: RepoSummary[] = [
  repo(
    {
      id: 'Qwen/Qwen2.5-7B-Instruct',
      downloads: 5_632_100,
      likes: 620,
      lastModified: '2025-01-29T02:20:00Z',
      tags: ['pytorch', 'safetensors', 'qwen2', 'text-generation'],
      pipelineTag: 'text-generation',
    },
    'modelscope',
  ),
  repo(
    {
      id: 'deepseek-ai/DeepSeek-V3',
      downloads: 1_204_300,
      likes: 1_820,
      lastModified: '2025-01-06T10:00:00Z',
      tags: ['pytorch', 'safetensors', 'deepseek', 'text-generation', 'moe'],
      pipelineTag: 'text-generation',
    },
    'modelscope',
  ),
  repo(
    {
      id: 'BAAI/bge-m3',
      downloads: 2_310_000,
      likes: 905,
      lastModified: '2024-09-20T07:30:00Z',
      tags: ['pytorch', 'feature-extraction', 'm3', 'sentence-transformers'],
      pipelineTag: 'feature-extraction',
    },
    'modelscope',
  ),
  repo(
    {
      id: 'Qwen/Qwen2.5-Coder-7B-Instruct',
      downloads: 892_000,
      likes: 380,
      lastModified: '2025-02-14T06:28:00Z',
      tags: ['pytorch', 'qwen2', 'code', 'text-generation'],
      pipelineTag: 'text-generation',
    },
    'modelscope',
  ),
  repo(
    {
      id: 'AI-ModelScope/stable-diffusion-v1-5',
      downloads: 430_000,
      likes: 555,
      lastModified: '2024-05-09T13:12:00Z',
      tags: ['pytorch', 'text-to-image', 'stable-diffusion'],
      pipelineTag: 'text-to-image',
    },
    'modelscope',
  ),
  repo(
    {
      id: 'iic/CosyVoice2-0.5B',
      downloads: 120_400,
      likes: 422,
      lastModified: '2025-03-21T08:36:00Z',
      tags: ['pytorch', 'text-to-speech', 'tts', 'cosyvoice'],
      pipelineTag: 'text-to-speech',
    },
    'modelscope',
  ),
  repo(
    {
      id: 'Qwen/Qwen3-235B-A22B',
      downloads: 300_200,
      likes: 701,
      lastModified: '2025-04-29T04:15:00Z',
      tags: ['pytorch', 'safetensors', 'qwen3', 'moe', '235B'],
      pipelineTag: 'text-generation',
    },
    'modelscope',
  ),
  repo(
    {
      id: 'iic/SenseVoiceSmall',
      downloads: 98_700,
      likes: 266,
      lastModified: '2025-01-17T09:05:00Z',
      tags: ['pytorch', 'audio', 'asr', 'sensevoice'],
      pipelineTag: 'automatic-speech-recognition',
    },
    'modelscope',
  ),
]

export const MOCK_REPOS: RepoSummary[] = [...HF_REPOS, ...MS_REPOS]

export function findMockRepo(source: RepoSummary['source'], repoId: string): RepoSummary | undefined {
  return MOCK_REPOS.find((item) => item.source === source && item.id === repoId)
}

/* ------------------------------------------------------------------ */
/* 文件分类（与后端 util::classify_file 规则一致）                      */
/* ------------------------------------------------------------------ */

const WEIGHT_EXT = new Set([
  '.safetensors',
  '.bin',
  '.pt',
  '.pth',
  '.gguf',
  '.onnx',
  '.ckpt',
  '.h5',
  '.msgpack',
  '.npz',
  '.engine',
  '.tflite',
  '.mlmodel',
  '.ot',
  '.pkl',
  '.hgn',
])

const CONFIG_EXT = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.md',
  '.model',
  '.tiktoken',
  '.py',
  '.jinja',
  '.cfg',
  '.ini',
  '.toml',
])

/** 与契约 §2 分类规则一致。 */
export function classifyRepoPath(path: string): RepoFile['kind'] {
  const lower = path.toLowerCase()
  const fileName = lower.split('/').pop() ?? lower
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot) : ''
  const isWeightLike =
    WEIGHT_EXT.has(ext) ||
    lower.endsWith('.safetensors.index.json') ||
    lower.endsWith('.bin.index.json')
  // 量化重要性矩阵优先于权重判断（例如 imatrix_unsloth.gguf_file）。
  if (fileName.includes('imatrix')) return 'imatrix'
  // 多模态投影器：文件名含 mmproj / clip 词元，且为权重类扩展名。
  if (isWeightLike && (fileName.includes('mmproj') || fileName.includes('clip'))) {
    return 'mmproj'
  }
  if (isWeightLike) return 'weight'
  if (CONFIG_EXT.has(ext)) return 'config'
  return 'other'
}

function shardFiles(count: number, sizeEach: number, base = 'model'): Array<{ path: string; size: number }> {
  const total = String(count).padStart(5, '0')
  return Array.from({ length: count }, (_, index) => ({
    path: `${base}-${String(index + 1).padStart(5, '0')}-of-${total}.safetensors`,
    size: sizeEach,
  }))
}

function buildWeightFiles(repoId: string): Array<{ path: string; size: number }> {
  const id = repoId.toLowerCase()
  if (id.includes('qwen3-235b')) return shardFiles(540, 438_400_000)
  if (id.includes('kimi-k2')) return shardFiles(186, 4_100_000_000)
  if (id.includes('deepseek-v3')) return shardFiles(163, 4_320_000_000)
  if (id.includes('deepseek-r1-distill-qwen-7b')) return shardFiles(4, 3_910_000_000)
  if (id.includes('qwen2.5-vl-7b')) return shardFiles(4, 4_140_000_000)
  if (id.includes('qwen2.5-coder-7b')) return shardFiles(4, 3_820_000_000)
  if (id.includes('qwen2.5-7b')) return shardFiles(4, 3_970_000_000)
  if (id.includes('qwen2.5-0.5b')) return [{ path: 'model.safetensors', size: 988_100_000 }]
  if (id.includes('llama-3.1-8b')) return shardFiles(4, 4_920_000_000)
  if (id.includes('phi-3-mini')) return shardFiles(2, 2_380_000_000)
  if (id.includes('bge-m3')) return [{ path: 'pytorch_model.bin', size: 2_271_000_000 }]
  if (id.includes('whisper-large-v3')) return [{ path: 'model.safetensors', size: 3_090_000_000 }]
  if (id.includes('all-minilm')) return [{ path: 'model.safetensors', size: 90_900_000 }]
  if (id.includes('parakeet')) return [{ path: 'encoder.onnx', size: 0 }]
  if (id.includes('flux.1-dev')) {
    return [
      ...shardFiles(3, 9_900_000_000, 'diffusion_pytorch_model').map((file) => ({
        ...file,
        path: `transformer/${file.path}`,
      })),
      { path: 'ae.safetensors', size: 335_000_000 },
      { path: 'text_encoder/model.safetensors', size: 4_870_000_000 },
      { path: 'text_encoder_2/model.safetensors', size: 6_940_000_000 },
    ]
  }
  if (id.includes('stable-diffusion-xl')) {
    return [
      { path: 'unet/diffusion_pytorch_model.safetensors', size: 5_140_000_000 },
      { path: 'vae/diffusion_pytorch_model.safetensors', size: 335_000_000 },
      { path: 'text_encoder/model.safetensors', size: 492_000_000 },
      { path: 'text_encoder_2/model.safetensors', size: 1_390_000_000 },
    ]
  }
  if (id.includes('stable-diffusion-v1-5')) {
    return [{ path: 'v1-5-pruned-emaonly.ckpt', size: 4_270_000_000 }]
  }
  if (id.includes('cosyvoice2')) {
    return [
      { path: 'llm.pt', size: 1_020_000_000 },
      { path: 'flow.pt', size: 310_000_000 },
      { path: 'hift.pt', size: 210_000_000 },
    ]
  }
  if (id.includes('sensevoice')) return [{ path: 'model.pt', size: 936_000_000 }]
  return shardFiles(2, 2_400_000_000)
}

function buildConfigFiles(repoId: string): Array<{ path: string; size: number }> {
  const id = repoId.toLowerCase()
  const common: Array<{ path: string; size: number }> = [
    { path: '.gitattributes', size: 1_500 },
    { path: 'README.md', size: 24_800 },
    { path: 'config.json', size: 1_200 },
    { path: 'tokenizer_config.json', size: 12_400 },
    { path: 'special_tokens_map.json', size: 694 },
  ]
  if (id.includes('bge-m3')) {
    return [
      ...common,
      { path: 'sentence_bert_config.json', size: 260 },
      { path: 'tokenizer.json', size: 17_100_000 },
    ]
  }
  if (id.includes('stable-diffusion') || id.includes('flux')) {
    return [
      ...common,
      { path: 'model_index.json', size: 1_800 },
      { path: 'scheduler/scheduler_config.json', size: 1_100 },
      { path: 'tokenizer/tokenizer_config.json', size: 4_600 },
      { path: 'tokenizer/vocab.json', size: 1_060_000 },
    ]
  }
  if (id.includes('whisper')) {
    return [
      ...common,
      { path: 'generation_config.json', size: 3_600 },
      { path: 'preprocessor_config.json', size: 1_850 },
      { path: 'tokenizer.json', size: 2_480_000 },
      { path: 'vocab.json', size: 1_036_000 },
      { path: 'merges.txt', size: 524_000 },
    ]
  }
  if (id.includes('cosyvoice') || id.includes('sensevoice')) {
    return [
      ...common,
      { path: 'configuration.json', size: 1_900 },
      { path: 'am.mvn', size: 3_100 },
      { path: 'tokens.json', size: 128_000 },
    ]
  }
  return [
    ...common,
    { path: 'generation_config.json', size: 820 },
    { path: 'tokenizer.json', size: 1_804_000 },
    { path: 'vocab.json', size: 1_210_000 },
    { path: 'merges.txt', size: 1_090_000 },
    { path: 'chat_template.jinja', size: 4_200 },
  ]
}

const DETAIL_CACHE = new Map<string, RepoDetail>()

const LICENSE_BY_REPO: Record<string, string> = {
  'meta-llama/Llama-3.1-8B-Instruct': 'llama3.1',
  'black-forest-labs/FLUX.1-dev': 'flux-1-dev-non-commercial-license',
  'stabilityai/stable-diffusion-xl-base-1.0': 'openrail++',
  'AI-ModelScope/stable-diffusion-v1-5': 'creativeml-openrail-m',
  'deepseek-ai/DeepSeek-V3': 'deepseek-license',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B': 'mit',
}

export function getMockRepoDetail(
  source: RepoSummary['source'],
  repoId: string,
  revision?: string,
): RepoDetail {
  const resolvedRevision = revision?.trim() || defaultRevisionFor(source)
  const key = `${source}:${repoId}:${resolvedRevision}`
  const cached = DETAIL_CACHE.get(key)
  if (cached) return cached

  const summary = findMockRepo(source, repoId)
  if (!summary) {
    throw new Error(`仓库不存在或无法访问：${repoId}`)
  }

  const pathMap = new Map<string, number>()
  for (const file of [...buildConfigFiles(repoId), ...buildWeightFiles(repoId)]) {
    pathMap.set(file.path, file.size)
  }
  // 少量“其他”类文件，用于展示 other 徽章。
  if (repoId.startsWith('Qwen/') || repoId.includes('stable-diffusion')) {
    pathMap.set('figures/architecture.png', 248_000)
  }
  if (repoId.includes('FLUX') || repoId.includes('Llama')) {
    pathMap.set('assets/cover.jpg', 386_000)
  }
  if (repoId.includes('DeepSeek-V3')) {
    pathMap.set('figures/moe-overview.png', 512_000)
  }
  // 视觉模型仓库：mmproj / clip 投影器 + imatrix 样例（v0.1.2 新分类）。
  if (repoId.includes('Qwen2.5-VL')) {
    pathMap.set('mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf', 1_340_000_000)
    pathMap.set('clip_vision_model.safetensors', 830_000_000)
    pathMap.set('imatrix_unsloth.gguf_file', 1_240_000)
  }
  // v0.2.0：非默认 revision 的 mock 文件列表与默认分支不同（便于 UI 验收切换生效）：
  // 只保留一个权重分片 + 追加 revision 标记文件，保证文件列表变化且仍可选中下载。
  if (resolvedRevision !== defaultRevisionFor(source)) {
    const safe = resolvedRevision.replace(/[^\w.-]+/g, '-')
    const weightPaths = [...pathMap.keys()].filter((path) => path.endsWith('.safetensors'))
    for (const weightPath of weightPaths.slice(1)) pathMap.delete(weightPath)
    pathMap.set(`revision-${safe}.md`, 1_024)
    pathMap.set(`build-info-${safe}.json`, 2_048)
  }

  const files: RepoFile[] = [...pathMap.entries()]
    .map(([path, size]) => ({
      path,
      name: path.split('/').pop() ?? path,
      size,
      kind: classifyRepoPath(path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const detail: RepoDetail = {
    id: repoId,
    source,
    revision: resolvedRevision,
    files,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    downloads: summary.downloads,
    likes: summary.likes,
    lastModified: summary.lastModified,
    tags: summary.tags,
    gated: summary.gated,
    license: LICENSE_BY_REPO[repoId] ?? 'apache-2.0',
  }
  DETAIL_CACHE.set(key, detail)
  return detail
}

/** v0.2.0：mock 可下载 revision 列表（多分支 + 标签；两源均允许自定义文本）。 */
export function getMockRevisions(
  source: RepoSummary['source'],
  repoId: string,
): RevisionList {
  const defaultRevision = defaultRevisionFor(source)
  if (!findMockRepo(source, repoId)) {
    // 未收录仓库也返回可用默认值，避免 UI 因 refs 不可用而不可挑 revision。
    return {
      source,
      repoId,
      defaultRevision,
      branches: [defaultRevision],
      tags: ['v1.0'],
    }
  }
  if (source === 'huggingface') {
    return {
      source,
      repoId,
      defaultRevision,
      branches: [defaultRevision, 'dev', 'release/v1'],
      tags: ['v1.0', 'v1.1', 'v0.9'],
    }
  }
  return {
    source,
    repoId,
    defaultRevision,
    branches: [defaultRevision, 'dev'],
    tags: ['v1.0', 'v0.9'],
  }
}

/* ------------------------------------------------------------------ */
/* 路径工具                                                            */
/* ------------------------------------------------------------------ */

export function windowsJoin(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter(Boolean)
    .join('\\')
}

/** 契约 §5.1：{saveDir}/{repoId}/{remotePath} */
export function mockFinalPath(saveDir: string, repoId: string, remotePath: string): string {
  const base = saveDir.replace(/[\\/]+$/, '')
  return [
    base,
    repoId.replace(/[\\/]+/g, '\\'),
    remotePath.replace(/[\\/]+/g, '\\'),
  ].join('\\')
}

/* ------------------------------------------------------------------ */
/* 任务 fixture                                                        */
/* ------------------------------------------------------------------ */

interface TaskSeed {
  source: DownloadTask['source']
  repoId: string
  remotePath: string
  totalSize: number
  downloaded: number
  status: DownloadTask['status']
  speed: number
  addedMinutesAgo: number
  completedMinutesAgo?: number
  error?: string
  retries?: number
  /** v0.2.0：缺省用来源默认 revision */
  revision?: string
}

export function createMockTasks(settings: Settings): DownloadTask[] {
  const seeds: TaskSeed[] = [
    {
      source: 'huggingface',
      repoId: 'Qwen/Qwen2.5-7B-Instruct',
      remotePath: 'model-00002-of-00004.safetensors',
      totalSize: 3_970_000_000,
      downloaded: 1_640_000_000,
      status: 'active',
      speed: 47_800_000,
      addedMinutesAgo: 18,
    },
    {
      source: 'huggingface',
      repoId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
      remotePath: 'model-00001-of-00004.safetensors',
      totalSize: 3_910_000_000,
      downloaded: 2_070_000_000,
      status: 'active',
      speed: 33_200_000,
      addedMinutesAgo: 15,
    },
    {
      source: 'huggingface',
      repoId: 'nvidia/parakeet-tdt-0.6b-v2',
      remotePath: 'encoder.onnx',
      totalSize: 0,
      downloaded: 128_000_000,
      status: 'active',
      speed: 9_100_000,
      addedMinutesAgo: 11,
    },
    {
      source: 'huggingface',
      repoId: 'BAAI/bge-m3',
      remotePath: 'pytorch_model.bin',
      totalSize: 2_271_000_000,
      downloaded: 0,
      status: 'queued',
      speed: 0,
      addedMinutesAgo: 9,
    },
    {
      source: 'huggingface',
      repoId: 'microsoft/Phi-3-mini-4k-instruct',
      remotePath: 'model-00001-of-00002.safetensors',
      totalSize: 2_380_000_000,
      downloaded: 0,
      status: 'queued',
      speed: 0,
      addedMinutesAgo: 8,
    },
    {
      source: 'huggingface',
      repoId: 'Qwen/Qwen2.5-VL-7B-Instruct',
      remotePath: 'model-00003-of-00004.safetensors',
      totalSize: 4_140_000_000,
      downloaded: 1_210_000_000,
      status: 'paused',
      speed: 0,
      addedMinutesAgo: 40,
    },
    {
      source: 'huggingface',
      repoId: 'Qwen/Qwen2.5-7B-Instruct',
      remotePath: 'model-00004-of-00004.safetensors',
      totalSize: 3_970_000_000,
      downloaded: 0,
      status: 'paused',
      speed: 0,
      addedMinutesAgo: 38,
      // v0.2.0 验收：非默认 revision 任务展示徽章
      revision: 'v1.0',
    },
    {
      source: 'huggingface',
      repoId: 'meta-llama/Llama-3.1-8B-Instruct',
      remotePath: 'model-00001-of-00004.safetensors',
      totalSize: 4_920_000_000,
      downloaded: 1_270_000_000,
      status: 'error',
      speed: 0,
      error:
        '下载失败：HTTP 403 Forbidden。该仓库需要授权，请在设置中填写 HuggingFace Token，并先在网页端同意许可协议。',
      retries: 3,
      addedMinutesAgo: 70,
    },
    {
      source: 'huggingface',
      repoId: 'microsoft/Phi-3-mini-4k-instruct',
      remotePath: 'tokenizer.json',
      totalSize: 1_804_000,
      downloaded: 0,
      status: 'cancelled',
      speed: 0,
      addedMinutesAgo: 90,
    },
    {
      source: 'huggingface',
      repoId: 'openai/whisper-large-v3',
      remotePath: 'model.safetensors',
      totalSize: 3_090_000_000,
      downloaded: 3_090_000_000,
      status: 'completed',
      speed: 0,
      addedMinutesAgo: 180,
      completedMinutesAgo: 120,
    },
    {
      source: 'huggingface',
      repoId: 'Qwen/Qwen2.5-0.5B-Instruct',
      remotePath: 'model.safetensors',
      totalSize: 988_100_000,
      downloaded: 988_100_000,
      status: 'completed',
      speed: 0,
      addedMinutesAgo: 1_500,
      completedMinutesAgo: 1_440,
    },
    {
      source: 'huggingface',
      repoId: 'BAAI/bge-m3',
      remotePath: 'config.json',
      totalSize: 1_200,
      downloaded: 1_200,
      status: 'completed',
      speed: 0,
      addedMinutesAgo: 300,
      completedMinutesAgo: 290,
      revision: 'v1.0',
    },
  ]

  const now = Date.now()
  return seeds.map((seed, index) => {
    const savePath = mockFinalPath(settings.downloadDir, seed.repoId, seed.remotePath)
    return {
      taskId: `mock-task-${String(index + 1).padStart(3, '0')}`,
      source: seed.source,
      repoId: seed.repoId,
      remotePath: seed.remotePath,
      fileName: seed.remotePath.split('/').pop() ?? seed.remotePath,
      savePath,
      tempPath: `${savePath}.part`,
      totalSize: seed.totalSize,
      downloaded: seed.downloaded,
      status: seed.status,
      speed: seed.speed,
      error: seed.error,
      retries: seed.retries ?? 0,
      revision: seed.revision ?? defaultRevisionFor(seed.source),
      addedAt: now - seed.addedMinutesAgo * 60_000,
      completedAt:
        seed.completedMinutesAgo != null ? now - seed.completedMinutesAgo * 60_000 : undefined,
      etag: `W/"mock-etag-${index + 1}"`,
      lastModified: new Date(now - seed.addedMinutesAgo * 60_000).toISOString(),
    } satisfies DownloadTask
  })
}

/**
 * ≥300 任务压力测试 fixture（仅 `?mock=1&bigtasks=1` 使用）：
 * 320 条历史任务（多数已完成 + 少量失败/暂停），用于验证下载列表已完成分组渲染上限。
 */
export function createStressTasks(settings: Settings): DownloadTask[] {
  const now = Date.now()
  const tasks: DownloadTask[] = []
  for (let index = 0; index < 320; index += 1) {
    const repoId = `stress-org/model-${String(index + 1).padStart(3, '0')}`
    const fileName = `model-${String(index + 1).padStart(5, '0')}-of-00320.safetensors`
    const savePath = mockFinalPath(settings.downloadDir, repoId, fileName)
    const totalSize = 1_000_000_000 + (index % 9) * 512_000_000
    // 每 37 条插入一个失败任务，其余为已完成；保证多种状态都存在。
    const failed = index % 37 === 36
    const paused = index % 53 === 52
    const source: DownloadTask['source'] = index % 3 === 0 ? 'modelscope' : 'huggingface'
    tasks.push({
      taskId: `mock-stress-${String(index + 1).padStart(4, '0')}`,
      source,
      repoId,
      remotePath: fileName,
      fileName,
      savePath,
      tempPath: `${savePath}.part`,
      totalSize,
      downloaded: failed || paused ? Math.round(totalSize * 0.42) : totalSize,
      status: failed ? 'error' : paused ? 'paused' : 'completed',
      speed: 0,
      error: failed ? '下载失败：HTTP 500 Internal Server Error（已重试 3 次）。' : undefined,
      retries: failed ? 3 : 0,
      revision: defaultRevisionFor(source),
      addedAt: now - (index + 1) * 7 * 60_000,
      completedAt: failed || paused ? undefined : now - (index + 1) * 6 * 60_000,
    })
  }
  return tasks
}

/* ------------------------------------------------------------------ */
/* 本地模型库 fixture（对齐用户真实历史模型目录结构）                   */
/* ------------------------------------------------------------------ */

interface LibraryFileSpec {
  name: string
  size: number
}

interface LibraryDirSeed {
  dir: string
  repoId?: string
  source?: LocalFile['source']
  baseMinutesAgo: number
  stepMinutes: number
  files: LibraryFileSpec[]
}

/**
 * 模拟用户已有历史模型目录（约 127 个文件）：
 * - unsloth/flint-GGUF/*.gguf + assets 子目录（含 mmproj / imatrix / .hgn 样例）
 * - Qwen / deepseek / BAAI / whisper 等下载历史模型（带 source/repoId）
 * - DemoLibrary/Nova/models/x/... 多层深层目录
 * - 根目录散落文件
 */
const LIBRARY_SEEDS: LibraryDirSeed[] = [
  {
    dir: 'unsloth/flint-GGUF',
    baseMinutesAgo: 20,
    stepMinutes: 13,
    files: [
      { name: 'flint-UD-Q6_K_XL.gguf', size: 13_420_000_000 },
      { name: 'flint-UD-Q5_K_XL.gguf', size: 10_980_000_000 },
      { name: 'flint-UD-Q4_K_XL.gguf', size: 9_360_000_000 },
      { name: 'flint-Q8_0.gguf', size: 21_750_000_000 },
      { name: 'flint-UD-Q2_K_XL.gguf', size: 6_940_000_000 },
      { name: 'flint-IQ4_XS.gguf', size: 7_210_000_000 },
      { name: 'flint-BF16.gguf', size: 34_800_000_000 },
      { name: 'imatrix_unsloth.gguf_file', size: 1_240_000 },
      { name: 'mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf', size: 1_340_000_000 },
      { name: 'clip_vision_model.safetensors', size: 830_000_000 },
      { name: 'qwen38-flash-next-mtp.hgn', size: 2_400_000_000 },
      { name: 'configuration.json', size: 1_860 },
      { name: 'tokenizer_config.json', size: 2_400 },
      { name: 'chat_template.jinja', size: 1_600 },
      { name: 'README.md', size: 18_600 },
      { name: 'assets/logo.png', size: 84_000 },
      { name: 'assets/architecture.png', size: 412_000 },
      { name: 'assets/demo.gif', size: 2_800_000 },
      { name: 'assets/benchmark.png', size: 168_000 },
    ],
  },
  {
    dir: 'Qwen/Qwen2.5-0.5B-Instruct',
    repoId: 'Qwen/Qwen2.5-0.5B-Instruct',
    source: 'huggingface',
    baseMinutesAgo: 1_440,
    stepMinutes: 30,
    files: [
      { name: 'model.safetensors', size: 988_100_000 },
      { name: 'config.json', size: 1_200 },
      { name: 'tokenizer.json', size: 1_804_000 },
      { name: 'tokenizer_config.json', size: 12_400 },
      { name: 'vocab.json', size: 1_210_000 },
      { name: 'merges.txt', size: 1_090_000 },
      { name: 'README.md', size: 14_200 },
      { name: 'figures/architecture.png', size: 240_000 },
    ],
  },
  {
    dir: 'Qwen/Qwen2.5-7B-Instruct',
    repoId: 'Qwen/Qwen2.5-7B-Instruct',
    source: 'huggingface',
    baseMinutesAgo: 60,
    stepMinutes: 45,
    files: [
      { name: 'model-00001-of-00004.safetensors', size: 3_970_000_000 },
      { name: 'model-00002-of-00004.safetensors', size: 3_970_000_000 },
      { name: 'model-00003-of-00004.safetensors', size: 3_970_000_000 },
      { name: 'model-00004-of-00004.safetensors', size: 3_970_000_000 },
      { name: 'model.safetensors.index.json', size: 52_000 },
      { name: 'config.json', size: 1_300 },
      { name: 'generation_config.json', size: 900 },
      { name: 'tokenizer.json', size: 1_804_000 },
      { name: 'tokenizer_config.json', size: 12_400 },
      { name: 'vocab.json', size: 1_210_000 },
      { name: 'merges.txt', size: 1_090_000 },
      { name: 'chat_template.jinja', size: 3_900 },
      { name: 'README.md', size: 21_000 },
    ],
  },
  {
    dir: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    baseMinutesAgo: 1_800,
    stepMinutes: 20,
    files: [
      { name: 'model-00001-of-00002.safetensors', size: 3_910_000_000 },
      { name: 'model-00002-of-00002.safetensors', size: 3_910_000_000 },
      { name: 'model.safetensors.index.json', size: 38_000 },
      { name: 'config.json', size: 1_400 },
      { name: 'generation_config.json', size: 800 },
      { name: 'tokenizer.json', size: 1_804_000 },
      { name: 'tokenizer_config.json', size: 10_200 },
      { name: '.gitattributes', size: 1_500 },
      { name: 'README.md', size: 16_800 },
    ],
  },
  {
    dir: 'BAAI/bge-m3',
    repoId: 'BAAI/bge-m3',
    source: 'huggingface',
    baseMinutesAgo: 2_900,
    stepMinutes: 15,
    files: [
      { name: 'pytorch_model.bin', size: 2_271_000_000 },
      { name: 'config.json', size: 1_100 },
      { name: 'tokenizer.json', size: 17_100_000 },
      { name: 'tokenizer_config.json', size: 4_800 },
      { name: 'sentence_bert_config.json', size: 260 },
      { name: 'special_tokens_map.json', size: 600 },
      { name: 'README.md', size: 12_400 },
    ],
  },
  {
    dir: 'sentence-transformers/all-MiniLM-L6-v2',
    repoId: 'sentence-transformers/all-MiniLM-L6-v2',
    source: 'huggingface',
    baseMinutesAgo: 4_320,
    stepMinutes: 25,
    files: [
      { name: 'model.safetensors', size: 90_900_000 },
      { name: 'config.json', size: 612 },
      { name: 'tokenizer.json', size: 2_200_000 },
      { name: 'tokenizer_config.json', size: 1_100 },
      { name: 'vocab.txt', size: 232_000 },
      { name: 'README.md', size: 9_800 },
    ],
  },
  {
    dir: 'openai/whisper-large-v3',
    repoId: 'openai/whisper-large-v3',
    source: 'huggingface',
    baseMinutesAgo: 120,
    stepMinutes: 40,
    files: [
      { name: 'model.safetensors', size: 3_090_000_000 },
      { name: 'config.json', size: 1_900 },
      { name: 'generation_config.json', size: 3_600 },
      { name: 'preprocessor_config.json', size: 1_850 },
      { name: 'tokenizer.json', size: 2_480_000 },
      { name: 'tokenizer_config.json', size: 4_600 },
      { name: 'vocab.json', size: 1_036_000 },
      { name: 'README.md', size: 15_000 },
    ],
  },
  {
    dir: 'unsloth/Qwen3-4B-GGUF',
    baseMinutesAgo: 720,
    stepMinutes: 35,
    files: [
      { name: 'Qwen3-4B-UD-Q8_0.gguf', size: 4_320_000_000 },
      { name: 'Qwen3-4B-UD-Q6_K.gguf', size: 3_180_000_000 },
      { name: 'Qwen3-4B-UD-Q5_K_M.gguf', size: 2_760_000_000 },
      { name: 'Qwen3-4B-UD-Q4_K_M.gguf', size: 2_480_000_000 },
      { name: 'Qwen3-4B-UD-Q2_K.gguf', size: 1_720_000_000 },
      { name: 'config.json', size: 980 },
      { name: 'tokenizer_config.json', size: 2_100 },
      { name: 'README.md', size: 13_400 },
    ],
  },
  {
    dir: 'DemoLibrary',
    baseMinutesAgo: 70,
    stepMinutes: 60,
    files: [{ name: 'README.md', size: 8_200 }],
  },
  {
    dir: 'DemoLibrary/Nova/configs',
    baseMinutesAgo: 90,
    stepMinutes: 60,
    files: [
      { name: 'inference.yaml', size: 3_400 },
      { name: 'serving.toml', size: 2_100 },
    ],
  },
  {
    dir: 'DemoLibrary/Nova/assets',
    baseMinutesAgo: 95,
    stepMinutes: 60,
    files: [
      { name: 'logo.png', size: 96_000 },
      { name: 'cover.jpg', size: 184_000 },
    ],
  },
  {
    dir: 'DemoLibrary/models',
    baseMinutesAgo: 110,
    stepMinutes: 60,
    files: [
      { name: 'model-index.json', size: 42_000 },
      { name: 'catalog.json', size: 128_000 },
    ],
  },
  {
    dir: 'DemoLibrary/Nova/models/x',
    baseMinutesAgo: 240,
    stepMinutes: 60,
    files: [{ name: 'README.md', size: 3_200 }],
  },
  {
    dir: 'DemoLibrary/Nova/models/x/2025-06/final',
    baseMinutesAgo: 260,
    stepMinutes: 60,
    files: [
      { name: 'config.json', size: 2_400 },
      { name: 'model-00001-of-00002.safetensors', size: 9_980_000_000 },
      { name: 'model-00002-of-00002.safetensors', size: 9_980_000_000 },
      { name: 'tokenizer.json', size: 3_200_000 },
      { name: 'README.md', size: 11_000 },
    ],
  },
  {
    dir: 'DemoLibrary/Nova/models/x/2025-09/final',
    baseMinutesAgo: 300,
    stepMinutes: 60,
    files: [
      { name: 'config.json', size: 2_600 },
      { name: 'model.safetensors', size: 19_960_000_000 },
      { name: 'tokenizer.json', size: 3_200_000 },
    ],
  },
  {
    dir: 'DemoLibrary/Nova/models/x/checkpoints/step-12000',
    baseMinutesAgo: 340,
    stepMinutes: 60,
    files: [
      { name: 'model.safetensors', size: 19_960_000_000 },
      { name: 'optimizer.pt', size: 39_900_000_000 },
      { name: 'trainer_state.json', size: 76_000 },
      { name: 'README.md', size: 6_400 },
    ],
  },
  {
    dir: '',
    baseMinutesAgo: 2_600,
    stepMinutes: 120,
    files: [
      { name: 'README.txt', size: 2_400 },
      { name: 'model-catalog.json', size: 96_000 },
      { name: 'notes.md', size: 8_800 },
      { name: 'legacy-model-Q4_K_M.gguf', size: 4_100_000_000 },
      { name: 'download.log', size: 1_280_000 },
      { name: 'settings-backup.json', size: 8_900 },
    ],
  },
  {
    dir: 'microsoft/Phi-3-mini-4k-instruct',
    baseMinutesAgo: 3_000,
    stepMinutes: 30,
    files: [
      { name: 'model-00001-of-00002.safetensors', size: 2_380_000_000 },
      { name: 'model-00002-of-00002.safetensors', size: 2_380_000_000 },
      { name: 'config.json', size: 2_100 },
      { name: 'tokenizer.json', size: 1_900_000 },
      { name: 'generation_config.json', size: 800 },
      { name: 'README.md', size: 12_000 },
    ],
  },
  {
    dir: 'iic/CosyVoice2-0.5B',
    repoId: 'iic/CosyVoice2-0.5B',
    source: 'modelscope',
    baseMinutesAgo: 7_200,
    stepMinutes: 20,
    files: [
      { name: 'llm.pt', size: 1_020_000_000 },
      { name: 'flow.pt', size: 310_000_000 },
      { name: 'hift.pt', size: 210_000_000 },
      { name: 'configuration.json', size: 1_900 },
      { name: 'tokens.json', size: 128_000 },
      { name: 'README.md', size: 7_600 },
    ],
  },
  {
    dir: 'stabilityai/stable-diffusion-xl-base-1.0',
    baseMinutesAgo: 5_200,
    stepMinutes: 25,
    files: [
      { name: 'unet/diffusion_pytorch_model.safetensors', size: 5_140_000_000 },
      { name: 'vae/diffusion_pytorch_model.safetensors', size: 335_000_000 },
      { name: 'text_encoder/model.safetensors', size: 492_000_000 },
      { name: 'text_encoder_2/model.safetensors', size: 1_390_000_000 },
      { name: 'model_index.json', size: 1_800 },
      { name: 'README.md', size: 18_000 },
    ],
  },
  {
    dir: 'nvidia/parakeet-tdt-0.6b-v2',
    baseMinutesAgo: 9_000,
    stepMinutes: 20,
    files: [
      { name: 'encoder.onnx', size: 1_240_000_000 },
      { name: 'decoder.onnx', size: 980_000_000 },
      { name: 'config.json', size: 1_400 },
      { name: 'tokenizer.json', size: 1_100_000 },
      { name: 'README.md', size: 8_400 },
    ],
  },
]

function librarySeedPath(
  settings: Settings,
  seed: LibraryDirSeed,
  file: LibraryFileSpec,
): string {
  const base = settings.downloadDir.replace(/[\\/]+$/, '')
  if (!seed.dir) return `${base}\\${file.name.replace(/\//g, '\\')}`
  return mockFinalPath(settings.downloadDir, seed.dir, file.name)
}

export function createMockLibrary(settings: Settings): LocalFile[] {
  const now = Date.now()
  const entries: LocalFile[] = []
  const rootDir = settings.downloadDir.replace(/[\\/]+$/, '')
  for (const seed of LIBRARY_SEEDS) {
    seed.files.forEach((file, index) => {
      const path = librarySeedPath(settings, seed, file)
      entries.push({
        path,
        name: path.split('\\').pop() ?? path,
        size: file.size,
        modifiedAt: now - (seed.baseMinutesAgo + index * seed.stepMinutes) * 60_000,
        source: seed.source,
        repoId: seed.repoId,
        kind: classifyRepoPath(path),
        rootDir,
      })
    })
  }
  return entries.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

interface MultiRootSeed {
  root: string
  dir: string
  repoId?: string
  source?: LocalFile['source']
  baseMinutesAgo: number
  files: LibraryFileSpec[]
}

/** v0.2.0：附加扫描根目录的 mock 文件（仅在 ?mock=1&multiroot=1 时并入扫描结果）。 */
const MULTI_ROOT_SEEDS: MultiRootSeed[] = [
  {
    root: MOCK_LIBRARY_ROOT_2,
    dir: 'research/llama-finetune',
    repoId: 'meta-llama/Llama-3.1-8B-Instruct',
    source: 'huggingface',
    baseMinutesAgo: 90,
    files: [
      { name: 'model.safetensors', size: 4_920_000_000 },
      { name: 'config.json', size: 1_500 },
      { name: 'tokenizer.json', size: 1_804_000 },
      { name: 'README.md', size: 12_400 },
    ],
  },
  {
    root: MOCK_LIBRARY_ROOT_2,
    dir: 'research/embedding-bench',
    baseMinutesAgo: 260,
    files: [
      { name: 'bge-m3-onnx/model.onnx', size: 2_271_000_000 },
      { name: 'bge-m3-onnx/tokenizer.json', size: 17_100_000 },
      { name: 'bench-report.md', size: 24_000 },
    ],
  },
  {
    root: MOCK_LIBRARY_ROOT_3,
    dir: 'gguf/llama-3.2',
    baseMinutesAgo: 480,
    files: [
      { name: 'Llama-3.2-3B-Instruct-Q8_0.gguf', size: 3_420_000_000 },
      { name: 'mmproj-Llama-3.2-3B-f16.gguf', size: 680_000_000 },
      { name: 'imatrix_llama32.gguf_file', size: 1_180_000 },
    ],
  },
  {
    root: MOCK_LIBRARY_ROOT_3,
    dir: '',
    baseMinutesAgo: 1_200,
    files: [
      { name: 'README.txt', size: 1_800 },
      { name: 'llm-cache-index.json', size: 36_000 },
    ],
  },
]

export function createMultiRootLibrary(_settings: Settings): LocalFile[] {
  const now = Date.now()
  const entries: LocalFile[] = []
  for (const seed of MULTI_ROOT_SEEDS) {
    const rootDir = seed.root.replace(/[\\/]+$/, '')
    for (const file of seed.files) {
      const path = seed.dir
        ? mockFinalPath(rootDir, seed.dir, file.name)
        : `${rootDir}\\${file.name.replace(/\//g, '\\')}`
      entries.push({
        path,
        name: path.split('\\').pop() ?? path,
        size: file.size,
        modifiedAt: now - seed.baseMinutesAgo * 60_000,
        source: seed.source,
        repoId: seed.repoId,
        kind: classifyRepoPath(path),
        rootDir,
      })
    }
  }
  return entries.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/**
 * ≥500 文件压力测试 fixture（仅 `?mock=1&biglibrary=1` 使用）：
 * 12 个分片目录 × 42 个权重文件 + 配置文件 = 516 个文件。
 * 用于验证窗口化渲染与展开/折叠性能。
 */
export function createStressLibrary(settings: Settings): LocalFile[] {
  const now = Date.now()
  const base = settings.downloadDir.replace(/[\\/]+$/, '')
  const files: LocalFile[] = []
  for (let shard = 1; shard <= 12; shard += 1) {
    const dir = `stress-test/bench-${String(shard).padStart(2, '0')}`
    const dirPath = `${base}\\${dir.replace(/\//g, '\\')}`
    for (let index = 1; index <= 42; index += 1) {
      const name = `model-${String(index).padStart(5, '0')}-of-00042.safetensors`
      files.push({
        path: `${dirPath}\\${name}`,
        name,
        size: 1_200_000_000 + index * 37_000_000,
        modifiedAt: now - (index + shard * 10) * 60_000,
        kind: 'weight',
        rootDir: base,
      })
    }
    files.push({
      path: `${dirPath}\\config.json`,
      name: 'config.json',
      size: 1_200,
      modifiedAt: now - shard * 60_000,
      kind: 'config',
      rootDir: base,
    })
  }
  return files
}
