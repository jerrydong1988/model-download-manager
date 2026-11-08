import { useEffect, useRef, type ReactNode } from 'react'
import {
  Boxes,
  FileCog,
  FileText,
  FolderSearch,
  Grid3x3,
  Projector,
  Trash2,
  X,
} from '../icons'
import type { LibraryFileEntry } from '../../lib/libraryTree'
import { formatBytes, formatDateTime, formatRelativeTime } from '../../lib/format'
import { useAppStore } from '../../store/appStore'
import { verifyPresentation } from '../../lib/verifyLabel'
import { Badge, FileKindBadge, SourceBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { PathText } from '../ui/PathText'
import { cx } from '../../lib/cx'

function fileVisual(kind: LibraryFileEntry['kind']): {
  icon: typeof Boxes
  tone: string
} {
  if (kind === 'weight') {
    return {
      icon: Boxes,
      tone: 'border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-300',
    }
  }
  if (kind === 'mmproj') {
    return {
      icon: Projector,
      tone: 'border-violet-200 bg-violet-50 text-violet-600 dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-300',
    }
  }
  if (kind === 'imatrix') {
    return {
      icon: Grid3x3,
      tone: 'border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300',
    }
  }
  if (kind === 'config') {
    return {
      icon: FileCog,
      tone: 'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300',
    }
  }
  return { icon: FileText, tone: 'border-line bg-surface-2 text-fg-muted' }
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-secondary leading-5">
      <dt className="w-16 shrink-0 text-meta text-fg-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-all text-fg-secondary">{children}</dd>
    </div>
  )
}

export interface LibraryDetailPanelProps {
  file: LibraryFileEntry
  onClose: () => void
  onReveal: () => void
  onDelete: () => void
}

/** 选中文件详情面板：xl 以上内联在目录树右侧，窄窗口为覆盖式抽屉。 */
export function LibraryDetailPanel({
  file,
  onClose,
  onReveal,
  onDelete,
}: LibraryDetailPanelProps) {
  const visual = fileVisual(file.kind)
  const FileIcon = visual.icon
  const closeRef = useRef<HTMLButtonElement>(null)
  const pushToast = useAppStore((state) => state.pushToast)
  const tasks = useAppStore((state) => state.tasks)
  const verify = verifyPresentation(file.path, tasks)

  useEffect(() => {
    // 打开时焦点移入面板（关闭后由 LibraryPage 归还到原行）。
    closeRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <aside
      role="complementary"
      aria-label="文件详情"
      className="fixed inset-y-24 right-3 z-40 flex w-[320px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-overlay animate-fade-in xl:static xl:inset-auto xl:z-auto xl:w-[300px] xl:shrink-0 xl:rounded-none xl:border-0 xl:border-l xl:border-line xl:shadow-none"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-section text-fg">文件详情</h2>
        <button
          ref={closeRef}
          type="button"
          aria-label="关闭文件详情"
          onClick={onClose}
          className="grid h-9 w-9 place-items-center rounded-control text-fg-muted transition-colors duration-micro hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div
          className={cx('grid h-11 w-11 place-items-center rounded-card border', visual.tone)}
        >
          <FileIcon className="h-5 w-5" aria-hidden="true" />
        </div>
        <p className="mt-3 break-all text-body font-semibold text-fg">{file.name}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <FileKindBadge kind={file.kind} />
          {file.source ? <SourceBadge source={file.source} /> : null}
        </div>

        <dl className="mt-4 space-y-3 border-t border-line pt-4">
          <InfoRow label="校验">
            <Badge tone={verify.tone}>{verify.label}</Badge>
          </InfoRow>
          <InfoRow label="大小">{formatBytes(file.size)}</InfoRow>
          <InfoRow label="修改时间">
            {formatDateTime(file.modifiedAt)}
            <span className="ml-1.5 text-fg-muted">（{formatRelativeTime(file.modifiedAt)}）</span>
          </InfoRow>
          <InfoRow label="相对路径">
            <PathText
              path={file.relativePath}
              onCopied={(text) => pushToast('success', '路径已复制', text)}
            />
          </InfoRow>
          <InfoRow label="完整路径">
            <PathText
              path={file.path}
              onCopied={(text) => pushToast('success', '路径已复制', text)}
            />
          </InfoRow>
          {file.rootDir ? (
            <InfoRow label="扫描根">
              <PathText
                path={file.rootDir}
                onCopied={(text) => pushToast('success', '路径已复制', text)}
              />
            </InfoRow>
          ) : null}
          {file.repoId ? <InfoRow label="来源仓库">{file.repoId}</InfoRow> : null}
          {file.source ? (
            <InfoRow label="数据来源">
              {file.source === 'huggingface' ? 'HuggingFace' : 'ModelScope'}
            </InfoRow>
          ) : null}
        </dl>
      </div>

      <div className="shrink-0 space-y-2 border-t border-line p-3">
        <Button
          variant="secondary"
          className="w-full"
          onClick={onReveal}
          leftIcon={<FolderSearch className="h-4 w-4" />}
        >
          在资源管理器中显示
        </Button>
        <Button
          variant="dangerGhost"
          className="w-full"
          onClick={onDelete}
          leftIcon={<Trash2 className="h-4 w-4" />}
        >
          删除文件
        </Button>
      </div>
    </aside>
  )
}
