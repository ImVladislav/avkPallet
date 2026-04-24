import { ROLE_TABS } from './roles.js'

/** Як на фронті: порядок вкладок у меню */
export const TAB_ORDER = [
  'logs',
  'work_journal',
  'band_saw',
  'strip_saw',
  'circular_saw',
  'tasks',
  'warehouse',
  'pallets',
  'boards',
  'users',
]

const TAB_SET = new Set(TAB_ORDER)

/**
 * @param {unknown} tabs
 * @returns {string[]}
 */
export function sanitizeTabs(tabs) {
  if (!Array.isArray(tabs)) return []
  const raw = tabs.map((t) => String(t ?? '').trim()).filter((t) => t.length > 0)
  return TAB_ORDER.filter((id) => raw.includes(id))
}

/**
 * Публічний профіль для API (без пароля).
 * @param {{ id: string, username: string, role: string, displayName: string, tabs?: string[] }} u
 */
export function publicUser(u) {
  const role = String(u.role ?? '').trim().toLowerCase()
  const fromFile = sanitizeTabs(u.tabs)
  const fromRole = ROLE_TABS[role] ?? []
  let tabs = fromFile.length > 0 ? fromFile : [...fromRole]
  if (role === 'admin' && !tabs.includes('users')) {
    tabs = [...tabs, 'users']
  }
  const ordered = []
  const seen = new Set()
  for (const id of TAB_ORDER) {
    if (tabs.includes(id) && !seen.has(id)) {
      ordered.push(id)
      seen.add(id)
    }
  }
  for (const id of tabs) {
    if (!seen.has(id) && TAB_SET.has(id)) {
      ordered.push(id)
      seen.add(id)
    }
  }
  return {
    id: u.id,
    username: u.username,
    role: tabs.length ? role : u.role,
    displayName: u.displayName,
    tabs: ordered,
  }
}
