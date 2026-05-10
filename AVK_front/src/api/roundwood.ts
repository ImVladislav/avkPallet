import { getToken } from './auth'
import { apiUrl } from './apiUrl'
import { notifyRoundwoodChanged } from './roundwoodEvents'
import type { BrusStockItem, LogItem, RoundwoodJournalEntry } from '../types/roundwood'

function headersJson(): HeadersInit {
  const t = getToken()
  return {
    'Content-Type': 'application/json',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  }
}

export type RoundwoodState = {
  stock: LogItem[]
  brusStock: BrusStockItem[]
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
    brusStock: Array.isArray((data as { brusStock?: BrusStockItem[] }).brusStock)
      ? (data as { brusStock: BrusStockItem[] }).brusStock
      : [],
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

export async function receiveBrusStock(payload: {
  sideAMm: number
  sideBMm: number
  lengthMm: number
  qty: number
  id?: number
}): Promise<{ brusStock: BrusStockItem[]; item: BrusStockItem }> {
  const res = await fetch(apiUrl('/api/roundwood/brus/receive'), {
    method: 'POST',
    headers: headersJson(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as {
    brusStock?: BrusStockItem[]
    item?: BrusStockItem
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося записати брус')
  }
  notifyRoundwoodChanged()
  return {
    brusStock: data.brusStock ?? [],
    item: data.item as BrusStockItem,
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

export async function deleteBrusStockItem(itemId: number): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/roundwood/brus/stock/${encodeURIComponent(String(itemId))}`),
    {
      method: 'DELETE',
      headers: headersJson(),
    },
  )
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'Не вдалося видалити брус')
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
