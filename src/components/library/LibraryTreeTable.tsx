import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  FileCog,
  FileText,
  Folder,
  FolderOpen,
  FolderSearch,
  Grid3x3,
  Projector,
  Trash2,
} from '../icons'
import type {
  LibraryDir,
  LibraryDirRow,
  LibraryFileEntry,
  LibraryFileRow,
  LibraryTreeRow,
} from '../../lib/libraryTree'
import { formatBytes, formatDateTime, formatRelativeTime } from '../../lib/format'
import { Badge, FileKindBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { PathText } from '../ui/PathText'
import { cx } from '../../lib/cx'

const ROW_HEIGHT = 40
const OVERSCAN = 12
const TREE_GRID = 'grid grid-cols-[minmax(0,1fr)_76px_98px_96px_88px] items-center gap-3'

function fileKindVisual(kind: LibraryFileEntry['kind']): {
  icon: typeof Boxes
  tone: string
} {
  if (kind === 'weight') {
    return { icon: Boxes, tone: 'text-indigo-500 dark:text-indigo-300' }
  }
  if (kind === 'mmproj') {
    return { icon: Projector, tone: 'text-violet-500 dark:text-violet-300' }
  }
  if (kind === 'imatrix') {
    return { icon: Grid3x3, tone: 'text-amber-500 dark:text-amber-300' }
  }
  if (kind === 'config') {
    return { icon: FileCog, tone: 'text-emerald-500 dark:text-emerald-300' }
  }
  return { icon: FileText, tone: 'text-fg-muted' }
}

export interface LibraryTreeTableProps {
  rows: LibraryTreeRow[]
  /** 固定下载目录（用于区分「下载目录」/「模型目录」根徽章） */
  downloadDir: string
  selectedFilePath: string | null
  onToggleDir: (path: string) => void
  onSelectFile: (file: LibraryFileEntry) => void
  onRevealDir: (dir: LibraryDir) => void
  onRevealFile: (file: LibraryFileEntry) => void
  onDeleteFile: (file: LibraryFileEntry) => void
  /** 变化时回到列表顶部（搜索 / 类型筛选切换） */
  resetScrollKey?: string
}

/**
 * 文件管理器式目录树表格。
 * 固定行高 40 + 滚动窗口渲染（≥500 行仍流畅）；↑↓/Home/End 键盘行导航。
 */
export function LibraryTreeTable({
  rows,
  downloadDir,
  selectedFilePath,
  onToggleDir,
  onSelectFile,
  onRevealDir,
  onRevealFile,
  onDeleteFile,
  resetScrollKey = '',
}: LibraryTreeTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const sync = () => setViewportHeight(element.clientHeight || 480)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setScrollTop(0)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [resetScrollKey])

  // 折叠 / 筛选导致行数变少时，把滚动位置钳制回内容范围内。
  useEffect(() => {
    const maxScroll = Math.max(0, rows.length * ROW_HEIGHT - viewportHeight)
    if (scrollTop > maxScroll) {
      setScrollTop(maxScroll)
      if (scrollRef.current) scrollRef.current.scrollTop = maxScroll
    }
  }, [rows.length, scrollTop, viewportHeight])

  const total = rows.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(
    total,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  )
  const visibleRows = rows.slice(start, end)

  /** ↑↓ / Home / End 在当前渲染的树行之间移动焦点（虚拟列表内为可用行为）。 */
  const moveRowFocus = (event: KeyboardEvent, delta: number): boolean => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false
    const items = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    )
    if (items.length === 0) return false
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next =
      event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + delta
    if (index < 0 && event.key !== 'Home' && event.key !== 'End') return false
    next = Math.max(0, Math.min(items.length - 1, next))
    event.preventDefault()
    items[next]?.focus()
    return true
  }

  const handleDirKey = (event: KeyboardEvent, row: LibraryDirRow) => {
    if (moveRowFocus(event, event.key === 'ArrowUp' ? -1 : 1)) return
    const path = row.dir.absolutePath
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onToggleDir(path)
    } else if (event.key === 'ArrowRight' && !row.expanded) {
      event.preventDefault()
      onToggleDir(path)
    } else if (event.key === 'ArrowLeft' && row.expanded) {
      event.preventDefault()
      onToggleDir(path)
    }
  }

  const handleFileKey = (event: KeyboardEvent, row: LibraryFileRow) => {
    if (moveRowFocus(event, event.key === 'ArrowUp' ? -1 : 1)) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelectFile(row.file)
    }
  }

  const renderDir = (row: LibraryDirRow) => {
    const { dir } = row
    const hasChildren = dir.dirs.length > 0 || dir.files.length > 0
    const isExternal = Boolean(dir.external)
    const isDownloadDir =
      row.isRoot &&
      dir.rootDir.toLowerCase() === downloadDir.replace(/[\\/]+$/, '').toLowerCase()
    return (
      <div
        role="treeitem"
        data-row-key={row.key}
        aria-level={row.depth + 1}
        aria-expanded={hasChildren ? row.expanded : undefined}
        tabIndex={0}
        onClick={() => onToggleDir(dir.absolutePath)}
        onKeyDown={(event) => handleDirKey(event, row)}
        className={cx(
          TREE_GRID,
          'h-10 cursor-pointer border-b border-line px-3 text-secondary transition-colors duration-micro last:border-b-0 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          row.isRoot && 'bg-surface-2/70',
        )}
      >
        <div
          className="flex min-w-0 items-center gap-1.5"
          style={{ paddingLeft: 4 + row.depth * 18 }}
        >
          <span className="grid h-4 w-4 shrink-0 place-items-center text-fg-muted">
            {hasChildren ? (
              row.expanded ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              )
            ) : null}
          </span>
          {row.expanded && hasChildren ? (
            <FolderOpen
              className={cx('h-4 w-4 shrink-0', isExternal ? 'text-warning' : 'text-primary')}
              aria-hidden="true"
            />
          ) : (
            <Folder
              className={cx('h-4 w-4 shrink-0', isExternal ? 'text-warning' : 'text-primary')}
              aria-hidden="true"
            />
          )}
          <span
            className={cx(
              'truncate',
              row.isRoot
                ? 'font-medium text-fg'
                : (dir.depth === 0 ? 'font-medium' : 'font-normal') + ' text-fg-secondary',
            )}
            title={row.isRoot ? dir.rootDir : dir.path}
          >
            {dir.name}
          </span>
          {!row.isRoot ? (
            <span className="shrink-0 text-meta tabular-nums text-fg-muted">
              {dir.fileCount} 个
            </span>
          ) : (
            <span className="shrink-0 text-meta tabular-nums text-fg-muted">
              {dir.fileCount} 个文件
            </span>
          )}
        </div>
        <span>
          {row.isRoot ? (
            <Badge tone={isDownloadDir ? 'blue' : 'indigo'}>
              {isDownloadDir ? '下载目录' : '模型目录'}
            </Badge>
          ) : isExternal ? (
            <Badge tone="amber">其他位置</Badge>
          ) : (
            <Badge tone="slate">目录</Badge>
          )}
        </span>
        <span className="text-right text-secondary tabular-nums text-fg-secondary">
          {formatBytes(dir.totalSize)}
        </span>
        <span
          className="truncate text-meta text-fg-muted"
          title={dir.latest > 0 ? formatDateTime(dir.latest) : undefined}
        >
          {dir.latest > 0 ? formatRelativeTime(dir.latest) : '—'}
        </span>
        <span className="flex justify-end">
          {!isExternal ? (
            <Button
              variant="ghost"
              size="icon"
              title={row.isRoot ? '打开扫描根目录' : '打开目录'}
              aria-label={`打开目录 ${row.isRoot ? dir.rootDir : dir.path}`}
              onClick={(event) => {
                event.stopPropagation()
                onRevealDir(dir)
              }}
            >
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </span>
      </div>
    )
  }

  const renderFile = (row: LibraryFileRow) => {
    const { file } = row
    const visual = fileKindVisual(file.kind)
    const FileIcon = visual.icon
    const selected = selectedFilePath === file.path
    return (
      <div
        role="treeitem"
        data-row-key={row.key}
        aria-level={row.depth + 1}
        aria-selected={selected}
        tabIndex={0}
        onClick={() => onSelectFile(file)}
        onKeyDown={(event) => handleFileKey(event, row)}
        className={cx(
          TREE_GRID,
          'h-10 cursor-pointer border-b border-line px-3 text-secondary transition-colors duration-micro last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          selected ? 'bg-primary-soft' : 'hover:bg-surface-2',
        )}
      >
        <div
          className="flex min-w-0 items-center gap-1.5"
          style={{ paddingLeft: 4 + row.depth * 18 + 20 }}
        >
          <FileIcon className={cx('h-4 w-4 shrink-0', visual.tone)} aria-hidden="true" />
          {/* 长文件名中间省略 + focus 完整路径 tooltip / 读屏全文（P1-5）。 */}
          <PathText path={file.path} label={file.name} copyable={false} />
        </div>
        <span>
          <FileKindBadge kind={file.kind} />
        </span>
        <span className="text-right text-secondary tabular-nums text-fg-secondary">
          {formatBytes(file.size)}
        </span>
        <span
          className="truncate text-meta text-fg-muted"
          title={formatDateTime(file.modifiedAt)}
        >
          {formatRelativeTime(file.modifiedAt)}
        </span>
        <span className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="在资源管理器中显示"
            aria-label={`在资源管理器中显示 ${file.name}`}
            onClick={(event) => {
              event.stopPropagation()
              onRevealFile(file)
            }}
          >
            <FolderSearch className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="dangerGhost"
            size="icon"
            title="删除文件"
            aria-label={`删除文件 ${file.name}`}
            onClick={(event) => {
              event.stopPropagation()
              onDeleteFile(file)
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
      <div className="flex min-h-0 min-w-[640px] flex-1 flex-col">
      <div
        aria-hidden="true"
        className={cx(
          TREE_GRID,
          'h-10 shrink-0 border-b border-line bg-surface-2 px-3 text-meta font-semibold text-fg-secondary',
        )}
      >
        <span>名称</span>
        <span>类型</span>
        <span className="text-right">大小</span>
        <span>修改时间</span>
        <span className="text-right">操作</span>
      </div>
      {total === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-body text-fg-muted">
          没有可显示的文件
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className="min-h-0 flex-1 overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          tabIndex={0}
          role="tree"
          aria-label="本地模型库目录树"
        >
          <div style={{ height: total * ROW_HEIGHT }} className="relative">
            {visibleRows.map((row, index) => (
              <div
                key={row.key}
                style={{
                  position: 'absolute',
                  top: (start + index) * ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
              >
                {row.kind === 'dir' ? renderDir(row) : renderFile(row)}
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
