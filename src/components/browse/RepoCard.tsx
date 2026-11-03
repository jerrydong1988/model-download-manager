import { ArrowRight, Download, Heart, ShieldAlert } from 'lucide-react'
import type { RepoSummary } from '../../types'
import { formatCount, formatIsoDate } from '../../lib/format'
import { pipelineTagLabel } from '../../lib/labels'

export interface RepoCardProps { repo: RepoSummary; onOpen: (repo: RepoSummary) => void }

/** 目录行保留整行点击与键盘操作；完整仓库 ID 始终作为可访问名称。 */
export function RepoCard({ repo, onOpen }: RepoCardProps) {
  const split = repo.id.lastIndexOf('/')
  const owner = split < 0 ? '' : repo.id.slice(0, split)
  const name = split < 0 ? repo.id : repo.id.slice(split + 1)
  return (
    <button
      type="button"
      onClick={() => onOpen(repo)}
      aria-label={`打开仓库 ${repo.id}`}
      className="repo-columns group w-full border-b border-line px-3 py-5 text-left transition-colors duration-micro hover:bg-surface-2 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="line-clamp-2 break-words text-section text-fg group-hover:text-primary" title={repo.id}>{name}</span>
          {repo.gated ? <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-label="需要授权下载" /> : null}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-fg-muted">
          {owner ? <span className="font-medium text-fg-secondary">{owner}</span> : null}
          {repo.tags.length ? <span className="min-w-0 truncate" title={repo.tags.join(' · ')}>{repo.tags.slice(0, 3).join(' · ')}{repo.tags.length > 3 ? ` +${repo.tags.length - 3}` : ''}</span> : null}
          {repo.lastModified ? <span className="hidden xl:inline">· {formatIsoDate(repo.lastModified)}</span> : null}
        </span>
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-fg-muted lg:hidden">
          {repo.pipelineTag ? <span>{pipelineTagLabel(repo.pipelineTag)}</span> : null}
          <span>{formatCount(repo.downloads)} 下载</span><span>{formatCount(repo.likes)} 点赞</span>
        </span>
      </span>
      <span className="hidden text-secondary text-fg-secondary lg:block">{repo.pipelineTag ? pipelineTagLabel(repo.pipelineTag) : '—'}</span>
      <span className="hidden space-y-1 text-secondary tabular-nums lg:block">
        <span className="flex items-center gap-1.5 text-fg-secondary" title={`${repo.downloads} 次下载`}><Download className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />{formatCount(repo.downloads)}</span>
        <span className="flex items-center gap-1.5 text-meta text-fg-muted" title={`${repo.likes} 个赞`}><Heart className="h-3 w-3" aria-hidden="true" />{formatCount(repo.likes)}</span>
      </span>
      <span className="flex items-center justify-end gap-2 text-secondary font-medium text-primary">
        <span className="hidden sm:inline">查看文件</span><ArrowRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </button>
  )
}
