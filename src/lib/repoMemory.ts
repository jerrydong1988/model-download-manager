import type { Source } from '../types'

export interface RememberedRepo {
  source: Source
  repoId: string
  revision?: string
  at: number
}

const RECENT_KEY = 'mdm.recentRepos.v1'
const FAVORITE_KEY = 'mdm.favoriteRepos.v1'
const MAX_RECENT = 8

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function sameRepo(left: RememberedRepo, right: Pick<RememberedRepo, 'source' | 'repoId'>): boolean {
  return left.source === right.source && left.repoId === right.repoId
}

function readList(key: string): RememberedRepo[] {
  const store = storage()
  if (!store) return []
  try {
    const parsed = JSON.parse(store.getItem(key) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRememberedRepo)
  } catch {
    return []
  }
}

function isRememberedRepo(value: unknown): value is RememberedRepo {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<RememberedRepo>
  return (
    (item.source === 'huggingface' || item.source === 'modelscope') &&
    typeof item.repoId === 'string' &&
    item.repoId.includes('/') &&
    typeof item.at === 'number'
  )
}

export function readRecentRepos(): RememberedRepo[] {
  return readList(RECENT_KEY)
}

export function readFavoriteRepos(): RememberedRepo[] {
  return readList(FAVORITE_KEY)
}

export function rememberRepo(
  current: RememberedRepo[],
  repo: Pick<RememberedRepo, 'source' | 'repoId' | 'revision'>,
  at = Date.now(),
): RememberedRepo[] {
  const next = [
    { source: repo.source, repoId: repo.repoId, revision: repo.revision, at },
    ...current.filter((item) => !sameRepo(item, repo)),
  ]
  return next.slice(0, MAX_RECENT)
}

export function toggleFavorite(
  current: RememberedRepo[],
  repo: Pick<RememberedRepo, 'source' | 'repoId' | 'revision'>,
  at = Date.now(),
): RememberedRepo[] {
  if (current.some((item) => sameRepo(item, repo))) {
    return current.filter((item) => !sameRepo(item, repo))
  }
  return [{ source: repo.source, repoId: repo.repoId, revision: repo.revision, at }, ...current]
}

export function isFavorite(
  current: RememberedRepo[],
  repo: Pick<RememberedRepo, 'source' | 'repoId'>,
): boolean {
  return current.some((item) => sameRepo(item, repo))
}

export function saveRecentRepos(repos: RememberedRepo[]): void {
  storage()?.setItem(RECENT_KEY, JSON.stringify(repos))
}

export function saveFavoriteRepos(repos: RememberedRepo[]): void {
  storage()?.setItem(FAVORITE_KEY, JSON.stringify(repos))
}
