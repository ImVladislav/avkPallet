import type { LogItem } from '../types/roundwood'

export type { LogItem } from '../types/roundwood'

/** Лише для одноразового перенесення старих даних з браузера (див. LogsPage). */
const LOGS_STORAGE_KEY = 'pallet.logs'

export function readLegacyLocalLogs(): LogItem[] {
  const raw = localStorage.getItem(LOGS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as LogItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function clearLegacyLocalLogs() {
  try {
    localStorage.removeItem(LOGS_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
export function removeLogById(logs: LogItem[], id: number): LogItem[] {
  return logs.filter((l) => l.id !== id)
}

/** Для розпилу: спочатку найбільші колоди (R, потім L), без змішування з меншими на початку списку. */
export function sortLogsLargeFirst(logs: readonly LogItem[]): LogItem[] {
  return [...logs].sort((a, b) => {
    const dr = b.radius - a.radius
    if (dr !== 0) return dr
    return b.length - a.length
  })
}
