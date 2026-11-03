import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, GitBranch, Pencil, Tag } from 'lucide-react'
import type { Source } from '../../types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { cx } from '../../lib/cx'

export interface RevisionSelectorProps {
  source: Source
  /** 当前 revision */
  current: string
  /** 来源默认 revision（HF main / MS master） */
  defaultRevision: string
  branches: string[]
  tags: string[]
  loading?: boolean
  /** 分支/标签列表加载失败信息（不阻塞默认 revision 浏览） */
  error?: string | null
  disabled?: boolean
  onRetry?: () => void
  onSelect: (revision: string) => void
}

function OptionButton({
  revision,
  active,
  onSelect,
  children,
}: {
  revision: string
  active: boolean
  onSelect: (revision: string) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(revision)}
      className={cx(
        'flex w-full cursor-pointer items-center gap-2 rounded-control px-1.5 py-1.5 text-left text-secondary transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        active ? 'bg-primary-soft text-primary' : 'text-fg-secondary hover:bg-surface-2',
      )}
    >
      <GitBranch
        className={cx('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-fg-muted')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate font-mono text-meta">{children}</span>
      {active ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
    </button>
  )
}

/**
 * 仓库 revision 选择器（v0.2.0）：
 * 默认 revision + list_revisions 返回的分支/标签 + 「自定义…」文本输入。
 * 选择后由调用方重新拉取仓库文件列表。
 */
export function RevisionSelector({
  source,
  current,
  defaultRevision,
  branches,
  tags,
  loading = false,
  error = null,
  disabled = false,
  onRetry,
  onSelect,
}: RevisionSelectorProps) {
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open])

  useEffect(() => {
    if (customOpen) inputRef.current?.focus()
  }, [customOpen])

  const commit = (revision: string) => {
    setOpen(false)
    setCustomOpen(false)
    setCustomValue('')
    if (revision !== current) onSelect(revision)
  }

  const branchOptions = branches.filter((branch) => branch && branch !== defaultRevision)
  const tagOptions = tags.filter((tag) => tag && tag !== defaultRevision)

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`选择 ${source === 'huggingface' ? 'HuggingFace' : 'ModelScope'} revision，当前 ${current}`}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control border px-2.5 text-meta font-medium transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50',
          current === defaultRevision
            ? 'border-line bg-surface text-fg-secondary hover:bg-surface-2'
            : 'border-primary/40 bg-primary-soft text-primary hover:bg-primary-soft/80',
        )}
        title="切换仓库 revision（分支 / 标签 / 自定义）"
      >
        <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="text-fg-muted">revision</span>
        <span className="max-w-[180px] truncate font-mono" title={current}>{current}</span>
        <ChevronDown className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="选择 revision"
          className="glass-overlay absolute left-0 top-full z-dropdown mt-1 max-h-[22rem] w-72 max-w-[calc(100vw-112px)] overflow-y-auto rounded-card p-2 shadow-overlay animate-fade-in"
        >
          <div className="mb-1 flex items-center justify-between gap-2 px-1.5 pb-1 text-meta text-fg-muted">
            <span>
              当前：<span className="font-mono text-fg">{current}</span>
            </span>
            {current === defaultRevision ? (
              <Badge tone="slate">默认</Badge>
            ) : (
              <Badge tone="indigo">非默认</Badge>
            )}
          </div>

          {loading ? (
            <p className="px-1.5 py-2 text-meta text-fg-muted">正在加载分支 / 标签…</p>
          ) : (
            <>
              <p className="px-1.5 pb-0.5 pt-1 text-meta font-medium text-fg-muted">默认 revision</p>
              <OptionButton
                revision={defaultRevision}
                active={current === defaultRevision}
                onSelect={commit}
              >
                {defaultRevision}（默认）
              </OptionButton>

              {branchOptions.length > 0 ? (
                <>
                  <p className="px-1.5 pb-0.5 pt-2 text-meta font-medium text-fg-muted">分支</p>
                  {branchOptions.map((branch) => (
                    <OptionButton
                      key={`branch:${branch}`}
                      revision={branch}
                      active={current === branch}
                      onSelect={commit}
                    >
                      {branch}
                    </OptionButton>
                  ))}
                </>
              ) : null}

              {tagOptions.length > 0 ? (
                <>
                  <p className="flex items-center gap-1 px-1.5 pb-0.5 pt-2 text-meta font-medium text-fg-muted">
                    <Tag className="h-3 w-3" aria-hidden="true" />
                    标签
                  </p>
                  {tagOptions.map((tag) => (
                    <OptionButton
                      key={`tag:${tag}`}
                      revision={tag}
                      active={current === tag}
                      onSelect={commit}
                    >
                      {tag}
                    </OptionButton>
                  ))}
                </>
              ) : null}

              {error ? (
                <p
                  role="alert"
                  className="mt-1 flex flex-wrap items-center gap-2 px-1.5 py-1 text-meta leading-4 text-danger"
                >
                  {error}
                  {onRetry ? (
                    <Button size="xs" variant="ghost" onClick={onRetry}>
                      重试
                    </Button>
                  ) : null}
                </p>
              ) : null}
            </>
          )}

          <div className="mt-1 border-t border-line pt-1">
            {customOpen ? (
              <form
                className="flex items-center gap-1.5 p-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  const revision = customValue.trim()
                  if (revision) commit(revision)
                }}
              >
                <input
                  ref={inputRef}
                  value={customValue}
                  onChange={(event) => setCustomValue(event.target.value)}
                  placeholder="分支 / 标签 / commit"
                  aria-label="自定义 revision"
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2 font-mono text-meta text-fg transition-colors duration-micro placeholder:text-fg-muted focus-visible:border-primary"
                />
                <Button size="xs" variant="primary" type="submit" disabled={!customValue.trim()}>
                  应用
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setCustomOpen(false)
                    setCustomValue('')
                  }}
                >
                  取消
                </Button>
              </form>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setCustomOpen(true)}
                leftIcon={<Pencil className="h-3.5 w-3.5" />}
              >
                自定义…
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
