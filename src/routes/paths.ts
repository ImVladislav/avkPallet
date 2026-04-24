export type TabId =
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

export const TAB_LABELS: Record<TabId, string> = {
  logs: 'Прийом кругляка',
  work_journal: 'Журнал робіт',
  band_saw: 'Стрічкова пила',
  strip_saw: 'Багатопил',
  circular_saw: 'Циркулярка',
  tasks: 'Завдання',
  warehouse: 'Склад',
  pallets: 'Піддони',
  boards: 'Дошки',
  users: 'Працівники',
}

export const TAB_ORDER: TabId[] = [
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

export const TAB_PATHS: Record<TabId, string> = {
  logs: '/logs',
  work_journal: '/work-journal',
  band_saw: '/band-saw',
  strip_saw: '/strip-saw',
  circular_saw: '/circular-saw',
  tasks: '/tasks',
  warehouse: '/warehouse',
  pallets: '/pallets',
  boards: '/boards',
  users: '/users',
}

const PATH_TO_TAB = new Map<string, TabId>(
  (Object.entries(TAB_PATHS) as [TabId, string][]).map(([k, v]) => [v, k]),
)

export function pathToTab(pathname: string): TabId | null {
  const base = pathname.replace(/\/+$/, '') || '/'
  return PATH_TO_TAB.get(base) ?? null
}

export function firstAllowedPath(tabs: string[]): string {
  for (const id of TAB_ORDER) {
    if (tabs.includes(id)) return TAB_PATHS[id]
  }
  return '/logs'
}
