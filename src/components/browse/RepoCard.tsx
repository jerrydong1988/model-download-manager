import {
  ArrowRight,
  Boxes,
  CalendarDays,
  Download,
  Heart,
  ShieldAlert,
} from 'lucide-react'
import type { RepoSummary } from '../../types'
import { formatCount, formatIsoDate } from '../../lib/format'
import { pipelineTagLabel } from '../../lib/labels'
import { SourceBadge } from '../ui/Badge'
import { SOURCE_STYLE } from '../../lib/labels'
import { cx } from '../../lib/cx'

export interface RepoCardProps {
  repo: RepoSummary
  onOpen: (repo: RepoSummary) => void
}

/** 搜索结果仓库卡片（整卡可点击，键盘可达；hover 仅变色不抬升）。 */
export function RepoCard({ repo, onOpen }: RepoCardProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(repo)}
      aria-label={`打开仓库 ${repo.id}`}
      className="group flex h-full w-full cursor-pointer flex-col rounded-card border border-line bg-surface p-4 text-left transition-colors duration-micro hover:border-primary/40 hover:bg-surface-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <div className="flex items-start gap-2.5">
        <div
          className={cx(
            'grid h-9 w-9 shrink-0 place-items-center rounded-control',
            SOURCE_STYLE[repo.source].icon,
          )}
        >
          <Boxes className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <p
              className="line-clamp-2 text-body font-semibold leading-5 text-fg transition-colors duration-micro group-hover:text-primary"
              title={repo.id}
            >
              {repo.id}
            </p>
            {repo.gated ? (
              <span
                className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded-control border border-amber-200 bg-amber-50 px-1 py-0.5 text-meta font-medium leading-4 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300"
                title="需要授权：需在设置中配置 Token 并同意许可协议"
              >
                <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                需授权
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <SourceBadge source={repo.source} />
            {repo.pipelineTag ? (
              <span className="truncate rounded-control border border-line bg-surface-2 px-1.5 py-0.5 text-meta leading-4 text-fg-secondary">
                {pipelineTagLabel(repo.pipelineTag)}
              </span>
            ) : null}
          </div>
        </div>
        <ArrowRight
          className="mt-1 h-4 w-4 shrink-0 text-fg-muted transition-colors duration-micro group-hover:text-primary"
          aria-hidden="true"
        />
      </div>

      <div className="mt-3 flex items-center gap-4 text-meta text-fg-secondary">
        <span className="inline-flex items-center gap-1" title={`${repo.downloads} 次下载`}>
          <Download className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
          {formatCount(repo.downloads)}
        </span>
        <span className="inline-flex items-center gap-1" title={`${repo.likes} 个赞`}>
          <Heart className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
          {formatCount(repo.likes)}
        </span>
        {repo.lastModified ? (
          <span className="ml-auto inline-flex items-center gap-1 text-meta text-fg-muted">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            {formatIsoDate(repo.lastModified)}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {repo.tags.slice(0, 4).map((tag) => (
          <span
            key={tag}
            className="truncate rounded-control border border-line bg-surface-2 px-1.5 py-0.5 text-meta leading-4 text-fg-secondary"
          >
            {tag}
          </span>
        ))}
        {repo.tags.length > 4 ? (
          <span className="rounded-control px-1 py-0.5 text-meta leading-4 text-fg-muted">
            +{repo.tags.length - 4}
          </span>
        ) : null}
      </div>
    </button>
  )
}
