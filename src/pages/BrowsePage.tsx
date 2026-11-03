import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Compass, RefreshCw, Search, X } from '../components/icons'
import type { RepoSearchPage, RepoSummary, Source } from '../types'
import { searchRepos, toErrorText } from '../lib/ipc'
import { RepoCard } from '../components/browse/RepoCard'
import { RepoDetailView } from '../components/browse/RepoDetailView'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorBanner } from '../components/ui/ErrorBanner'
import { RepoCardSkeleton } from '../components/ui/Skeleton'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { SOURCE_LABEL } from '../lib/labels'
import { useAppStore } from '../store/appStore'
import {
  APP_FOCUS_SEARCH_EVENT,
  APP_REFRESH_PAGE_EVENT,
} from '../components/layout/useGlobalShortcuts'

type SearchStatus = 'idle' | 'loading' | 'loadingMore' | 'ready' | 'error'

const PAGE_SIZE = 8

const SOURCE_OPTIONS: Array<{ value: Source; label: string }> = [
  { value: 'huggingface', label: 'HuggingFace' },
  { value: 'modelscope', label: 'ModelScope' },
]

const SUGGESTIONS: Array<{ label: string; query: string }> = [
  { label: 'Qwen', query: 'Qwen' },
  { label: 'DeepSeek', query: 'DeepSeek' },
  { label: 'Llama', query: 'Llama' },
  { label: '向量模型', query: 'bge' },
  { label: '语音识别', query: 'whisper' },
  { label: '文生图', query: 'text-to-image' },
]

/** 支持 ?repo=org/model&source=huggingface 深链直接打开仓库详情（QA / 分享）。 */
function sourceFromUrl(): Source {
  if (typeof window === 'undefined') return 'huggingface'
  const value = new URLSearchParams(window.location.search).get('source')
  return value === 'modelscope' ? 'modelscope' : 'huggingface'
}

function repoFromUrl(): RepoSummary | null {
  if (typeof window === 'undefined') return null
  const id = new URLSearchParams(window.location.search).get('repo')
  if (!id || !id.includes('/')) return null
  return {
    id,
    source: sourceFromUrl(),
    downloads: 0,
    likes: 0,
    tags: [],
  }
}

