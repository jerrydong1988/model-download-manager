import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy } from '../icons'
import { Button } from './Button'
import { cx } from '../../lib/cx'

export interface PathTextProps {
  /** 完整路径（也用作复制内容与 tooltip 全文） */
  path: string
  className?: string
  /** 自定义展示文本（默认直接展示 path） */
  label?: string
  /** 是否显示复制按钮，默认 true */
  copyable?: boolean
  /** 复制成功回调（调用方用于弹 Toast） */
  onCopied?: (text: string) => void
  /** 复制按钮读屏文案前缀，默认「复制路径」 */
  copyLabel?: string
}

/** 中间省略：保留头尾字符，超出预算时用 … 连接。 */
function middleEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.max(6, Math.ceil((maxChars - 1) * 0.36))
  const tail = Math.max(6, maxChars - 1 - head)
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

/**
 * 路径展示组件（DESIGN-TOKENS §4.10）：
 * - 中间省略（依据容器宽度测量后保留头尾）；
 * - 可聚焦，focus 时显示完整路径 tooltip，并通过 aria-describedby 暴露全文；
 * - 复制按钮（调用方通过 onCopied 弹成功 Toast）。
 */
export function PathText({
  path,
  className,
  label,
  copyable = true,
  onCopied,
  copyLabel = '复制路径',
}: PathTextProps) {
  const text = label ?? path
  const descriptionId = useId()
  const measureRef = useRef<HTMLSpanElement>(null)
  const [display, setDisplay] = useState(text)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    const element = measureRef.current
    if (!element) return
    const compute = () => {
      const width = element.clientWidth
      if (!width) return
      const style = window.getComputedStyle(element)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) return
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      // 中文字宽约等于字号，取较宽字符做保守估算。
      const charWidth = Math.max(6, context.measureText('中').width)
      const maxChars = Math.max(10, Math.floor(width / charWidth))
      setDisplay(middleEllipsis(text, maxChars))
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])

  useEffect(() => {
    return () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(path)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = path
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800)
      onCopied?.(path)
    } catch {
      /* 剪贴板不可用时静默失败，不影响路径展示 */
    }
  }

  return (
    <div className={cx('relative flex min-w-0 items-center gap-1', className)}>
      <span
        ref={measureRef}
        tabIndex={0}
        onFocus={() => setTooltipOpen(true)}
        onBlur={() => setTooltipOpen(false)}
        aria-describedby={descriptionId}
        className="min-w-0 flex-1 truncate rounded-[4px] font-mono text-meta text-fg-secondary"
      >
        {display}
        <span id={descriptionId} className="sr-only">
          {path}
        </span>
      </span>
      {copyable ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void handleCopy()}
          aria-label={`${copyLabel}：${path}`}
          title={copied ? '已复制' : '复制路径'}
        >
          {copied ? (
            <Check className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      ) : null}
      {tooltipOpen ? (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-dropdown mt-1 w-max max-w-[min(560px,70vw)] break-all rounded-control border border-line bg-surface px-2 py-1.5 font-mono text-meta text-fg shadow-overlay"
        >
          {path}
        </span>
      ) : null}
    </div>
  )
}
