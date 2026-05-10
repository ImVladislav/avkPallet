import type { AuthUser } from '../api'
import { tabsForRole } from '../config/roleTabs'
import { TAB_ORDER } from '../routes/paths'

function orderTabs(ids: string[]): string[] {
  const set = new Set(ids)
  const ordered: string[] = []
  for (const id of TAB_ORDER) {
    if (set.has(id)) ordered.push(id)
  }
  for (const id of ids) {
    if (!ordered.includes(id)) ordered.push(id)
  }
  return ordered
}

const REQUIRED_ROLE_TABS: Record<string, string[]> = {
  admin: ['users'],
  super_admin: ['users'],
}

const FORBIDDEN_ROLE_TABS: Record<string, string[]> = {
  foreman: ['band_saw', 'strip_saw', 'circular_saw', 'pallets', 'boards'],
}

/**
 * Вкладки меню: якщо API віддав tabs — беремо їх (кастомні доступи), інакше з ролі.
 * Для керівних ролей додаємо обов'язкові вкладки, навіть якщо акаунт має старий урізаний список.
 */
export function normalizeAuthUser(u: AuthUser): AuthUser {
  const roleTrim = String(u.role ?? '').trim().toLowerCase()
  const fromApi = Array.isArray(u.tabs)
    ? u.tabs
        .map((t) => String(t ?? '').trim())
        .filter((t) => t.length > 0)
    : []
  let tabs = fromApi.length > 0 ? fromApi : tabsForRole(roleTrim)
  const forbidden = FORBIDDEN_ROLE_TABS[roleTrim] ?? []
  if (forbidden.length > 0) {
    tabs = tabs.filter((tab) => !forbidden.includes(tab))
  }
  if (roleTrim === 'admin' || roleTrim === 'super_admin') {
    tabs = tabs.filter((tab) => tab !== 'salary')
  } else if (!tabs.includes('salary')) {
    tabs = [...tabs, 'salary']
  }
  for (const required of REQUIRED_ROLE_TABS[roleTrim] ?? []) {
    if (!tabs.includes(required)) tabs = [...tabs, required]
  }
  return { ...u, role: roleTrim as AuthUser['role'], tabs: orderTabs(tabs) }
}
