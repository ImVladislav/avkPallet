import type { AuthUser } from '../api'
import { tabsForRole } from '../config/roleTabs'

/** Підставляє вкладки з ролі, щоб меню не ламалося через некоректний масив tabs з API */
export function normalizeAuthUser(u: AuthUser): AuthUser {
  const roleTrim = String(u.role ?? '').trim().toLowerCase()
  const fromRole = tabsForRole(roleTrim)
  if (fromRole.length > 0) {
    return { ...u, role: roleTrim as AuthUser['role'], tabs: fromRole }
  }
  const fallback = Array.isArray(u.tabs) ? u.tabs : []
  return { ...u, tabs: fallback }
}
