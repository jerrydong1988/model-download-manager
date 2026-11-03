/** 字节 / 速度 / 时间 / 数量格式化工具（中文界面）。 */

import type { Source } from '../types'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
const MB = 1024 * 1024

/** 来源默认 revision（契约：HF main / ModelScope master）。 */
export function defaultRevisionFor(source: Source): string {
  return source === 'huggingface' ? 'main' : 'master'
}

/** 去掉小数末尾多余的 0：1.20 -> 1.2，10.00 -> 10 */
function trimFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(digits).replace(/\.?0+$/, '')
}

/** 字节数 → "1.24 GB" 形式。 */
export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits =
    fractionDigits ?? (unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2)
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

/** 字节/秒 → "12.3 MB/s"；0 或无效显示 "—"。 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  const digits = bytesPerSecond >= 100 * MB ? 0 : bytesPerSecond >= 10 * MB ? 1 : 2
  return `${formatBytes(bytesPerSecond, digits)}/s`
}

/** 剩余字节 + 速度 → 中文 ETA。 */
export function formatEta(remainingBytes: number, speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0 || remainingBytes <= 0) return '—'
  return formatDuration(remainingBytes / speed)
}

/** 秒 → "3 秒" / "2 分 30 秒" / "1 小时 5 分" / "2 天 3 小时"。 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '—'
  const seconds = Math.max(1, Math.round(totalSeconds))
  if (seconds < 60) return `${seconds} 秒`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分`
}

/** 数量 → "1.2 万" / "3.4 亿" / 千分位。 */
export function formatCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  if (count >= 1e8) return `${trimFixed(count / 1e8, 2)} 亿`
  if (count >= 1e4) {
    const value = count / 1e4
    return `${trimFixed(value, value >= 1000 ? 0 : 1)} 万`
  }
  return Math.round(count).toLocaleString('zh-CN')
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Unix 毫秒 → "2025-06-12 14:32"。 */
export function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`
}

/** Unix 毫秒 → 相对时间（刚刚 / N 分钟前 / N 天前），过久回退为日期。 */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const diff = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return formatDateTime(timestamp)
}

/** ISO/原样字符串 → "2025-06-12"；无法解析时原样展示。 */
export function formatIsoDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 进度百分比整数（0-100）。 */
export function formatPercent(downloaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const value = Math.floor((Math.max(0, downloaded) / total) * 100)
  return Math.max(0, Math.min(100, value))
}

/** 0..8 并发、0..10 重试等整数钳制。 */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 字节 → MB 数值（保留两位，用于输入框）。 */
export function bytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.round((bytes / MB) * 100) / 100
}

/** MB 文本 → 字节；非法返回 null。 */
export function parseMbToBytes(input: string): number | null {
  const normalized = input.trim().replace(',', '.')
  if (normalized === '') return null
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * MB)
}

/** 单位换算辅助：只用于测试/展示 MB（如限速输入）。 */
export const MB_IN_BYTES = MB
