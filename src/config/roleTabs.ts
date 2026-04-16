import type { UserRole } from '../api'

/** Має збігатися з server/helpers/roles.js — меню бургера будується з цих списків */
export const ROLE_TABS: Record<UserRole, readonly string[]> = {
  sawyer: ['logs', 'work_journal', 'band_saw'],
  circular_operator: ['work_journal', 'strip_saw', 'circular_saw'],
  pallet_assembly: ['pallets', 'boards'],
  foreman: [
    'logs',
    'work_journal',
    'band_saw',
    'strip_saw',
    'circular_saw',
    'tasks',
    'warehouse',
    'pallets',
    'boards',
  ],
  admin: [
    'logs',
    'work_journal',
    'band_saw',
    'strip_saw',
    'circular_saw',
    'tasks',
    'warehouse',
    'pallets',
    'boards',
  ],
}

export function tabsForRole(role: string): string[] {
  const key = String(role ?? '').trim() as UserRole
  const row = ROLE_TABS[key]
  return row ? [...row] : []
}
