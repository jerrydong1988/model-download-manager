/**
 * 仓库文件的量化档与分片组。
 *
 * 多个量化档不再默认全选；分片按 `名称-序号-of-总数` 成组，一组必须一起选。
 */
import type { RepoFile } from '../types'

const QUANT_SOURCE =
  '(?:^|[^A-Za-z0-9])((?:IQ|Q)\\d+(?:_[A-Za-z0-9]+)*|BF16|FP16|FP32|F16|F32|FP8|INT8|INT4)(?=$|[^A-Za-z0-9])'

const SHARD_PATTERN = /^(.*?)-(\d+)-of-(\d+)(\.[^.]+)$/i

/** 本地推理常用档位，靠前的优先作为默认选择。 */
const QUANT_PREFERENCE = [
  'Q4_K_M',
  'Q5_K_M',
  'Q6_K',
  'Q4_K_S',
  'Q8_0',
  'Q5_K_S',
  'Q5_0',
  'Q4_0',
  'Q3_K_M',
  'Q3_K_L',
  'Q3_K_S',
  'IQ4_XS',
  'IQ4_NL',
  'Q2_K',
]

const FULL_PRECISION = new Set(['F32', 'F16', 'BF16', 'FP16', 'FP32'])

export interface QuantChoice {
  id: string
  bytes: number
  fileCount: number
}

export interface ShardChoice {
  id: string
  label: string
  total: number
  bytes: number
  fileCount: number
}

/** 文件名中的量化档，如 Q4_K_M、F16。取最后一次匹配，避免组织名里的数字干扰。 */
export function quantOf(name: string): string | null {
  const matches = [...name.matchAll(new RegExp(QUANT_SOURCE, 'gi'))]
  const last = matches.length > 0 ? matches[matches.length - 1][1] : undefined
  return last ? last.toUpperCase() : null
}

/** `model-00001-of-00004.safetensors` → 同一组分片。总数小于 2 的不视为分片。 */
export function shardOf(path: string): { groupId: string; label: string; index: number; total: number } | null {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const base = slash >= 0 ? path.slice(slash + 1) : path
  const match = SHARD_PATTERN.exec(base)
  if (!match) return null
  const stem = match[1]
  const index = Number(match[2])
  const total = Number(match[3])
  const ext = match[4]
  if (!stem || !Number.isInteger(index) || !Number.isInteger(total) || total < 2 || index < 1 || index > total) {
    return null
  }
  return {
    groupId: `${dir}${stem}${ext}`.toLowerCase(),
    label: `${stem}${ext}`,
    index,
    total,
  }
}

function weightQuants(files: RepoFile[]): string[] {
  const ids = new Set<string>()
  for (const file of files) {
    if (file.kind !== 'weight') continue
    const quant = quantOf(file.name)
    if (quant) ids.add(quant)
  }
  return [...ids]
}

function quantRank(id: string): number {
  const preferred = QUANT_PREFERENCE.indexOf(id)
  if (preferred >= 0) return preferred
  if (FULL_PRECISION.has(id)) return 10_000
  return 1_000
}

/** 权重量化档，按推荐顺序排列。 */
export function quantChoices(files: RepoFile[]): QuantChoice[] {
  const ids = weightQuants(files).sort((a, b) => quantRank(a) - quantRank(b) || a.localeCompare(b))
  return ids.map((id) => {
    const matched = files.filter((file) => file.kind === 'weight' && quantOf(file.name) === id)
    return {
      id,
      bytes: matched.reduce((sum, file) => sum + file.size, 0),
      fileCount: matched.length,
    }
  })
}

/** 至少两片的分片组。 */
export function shardChoices(files: RepoFile[]): ShardChoice[] {
  const groups = new Map<string, ShardChoice>()
  for (const file of files) {
    const shard = shardOf(file.path)
    if (!shard) continue
    const current = groups.get(shard.groupId)
    if (current) {
      current.bytes += file.size
      current.fileCount += 1
      current.total = Math.max(current.total, shard.total)
    } else {
      groups.set(shard.groupId, {
        id: shard.groupId,
        label: shard.label,
        total: shard.total,
        bytes: file.size,
        fileCount: 1,
      })
    }
  }
  return [...groups.values()]
    .filter((group) => group.fileCount >= 2 || group.total >= 2)
    .sort((a, b) => a.label.localeCompare(b.label))
}

function companionMmproj(files: RepoFile[], quant: string | null): RepoFile[] {
  const projectors = files.filter((file) => file.kind === 'mmproj')
  if (projectors.length === 0) return []
  if (quant) {
    const same = projectors.filter((file) => quantOf(file.name) === quant)
    if (same.length > 0) return same
  }
  const generic = projectors.filter((file) => {
    const id = quantOf(file.name)
    return id == null || id === 'F16' || id === 'BF16' || id === 'FP16'
  })
  if (generic.length > 0) return generic
  const distinct = new Set(projectors.map((file) => quantOf(file.name) ?? ''))
  if (distinct.size === 1) return projectors
  return []
}

function uniquePaths(files: RepoFile[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const file of files) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    paths.push(file.path)
  }
  return paths
}

/** 某一量化档的权重，加上配套投影器。 */
export function pathsForQuant(
  files: RepoFile[],
  quantId: string,
  occupied: (file: RepoFile) => boolean = () => false,
): string[] {
  const weights = files.filter(
    (file) => file.kind === 'weight' && quantOf(file.name) === quantId && !occupied(file),
  )
  const projectors = companionMmproj(files, quantId).filter((file) => !occupied(file))
  return uniquePaths([...weights, ...projectors])
}

/** 某一分片组的全部文件。 */
export function pathsForShard(
  files: RepoFile[],
  groupId: string,
  occupied: (file: RepoFile) => boolean = () => false,
): string[] {
  return files
    .filter((file) => shardOf(file.path)?.groupId === groupId && !occupied(file))
    .map((file) => file.path)
}

function pickQuant(files: RepoFile[], occupied: (file: RepoFile) => boolean): string | null {
  const available = quantChoices(files).filter((choice) =>
    files.some((file) => file.kind === 'weight' && quantOf(file.name) === choice.id && !occupied(file)),
  )
  return available[0]?.id ?? null
}

/**
 * 默认勾选。
 * 只有一个量化档（或没有）时，仍勾选全部权重和投影器。
 * 有多个量化档时，只勾选推荐档及其全部分片，再加配套投影器。
 */
export function defaultSelectedPaths(
  files: RepoFile[],
  occupied: (file: RepoFile) => boolean = () => false,
): string[] {
  if (weightQuants(files).length > 1) {
    const quant = pickQuant(files, occupied)
    if (!quant) return []
    return pathsForQuant(files, quant, occupied)
  }
  return files
    .filter((file) => (file.kind === 'weight' || file.kind === 'mmproj') && !occupied(file))
    .map((file) => file.path)
}

export function samePathSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((path, index) => path === b[index])
}
