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

/**
 * Вкладки меню: якщо API віддав tabs — беремо їх (кастомні доступи), інакше з ролі.
 * Для admin завжди додаємо `users` (Працівники), навіть якщо старий бекенд не повертає цей таб у масиві.
 */
export function normalizeAuthUser(u: AuthUser): AuthUser {
  const roleTrim = String(u.role ?? '').trim().toLowerCase()
  const fromApi = Array.isArray(u.tabs)
    ? u.tabs
        .map((t) => String(t ?? '').trim())
        .filter((t) => t.length > 0)
    : []
  let tabs = fromApi.length > 0 ? fromApi : tabsForRole(roleTrim)
  if (roleTrim === 'admin' && !tabs.includes('users')) {
    tabs = [...tabs, 'users']
  }
  return { ...u, role: roleTrim as AuthUser['role'], tabs: orderTabs(tabs) }
}
