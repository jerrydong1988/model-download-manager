import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepoFile } from '../../types'
import {
  FileTableHeader,
  FileTableRow,
  type FileStateInfo,
} from './RepoDetailHeader'
import { EmptyState } from '../ui/EmptyState'
import { FileQuestion } from 'lucide-react'

const ROW_HEIGHT = 48
const OVERSCAN = 10

export interface FileTableProps {
  files: RepoFile[]
  selected: Set<string>
  resolveState: (file: RepoFile) => FileStateInfo | null
  onToggle: (path: string) => void
  onToggleAll: (checked: boolean) => void
  emptyHint?: string
}

/**
 * 仓库文件表。
 * 通过固定行高 + 滚动窗口只渲染可视区域（≥500 文件仍保持流畅），
 * 表头固定、滚轮/键盘滚动均可用。
 */
export function FileTable({
  files,
  selected,
  resolveState,
  onToggle,
  onToggleAll,
  emptyHint = '没有匹配的文件',
}: FileTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(520)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const sync = () => setViewportHeight(element.clientHeight || 520)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 筛选条件变化后回到顶部。
  useEffect(() => {
    setScrollTop(0)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [files])

  const selectableFiles = useMemo(
    () => files.filter((file) => !resolveState(file)?.disabled),
    [files, resolveState],
  )
  const selectedCount = useMemo(
    () => selectableFiles.filter((file) => selected.has(file.path)).length,
    [selectableFiles, selected],
  )
  const allSelected = selectableFiles.length > 0 && selectedCount === selectableFiles.length
  const someSelected = selectedCount > 0

  const total = files.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const visibleFiles = files.slice(start, end)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
      <div className="flex min-h-0 min-w-[600px] flex-1 flex-col">
      <FileTableHeader
        allSelected={allSelected}
        someSelected={someSelected}
        onToggleAll={onToggleAll}
        selectableCount={selectableFiles.length}
      />
      {total === 0 ? (
        <EmptyState icon={FileQuestion} title={emptyHint} compact className="flex-1" />
      ) : (
        <div
          ref={scrollRef}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className="min-h-0 flex-1 overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          tabIndex={0}
          role="region"
          aria-label="仓库文件列表"
        >
          <div style={{ height: total * ROW_HEIGHT }} className="relative">
            {visibleFiles.map((file, index) => (
              <div
                key={file.path}
                style={{
                  position: 'absolute',
                  top: (start + index) * ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
              >
                <FileTableRow
                  file={file}
                  selected={selected.has(file.path)}
                  state={resolveState(file)}
                  onToggle={onToggle}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
