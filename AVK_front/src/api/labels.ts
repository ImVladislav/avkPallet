import { getToken } from './auth'
import { apiUrl } from './apiUrl'

export type LabelQueryResponse = {
  data?: Record<string, unknown>
  error?: string
}

export async function fetchLabelByNumber(labelNumber: number): Promise<Record<string, unknown>> {
  const token = getToken()
  const res = await fetch(apiUrl(`/api/labels/${encodeURIComponent(String(labelNumber))}`), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  const data = (await res.json().catch(() => ({}))) as LabelQueryResponse
  if (!res.ok) {
    throw new Error(data.error ?? `Помилка сервісу бірок (${res.status})`)
  }
  return data.data ?? {}
}
