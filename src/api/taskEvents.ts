/** Подія в поточному вікні після зміни завдань на сервері. */
export const WORK_TASKS_CHANGED_EVENT = 'avk-work-tasks-changed'

/** Ключ localStorage для синхронізації між вкладками (спрацьовує `storage` в інших вікнах). */
export const WORK_TASKS_BUMP_KEY = 'avk-tasks-bump'

/** Викликати після створення / оновлення / видалення завдання (з `TasksPage` тощо). */
export function notifyWorkTasksChanged(): void {
  window.dispatchEvent(new Event(WORK_TASKS_CHANGED_EVENT))
  try {
    localStorage.setItem(WORK_TASKS_BUMP_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}
