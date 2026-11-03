import { AlertTriangle, RefreshCw } from '../icons'
import { Button } from './Button'
import { cx } from '../../lib/cx'

export interface ErrorBannerProps {
  message: string
  title?: string
  onRetry?: () => void
  retryLabel?: string
  className?: string
}

/** 可重试错误条（role=alert，danger 语义 token + 暗色）。 */
export function ErrorBanner({
  message,
  title = '操作失败',
  onRetry,
  retryLabel = '重试',
  className,
}: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-wrap items-start gap-3 rounded-control border border-danger/40 bg-danger/10 px-3.5 py-3 text-secondary text-fg',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 break-words leading-5 text-fg-secondary">{message}</p>
      </div>
      {onRetry ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          className="shrink-0 border-danger/40 text-danger hover:bg-danger/10"
        >
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}
