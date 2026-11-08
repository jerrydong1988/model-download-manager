/** 分段下载会把临时文件预分配成完整大小，因此额外保留 1 GB。 */
export const PREALLOC_RESERVE_BYTES = 1024 * 1024 * 1024

export interface DiskAssessment {
  level: 'ok' | 'short' | 'low'
  volume: string
  freeBytes: number
  neededBytes: number
  shortfallBytes: number
  remainingBytes: number
  segmented: boolean
  unknownSizeCount: number
}

/** 已选体积超过剩余空间，或分段预分配后余量低于 1 GB。 */
export function assessDisk(input: {
  freeBytes: number
  volume: string
  selectedBytes: number
  unknownSizeCount: number
  connectionsPerFile: number
}): DiskAssessment {
  const neededBytes = Math.max(0, input.selectedBytes)
  const freeBytes = Math.max(0, input.freeBytes)
  const segmented = input.connectionsPerFile > 1
  const shortfallBytes = neededBytes > freeBytes ? neededBytes - freeBytes : 0
  const remainingBytes = freeBytes > neededBytes ? freeBytes - neededBytes : 0
  let level: DiskAssessment['level'] = 'ok'
  if (neededBytes > 0 && shortfallBytes > 0) level = 'short'
  else if (segmented && neededBytes > 0 && remainingBytes < PREALLOC_RESERVE_BYTES) level = 'low'
  return {
    level,
    volume: input.volume,
    freeBytes,
    neededBytes,
    shortfallBytes,
    remainingBytes,
    segmented,
    unknownSizeCount: Math.max(0, input.unknownSizeCount),
  }
}
