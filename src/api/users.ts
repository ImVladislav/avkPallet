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
