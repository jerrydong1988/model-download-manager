/**
 * 从 HuggingFace / ModelScope 页面或文件链接解析仓库。
 * 能识别时直接打开仓库；blob / resolve / file view 再预选对应文件。
 */
import type { Source } from '../types'

const HF_HOSTS = new Set([
  'huggingface.co',
  'www.huggingface.co',
  'hf-mirror.com',
  'www.hf-mirror.com',
])

const MS_HOSTS = new Set(['modelscope.cn', 'www.modelscope.cn'])

const HF_NON_REPO = new Set(['datasets', 'spaces', 'docs', 'blog', 'posts', 'collections', 'models'])

export interface ParsedRepoLink {
  source: Source
  repoId: string
  revision?: string
  filePath?: string
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function pathParts(input: string): { host: string; parts: string[] } | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  return {
    host: url.hostname.toLowerCase(),
    parts: url.pathname.split('/').filter(Boolean).map(decodeSegment),
  }
}

function repoIdOf(org: string, name: string): string | null {
  if (!org || !name || /\s/.test(org) || /\s/.test(name)) return null
  return `${org}/${name}`
}

function parseHuggingFace(parts: string[]): ParsedRepoLink | null {
  if (parts.length < 2 || HF_NON_REPO.has(parts[0])) return null
  const repoId = repoIdOf(parts[0], parts[1])
  if (!repoId) return null
  const kind = parts[2]
  if (kind !== 'tree' && kind !== 'blob' && kind !== 'resolve') {
    return { source: 'huggingface', repoId }
  }
  const revision = parts[3]
  if (!revision) return { source: 'huggingface', repoId }
  const filePath = parts.slice(4).join('/')
  if ((kind === 'blob' || kind === 'resolve') && filePath) {
    return { source: 'huggingface', repoId, revision, filePath }
  }
  return { source: 'huggingface', repoId, revision }
}

function parseModelScope(parts: string[]): ParsedRepoLink | null {
  if (parts[0] !== 'models' || parts.length < 3) return null
  const repoId = repoIdOf(parts[1], parts[2])
  if (!repoId) return null
  const section = parts[3]
  if (!section || section === 'files' || section === 'summary' || section === 'feedback') {
    return { source: 'modelscope', repoId }
  }
  if (section === 'file' && parts[4] === 'view' && parts[5]) {
    const filePath = parts.slice(6).join('/')
    return {
      source: 'modelscope',
      repoId,
      revision: parts[5],
      filePath: filePath || undefined,
    }
  }
  if ((section === 'resolve' || section === 'blob') && parts[4]) {
    const filePath = parts.slice(5).join('/')
    return {
      source: 'modelscope',
      repoId,
      revision: parts[4],
      filePath: filePath || undefined,
    }
  }
  return { source: 'modelscope', repoId }
}

/** 解析仓库页、blob、resolve 链接。不是这两家的地址时返回 null。 */
export function parseRepoLink(input: string): ParsedRepoLink | null {
  if (!looksLikeUrl(input)) return null
  const parsed = pathParts(input)
  if (!parsed) return null
  if (HF_HOSTS.has(parsed.host)) return parseHuggingFace(parsed.parts)
  if (MS_HOSTS.has(parsed.host)) return parseModelScope(parsed.parts)
  return null
}
