import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'

/** 骨架屏基础块。 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx('animate-pulse rounded-control bg-surface-3', className)}
      aria-hidden="true"
    />
  )
}

export interface SkeletonRegionProps {
  children: ReactNode
  className?: string
  busy?: boolean
  /** 读屏提示，默认「正在加载…」 */
  label?: string
}

/**
 * 骨架容器：提供 role="status" + aria-busy 加载语义（使用方包住骨架块即可）。
 */
export function SkeletonRegion({
  children,
  className,
  busy = true,
  label = '正在加载…',
}: SkeletonRegionProps) {
  return (
    <div role="status" aria-busy={busy} aria-label={label} className={className}>
      {children}
    </div>
  )
}

/** 搜索卡片骨架（浏览页）。 */
export function RepoCardSkeleton() {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <Skeleton className="h-9 w-9" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-14" />
        <Skeleton className="h-6 w-20" />
      </div>
    </div>
  )
}

/** 任务行骨架（下载页）。 */
export function TaskRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-4 last:border-b-0">
      <Skeleton className="h-9 w-9" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-2 w-full" />
      </div>
      <Skeleton className="h-8 w-20" />
    </div>
  )
}
