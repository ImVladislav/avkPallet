import { apiUrl } from './apiUrl'
import { getToken, type AuthUser, type UserRole } from './auth'

export type UserAccessTab =
  | 'logs'
  | 'work_journal'
  | 'band_saw'
  | 'strip_saw'
  | 'circular_saw'
  | 'tasks'
  | 'warehouse'
  | 'pallets'
  | 'boards'
  | 'users'

export type ManagedUser = AuthUser & {
  password?: string
}

export type WorkerDirectoryEntry = {
  id: string
  username: string
  displayName: string
  role: UserRole
}

export type SalaryStationKey = 'band_saw' | 'strip_saw' | 'circular_saw' | 'pallets'

export type SalaryReportStation = SalaryStationKey | 'manual'

export type SalaryRates = Record<SalaryStationKey, number>

export type SalaryManualEntry = {
  id: string
  userId: string
  amountUah: number
  note: string
  at: string
  recordedBy?: { username: string; sub?: string }
}

export type SalaryReportRow = {
  userId: string
  displayName: string
  username: string
  taskId: string
  taskTitle: string
  station: SalaryReportStation
  at: string
  amountUah: number
  basisQty?: number
  basisUnit?: 'm3' | 'task'
}

export type SalaryReportTotal = {
  userId: string
  displayName: string
  username: string
  totalUah: number
}

type UpsertUserPayload = {
  username: string
  displayName: string
  role: UserRole
  tabs: UserAccessTab[]
  password?: string
}

function headersJson(withBody = false): HeadersInit {
  const token = getToken()
  const base: HeadersInit = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  if (withBody) return { 'Content-Type': 'application/json', ...base }
  return base
}

export async function fetchUsers(): Promise<ManagedUser[]> {
  const res = await fetch(apiUrl('/api/users'), { headers: headersJson() })
  const data = (await res.json()) as { users?: ManagedUser[]; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося отримати користувачів')
  return Array.isArray(data.users) ? data.users : []
}

export async function createUser(payload: UpsertUserPayload): Promise<ManagedUser> {
  const res = await fetch(apiUrl('/api/users'), {
    method: 'POST',
    headers: headersJson(true),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as { user?: ManagedUser; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося створити користувача')
  if (!data.user) throw new Error('Сервер не повернув створеного користувача')
  return data.user
}

export async function updateUser(id: string, payload: UpsertUserPayload): Promise<ManagedUser> {
  const res = await fetch(apiUrl(`/api/users/${encodeURIComponent(id)}`), {
    method: 'PUT',
    headers: headersJson(true),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as { user?: ManagedUser; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося оновити користувача')
  if (!data.user) throw new Error('Сервер не повернув оновленого користувача')
  return data.user
}

export async function deleteUser(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/users/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: headersJson(),
  })
  const text = await res.text()
  let data: { error?: string } = {}
  if (text) {
    try {
      data = JSON.parse(text) as { error?: string }
    } catch {
      /* empty or non-JSON body */
    }
  }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося видалити користувача')
}

export async function fetchWorkersDirectory(): Promise<WorkerDirectoryEntry[]> {
  const res = await fetch(apiUrl('/api/users/workers'), { headers: headersJson() })
  const data = (await res.json().catch(() => ({}))) as {
    workers?: WorkerDirectoryEntry[]
    error?: string
  }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося завантажити список працівників')
  return Array.isArray(data.workers) ? data.workers : []
}

export async function fetchSalaryRates(): Promise<SalaryRates> {
  const res = await fetch(apiUrl('/api/users/salary-rates'), { headers: headersJson() })
  const data = (await res.json().catch(() => ({}))) as { rates?: SalaryRates; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося завантажити тарифи')
  if (!data.rates) throw new Error('Сервер не повернув тарифи')
  return data.rates
}

export async function updateSalaryRates(rates: SalaryRates): Promise<SalaryRates> {
  const res = await fetch(apiUrl('/api/users/salary-rates'), {
    method: 'PUT',
    headers: headersJson(true),
    body: JSON.stringify({ rates }),
  })
  const data = (await res.json().catch(() => ({}))) as { rates?: SalaryRates; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося зберегти тарифи')
  if (!data.rates) throw new Error('Сервер не повернув оновлені тарифи')
  return data.rates
}

export async function fetchSalaryReport(month = 'all'): Promise<{
  month: string
  rates: SalaryRates
  totals: SalaryReportTotal[]
  rows: SalaryReportRow[]
}> {
  const q = month && month !== 'all' ? `?month=${encodeURIComponent(month)}` : ''
  const res = await fetch(apiUrl(`/api/users/salary-report${q}`), { headers: headersJson() })
  const data = (await res.json().catch(() => ({}))) as {
    month?: string
    rates?: SalaryRates
    totals?: SalaryReportTotal[]
    rows?: SalaryReportRow[]
    error?: string
  }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося завантажити звіт по ЗП')
  return {
    month: data.month ?? 'all',
    rates: data.rates ?? ({} as SalaryRates),
    totals: Array.isArray(data.totals) ? data.totals : [],
    rows: Array.isArray(data.rows) ? data.rows : [],
  }
}

/** Ручні нарахування: для працівника — лише свої; all=true — усі (лише адмін). */
export async function fetchSalaryManualEntries(all = false): Promise<SalaryManualEntry[]> {
  const q = all ? '?all=1' : ''
  const res = await fetch(apiUrl(`/api/users/salary-manual${q}`), { headers: headersJson() })
  const data = (await res.json().catch(() => ({}))) as { entries?: SalaryManualEntry[]; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося завантажити ручні нарахування')
  return Array.isArray(data.entries) ? data.entries : []
}

export async function createSalaryManual(payload: {
  userId: string
  amountUah: number
  note: string
}): Promise<SalaryManualEntry> {
  const res = await fetch(apiUrl('/api/users/salary-manual'), {
    method: 'POST',
    headers: headersJson(true),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { entry?: SalaryManualEntry; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Не вдалося додати нарахування')
  if (!data.entry) throw new Error('Сервер не повернув запис')
  return data.entry
}
