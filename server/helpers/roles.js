/** @typedef {'sawyer' | 'circular_operator' | 'pallet_assembly' | 'foreman' | 'admin'} Role */

/** Розпиловщик: прийом кругляка + ленточна (товщина смуги вздовж колоди) */
/** Оператор: станок 2 (ширина) + циркулярка (довжина) */
/** Збірка піддонів: піддони + склад дощок */
/** Бригадир і адмін: усі вкладки */

/** @type {Record<string, string[]>} */
export const ROLE_TABS = {
  sawyer: ['logs', 'work_journal', 'band_saw'],
  circular_operator: ['work_journal', 'strip_saw', 'circular_saw'],
  pallet_assembly: ['pallets', 'boards'],
  /** Бригадир (brygadyr) та адмін — завдання та всі етапи */
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
    'users',
  ],
}

/**
 * @param {string} role
 * @param {string} tab
 */
export function roleCanAccessTab(role, tab) {
  const tabs = ROLE_TABS[role]
  if (!tabs) return false
  return tabs.includes(tab)
}