export default function BrowsePage() {
  const [source, setSource] = useState<Source>(sourceFromUrl)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<RepoSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<SearchStatus>('idle')
  const [error, setError] = useState('')
  const [selectedRepo, setSelectedRepo] = useState<RepoSummary | null>(repoFromUrl)

  const requestSeq = useRef(0)
  const lastAutoQuery = useRef('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const runSearch = useCallback(
    async (options: {
      query: string
      source: Source
      page: number
      cursor?: string
      reset: boolean
    }) => {
      const seq = requestSeq.current + 1
      requestSeq.current = seq
      setStatus(options.reset ? 'loading' : 'loadingMore')
      setError('')
      try {
        const result: RepoSearchPage = await searchRepos({
          source: options.source,
          query: options.query.trim(),
          page: options.page,
          limit: PAGE_SIZE,
          cursor: options.cursor,
        })
        if (seq !== requestSeq.current) return
        setItems((previous) => {
          if (options.reset) return result.items
          const known = new Set(previous.map((item) => `${item.source}:${item.id}`))
          const appended = result.items.filter(
            (item) => !known.has(`${item.source}:${item.id}`),
          )
          return [...previous, ...appended]
        })
        setHasMore(result.hasMore)
        setCursor(result.nextCursor)
        setStatus('ready')
      } catch (err) {
        if (seq !== requestSeq.current) return
        setStatus('error')
        setError(toErrorText(err))
      }
    },
    [],
  )

  const resetAndSearch = useCallback(
    (nextQuery: string) => {
      lastAutoQuery.current = nextQuery
      setPage(1)
      setCursor(undefined)
      setItems([])
      void runSearch({ query: nextQuery, source, page: 1, reset: true })
    },
    [runSearch, source],
  )

  // 首次进入 + 切换来源：立即按当前关键词重新搜索。
  useEffect(() => {
    lastAutoQuery.current = query
    setPage(1)
    setCursor(undefined)
    setItems([])
    void runSearch({ query, source, page: 1, reset: true })
    // 仅在来源变化时触发；query 由防抖 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // 输入防抖：停止输入 420ms 后自动搜索。
  useEffect(() => {
    if (query === lastAutoQuery.current) return
    const timer = window.setTimeout(() => {
      lastAutoQuery.current = query
      setPage(1)
      setCursor(undefined)
      setItems([])
      void runSearch({ query, source, page: 1, reset: true })
    }, 420)
    return () => window.clearTimeout(timer)
  }, [query, runSearch, source])

  // 全局快捷键：Ctrl/Cmd+F 聚焦搜索框；F5 重新搜索当前关键词。
  useEffect(() => {
    const focusSearch = () => {
      if (useAppStore.getState().page !== 'browse') return
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: string }>).detail
      if (detail?.page && detail.page !== 'browse') return
      if (useAppStore.getState().page !== 'browse') return
      // 仓库详情打开时由 RepoDetailView 自己响应 F5（刷新文件列表）。
      if (selectedRepo) return
      resetAndSearch(query)
      useAppStore.getState().pushToast('info', '已刷新搜索结果')
    }
    window.addEventListener(APP_FOCUS_SEARCH_EVENT, focusSearch)
    window.addEventListener(APP_REFRESH_PAGE_EVENT, refresh)
    return () => {
      window.removeEventListener(APP_FOCUS_SEARCH_EVENT, focusSearch)
      window.removeEventListener(APP_REFRESH_PAGE_EVENT, refresh)
    }
  }, [query, resetAndSearch, selectedRepo])

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    resetAndSearch(query)
  }

  const handleClearQuery = () => {
    setQuery('')
    resetAndSearch('')
    searchInputRef.current?.focus()
  }

  const handleLoadMore = () => {
    if (!hasMore || status === 'loading' || status === 'loadingMore') return
    const nextPage = page + 1
    setPage(nextPage)
    void runSearch({
      query,
      source,
      page: nextPage,
      cursor,
      reset: false,
    })
  }

  const handleRetry = () => {
    if (items.length === 0) {
      resetAndSearch(query)
    } else {
      void runSearch({ query, source, page, cursor, reset: false })
    }
  }

  if (selectedRepo) {
    return (
      <RepoDetailView
        key={`${selectedRepo.source}:${selectedRepo.id}`}
        repo={selectedRepo}
        onBack={() => setSelectedRepo(null)}
      />
    )
  }

  const initialLoading = status === 'loading' && items.length === 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-container space-y-7 pb-8">
        {/* 搜索区 */}
        <section aria-label="查找模型" className="space-y-4">
          <div className="flex flex-col gap-4">
            <SegmentedControl
              variant="tabs"
              ariaLabel="切换模型来源"
              value={source}
              onChange={(value) => {
                if (value === source) return
                setSelectedRepo(null)
                setSource(value)
              }}
              options={SOURCE_OPTIONS}
            />
            <form onSubmit={handleSubmit} className="flex min-w-0 flex-1 items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-fg-muted"
                  aria-hidden="true"
                />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="搜索仓库"
                  placeholder={
                    source === 'huggingface'
                      ? '搜索 HuggingFace 仓库，例如 Qwen/Qwen2.5-7B-Instruct'
                      : '搜索 ModelScope 仓库，例如 Qwen/Qwen2.5-7B-Instruct'
                  }
                  className="h-12 w-full rounded-control border border-line-strong bg-surface pl-11 pr-9 text-body text-fg transition-colors duration-micro placeholder:text-fg-muted focus-visible:border-primary"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={handleClearQuery}
                    aria-label="清空搜索关键词"
                    className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-control text-fg-muted transition-colors duration-micro hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <Button
                type="submit"
                variant="primary"
                size="xl"
                loading={initialLoading}
                leftIcon={<Search className="h-4 w-4" />}
              >
                搜索
              </Button>
            </form>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-meta text-fg-secondary">
            <span className="mr-1 text-fg-muted">热门搜索</span>
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.label}
                type="button"
                onClick={() => {
                  setQuery(suggestion.query)
                  resetAndSearch(suggestion.query)
                }}
                className="h-7 cursor-pointer rounded-md px-2 text-meta text-fg-secondary transition-colors duration-micro hover:bg-primary-soft hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                {suggestion.label}
              </button>
            ))}
            <span className="ml-auto hidden items-center gap-1 text-meta text-fg-muted sm:flex">
              Ctrl+F 搜索
            </span>
          </div>
        </section>

        {/* 结果标题 */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-section text-fg">
              {query.trim() ? `“${query.trim()}” 的搜索结果` : '热门模型'}
            </h2>
            <p className="mt-0.5 text-meta text-fg-secondary" role="status" aria-live="polite">
              {SOURCE_LABEL[source]} · 已加载 {items.length} 个仓库
              {hasMore ? '，可继续加载' : ''}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resetAndSearch(query)}
            loading={status === 'loading'}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            刷新
          </Button>
        </div>

        {/* 错误 / 加载 / 空 / 结果 */}
        {status === 'error' ? (
          <ErrorBanner
            title="搜索仓库失败"
            message={error}
            onRetry={handleRetry}
            retryLabel="重新搜索"
          />
        ) : initialLoading ? (
          <div className="divide-y divide-line" aria-busy="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <RepoCardSkeleton key={index} />
            ))}
          </div>
        ) : status === 'ready' && items.length === 0 ? (
          <div className="rounded-card border border-line bg-surface">
            <EmptyState
              icon={Compass}
              title={query.trim() ? '没有找到匹配的仓库' : '暂时没有热门仓库'}
              description={
                query.trim()
                  ? `在 ${SOURCE_LABEL[source]} 中没有找到与“${query.trim()}”匹配的模型，试试更换关键词或切换来源。`
                  : '可以输入模型名称、组织名或任务类型进行搜索。'
              }
              action={
                query.trim() ? (
                  <Button variant="secondary" onClick={handleClearQuery}>
                    清空搜索
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => resetAndSearch('Qwen')}
                    leftIcon={<Search className="h-4 w-4" />}
                  >
                    搜索 Qwen
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <>
            <div>
              <div className="repo-columns border-b border-line px-3 pb-3 text-meta text-fg-muted" aria-hidden="true">
                <span>模型仓库</span><span className="hidden lg:block">任务类型</span><span className="hidden lg:block">下载 / 点赞</span><span className="text-right">文件</span>
              </div>
              {items.map((repo) => (
                <RepoCard
                  key={`${repo.source}:${repo.id}`}
                  repo={repo}
                  onOpen={setSelectedRepo}
                />
              ))}
            </div>

            <div className="flex items-center justify-center pt-2">
              {hasMore ? (
                <Button
                  variant="secondary"
                  onClick={handleLoadMore}
                  loading={status === 'loadingMore'}
                  leftIcon={<ChevronDown className="h-4 w-4" />}
                >
                  加载更多
                </Button>
              ) : items.length > 0 ? (
                <p className="text-meta text-fg-muted">已加载全部 {items.length} 个仓库</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
