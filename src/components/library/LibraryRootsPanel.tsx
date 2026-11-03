import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  FolderTree,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { formatBytes, formatRelativeTime } from '../../lib/format'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { PathText } from '../ui/PathText'
import { cx } from '../../lib/cx'

export interface LibraryRootEntry {
  /** 扫描根绝对路径 */
  rootDir: string
  /** 是否为固定下载目录（downloadDir） */
  isDownloadDir: boolean
  fileCount: number
  totalSize: number
  /** 递归最近修改时间（0 = 暂无文件） */
  latest: number
}

export interface LibraryRootsPanelProps {
  roots: LibraryRootEntry[]
  /** 是否正在扫描 */
  scanning: boolean
  /** 添加目录按钮 loading */
  adding: boolean
  onAdd: () => void
  onRemove: (rootDir: string) => void
  onOpen: (rootDir: string) => void
  onRescan: () => void
}

/**
 * 本地库「扫描根目录」管理区（v0.2.0）：
 * downloadDir 固定（不可移除）+ settings.libraryRoots 附加根（可增删）；
 * 每个根显示文件数/总大小/最近写入，并支持打开目录与重新扫描。
 */
export function LibraryRootsPanel({
  roots,
  scanning,
  adding,
  onAdd,
  onRemove,
  onOpen,
  onRescan,
}: LibraryRootsPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const totalFiles = roots.reduce((sum, root) => sum + root.fileCount, 0)
  const totalSize = roots.reduce((sum, root) => sum + root.totalSize, 0)

  return (
    <section
      className="shrink-0 bg-surface"
      aria-label="扫描根目录"
    >
      <header className="flex flex-wrap items-center gap-2 py-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls="library-roots-body"
          className="inline-flex cursor-pointer items-center gap-2 rounded-control px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
          )}
          <FolderTree className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="text-section text-fg">扫描根目录</span>
        </button>
        <span className="text-meta text-fg-muted">
          {roots.length} 个根 · {totalFiles} 个文件 · {formatBytes(totalSize)}
        </span>
        <span className="hidden text-meta text-fg-muted 2xl:inline">
          下载目录固定包含，可添加其他模型目录（最多 8 个附加根）
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={onAdd}
            loading={adding}
            leftIcon={<FolderPlus className="h-3.5 w-3.5" />}
          >
            添加模型目录
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRescan}
            loading={scanning}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            重新扫描
          </Button>
        </div>
      </header>

      {expanded ? (
        <div
          id="library-roots-body"
          className="max-h-40 divide-y divide-line overflow-y-auto border-b border-line"
        >
          {roots.map((root) => (
            <div
              key={root.rootDir.toLowerCase()}
              role="group"
              aria-label={`扫描根 ${root.rootDir}`}
              className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 py-3"
            >
              <div className="flex min-w-0 flex-1 basis-52 items-center gap-2">
                <FolderOpen
                  className={cx(
                    'h-4 w-4 shrink-0',
                    root.isDownloadDir ? 'text-primary' : 'text-fg-secondary',
                  )}
                  aria-hidden="true"
                />
                <PathText path={root.rootDir} copyable={false} className="min-w-0 flex-1" />
                <Badge tone={root.isDownloadDir ? 'blue' : 'slate'}>
                  {root.isDownloadDir ? '下载目录' : '模型目录'}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-fg-secondary">
                <span className="tabular-nums">
                  {root.fileCount} 个文件 · {formatBytes(root.totalSize)}
                </span>
                <span className="hidden text-fg-muted xl:inline">
                  {root.latest > 0
                    ? `最近写入 ${formatRelativeTime(root.latest)}`
                    : '暂无文件'}
                </span>
              </div>
              <div className="flex items-center justify-end gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpen(root.rootDir)}
                  leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
                >
                  打开目录
                </Button>
                <Button
                  size="xs"
                  variant="dangerGhost"
                  onClick={() => onRemove(root.rootDir)}
                  disabled={root.isDownloadDir}
                  title={
                    root.isDownloadDir
                      ? '下载目录固定包含，不能移除；可在设置中修改下载目录'
                      : '从扫描根中移除（不删除磁盘文件）'
                  }
                  aria-label={`移除扫描根 ${root.rootDir}`}
                  leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                >
                  移除
                </Button>
              </div>
            </div>
          ))}
          {roots.length === 0 ? (
            <p className="text-meta text-fg-muted">正在加载扫描根…</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
