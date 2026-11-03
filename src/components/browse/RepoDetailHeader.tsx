import { useMemo, type ReactNode } from 'react'
import {
  CalendarDays,
  ChevronDown,
  Download,
  Heart,
  ShieldAlert,
} from 'lucide-react'
import type { RepoDetail, RepoFile, Source } from '../../types'
import { formatBytes, formatCount, formatIsoDate } from '../../lib/format'
import { SOURCE_LABEL } from '../../lib/labels'
import { Badge, FileKindBadge, SourceBadge } from '../ui/Badge'
import { PathText } from '../ui/PathText'
import { cx } from '../../lib/cx'

export interface RepoDetailHeaderProps {
  detail: RepoDetail
  source: Source
  /** v0.2.0：revision 选择器（由页面注入，避免组件依赖 IPC） */
  revisionSelector?: ReactNode
}

/** 仓库详情页头部：仓库信息 + 文件统计。 */
export function RepoDetailHeader({ detail, source, revisionSelector }: RepoDetailHeaderProps) {
  const { weightCount, mmprojCount } = useMemo(() => {
    let weight = 0
    let mmproj = 0
    for (const file of detail.files) {
      if (file.kind === 'weight') weight += 1
      else if (file.kind === 'mmproj') mmproj += 1
    }
    return { weightCount: weight, mmprojCount: mmproj }
  }, [detail.files])
  const gated = Boolean(detail.gated)

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="break-all text-page text-fg">{detail.id}</h2>
        <p className="mt-1 text-secondary text-fg-secondary">
          共 {detail.files.length} 个文件 · 权重 {weightCount}
          {mmprojCount > 0 ? ` · 投影器 ${mmprojCount}` : ''}
          {' · '}{formatBytes(detail.totalSize)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source={source} />
        {revisionSelector}
        {gated ? (
          <Badge tone="amber">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            需授权下载
          </Badge>
        ) : (
          <Badge tone="emerald">公开仓库</Badge>
        )}
        {detail.license ? <Badge tone="violet">{detail.license}</Badge> : null}
        {!revisionSelector ? <Badge tone="slate">revision: {detail.revision}</Badge> : null}
      </div>

      <details className="text-meta text-fg-secondary">
        <summary className="w-fit cursor-pointer rounded-control text-fg-muted hover:text-primary">仓库信息</summary>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="inline-flex items-center gap-1.5">
          <Download className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
          下载{' '}
          <span className="font-medium tabular-nums text-fg">{formatCount(detail.downloads)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Heart className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
          点赞{' '}
          <span className="font-medium tabular-nums text-fg">{formatCount(detail.likes)}</span>
        </span>
        {detail.lastModified ? (
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
            更新于 {formatIsoDate(detail.lastModified)}
          </span>
        ) : null}
      </div>

      {detail.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {detail.tags.slice(0, 8).map((tag) => (
            <span key={tag} className="text-meta text-fg-muted">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      </details>

      {gated ? (
        <p className="flex items-start gap-1.5 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-meta leading-5 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          该仓库需要授权：请先在设置中填写 {SOURCE_LABEL[source]} Token，并在网页端同意许可协议。
        </p>
      ) : null}
    </div>
  )
}

export interface FileStateInfo {
  label: string
  tone: 'emerald' | 'blue' | 'amber' | 'red' | 'slate'
  disabled: boolean
}

export interface FileRowProps {
  file: RepoFile
  selected: boolean
  state: FileStateInfo | null
  onToggle: (path: string) => void
}

/** 表头和文件行共享列宽；文件行 48px，与虚拟列表的计算一致。 */
export const FILE_GRID =
  'grid grid-cols-[24px_minmax(0,1fr)_68px_88px_96px] items-center gap-3'

export function FileTableHeader({
  allSelected,
  someSelected,
  onToggleAll,
  selectableCount,
}: {
  allSelected: boolean
  someSelected: boolean
  onToggleAll: (checked: boolean) => void
  selectableCount: number
}) {
  const indeterminate = someSelected && !allSelected
  return (
    <div
      className={cx(
        FILE_GRID,
        'h-10 shrink-0 border-b border-line bg-surface-2 px-4 text-meta font-semibold text-fg-secondary',
      )}
    >
      <input
        type="checkbox"
        aria-label="全选当前筛选的可下载文件"
        checked={allSelected}
        disabled={selectableCount === 0}
        ref={(element) => {
          if (element) element.indeterminate = indeterminate
        }}
        onChange={(event) => onToggleAll(event.target.checked)}
        className="h-4 w-4 cursor-pointer rounded border-line-strong accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
      />
      <span>文件</span>
      <span>类型</span>
      <span className="text-right">大小</span>
      <span className="text-right">状态</span>
    </div>
  )
}

export function FileTableRow({ file, selected, state, onToggle }: FileRowProps) {
  const disabled = Boolean(state?.disabled)
  const checked = disabled ? false : selected
  const directory = file.path.includes('/')
    ? file.path.slice(0, file.path.lastIndexOf('/') + 1)
    : ''

  return (
    <div
      className={cx(
        FILE_GRID,
        'group h-12 border-b border-line px-4 transition-colors duration-micro last:border-b-0',
        disabled ? 'bg-surface-2/40' : checked ? 'bg-primary-soft' : 'hover:bg-surface-2',
      )}
    >
      <input
        type="checkbox"
        aria-label={`选择 ${file.path}`}
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle(file.path)}
        className="h-4 w-4 cursor-pointer rounded border-line-strong accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
      />
      <div className="min-w-0">
        {/* 长路径中间省略 + focus 显示完整 tooltip / 读屏全文（P1-5）。 */}
        <PathText
          path={file.path}
          label={file.name}
          copyable={false}
          className={disabled ? 'opacity-70' : undefined}
        />
        {directory ? (
          <p className="truncate text-meta leading-4 text-fg-muted" title={file.path}>
            {directory}
          </p>
        ) : null}
      </div>
      <span>
        <FileKindBadge kind={file.kind} />
      </span>
      <span className="text-right text-secondary tabular-nums text-fg-secondary">
        {file.size > 0 ? formatBytes(file.size) : '未知'}
      </span>
      <span className="flex justify-end">
        {state ? (
          <Badge tone={state.tone}>{state.label}</Badge>
        ) : (
          <span className="text-secondary text-fg-disabled">—</span>
        )}
      </span>
    </div>
  )
}

/** 文件分类筛选用的图标（供页面复用）。 */
export function ShardHint({ visible, total }: { visible: number; total: number }) {
  if (visible >= total) return null
  return (
    <span className="inline-flex items-center gap-1 text-meta text-fg-muted">
      <ChevronDown className="h-3 w-3" aria-hidden="true" />
      已筛选 {visible} / {total} 个文件
    </span>
  )
}
