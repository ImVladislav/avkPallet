export type UserRole =
  | 'sawyer'
  | 'circular_operator'
  | 'pallet_assembly'
  | 'foreman'
  | 'admin'

export type AuthUser = {
  id: string
  username: string
  role: UserRole
  displayName: string
  tabs: string[]
}

import { apiUrl } from './apiUrl'

const TOKEN_KEY = 'pallet.auth.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export async function login(username: string, password: string) {
  const res = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = (await res.json()) as { token?: string; user?: AuthUser; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Помилка входу')
  if (!data.token || !data.user) throw new Error('Некоректна відповідь сервера')
  setToken(data.token)
  return data.user
}

export async function fetchMe(): Promise<AuthUser> {
  const token = getToken()
  if (!token) throw new Error('Немає токена')
  const res = await fetch(apiUrl('/api/auth/me'), {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = (await res.json()) as { user?: AuthUser; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Помилка')
  if (!data.user) throw new Error('Немає даних')
  return data.user
}

export function logout() {
  setToken(null)
}
