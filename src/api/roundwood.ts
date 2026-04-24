import { getToken } from './auth'
import { apiUrl } from './apiUrl'
import { notifyRoundwoodChanged } from './roundwoodEvents'
import type { LogItem, RoundwoodJournalEntry } from '../types/roundwood'

function headersJson(): HeadersInit {
  const t = getToken()
  return {
    'Content-Type': 'application/json',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  }
}

export type RoundwoodState = {
  stock: LogItem[]
  journal: RoundwoodJournalEntry[]
}

export async function fetchRoundwoodState(): Promise<RoundwoodState> {
  const res = await fetch(apiUrl('/api/roundwood'), { headers: headersJson() })
  const data = (await res.json().catch(() => ({}))) as {
    stock?: LogItem[]
    journal?: RoundwoodJournalEntry[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося завантажити кругляк')
  }
  return {
    stock: Array.isArray(data.stock) ? data.stock : [],
    journal: Array.isArray(data.journal) ? data.journal : [],
  }
}

export async function receiveRoundwoodLog(payload: {
  radiusMm: number
  lengthMm: number
  id?: number
  /** Об'єм з бірки (м³), опційно. */
  volumeM3?: number
}): Promise<{ stock: LogItem[]; item: LogItem }> {
  const res = await fetch(apiUrl('/api/roundwood/receive'), {
    method: 'POST',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as {
    stock?: LogItem[]
    item?: LogItem
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося записати прийом')
  }
  notifyRoundwoodChanged()
  return {
    stock: data.stock ?? [],
    item: data.item as LogItem,
  }
}

export async function receiveRoundwoodLogByLabel(payload: {
  labelNumber: number
  id?: number
}): Promise<{ stock: LogItem[]; item: LogItem }> {
  const res = await fetch(apiUrl('/api/roundwood/receive-from-label'), {
    method: 'POST',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as {
    stock?: LogItem[]
    item?: LogItem
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося записати прийом за біркою')
  }
  notifyRoundwoodChanged()
  return {
    stock: data.stock ?? [],
    item: data.item as LogItem,
  }
}

export async function consumeRoundwoodLog(payload: {
  logId: number
  taskId?: string
  taskTitle?: string
}): Promise<void> {
  const res = await fetch(apiUrl('/api/roundwood/consume'), {
    method: 'POST',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося списати колоду')
  }
  notifyRoundwoodChanged()
}

export async function deleteRoundwoodStockItem(logId: number): Promise<void> {
  const res = await fetch(apiUrl(`/api/roundwood/stock/${encodeURIComponent(String(logId))}`), {
    method: 'DELETE',
    headers: headersJson(),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося видалити запис')
  }
  notifyRoundwoodChanged()
}

export async function patchRoundwoodStockItem(
  logId: number,
  payload: { radiusMm: number; lengthMm: number },
): Promise<{ stock: LogItem[] }> {
  const res = await fetch(apiUrl(`/api/roundwood/stock/${logId}`), {
    method: 'PATCH',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { stock?: LogItem[]; error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося оновити колоду')
  }
  notifyRoundwoodChanged()
  return { stock: data.stock ?? [] }
}

export async function clearRoundwoodStock(): Promise<void> {
  const res = await fetch(apiUrl('/api/roundwood/stock'), {
    method: 'DELETE',
    headers: headersJson(),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося очистити склад')
  }
  notifyRoundwoodChanged()
}
