import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { WORK_TASKS_BUMP_KEY, WORK_TASKS_CHANGED_EVENT } from '../api'

/**
 * Повторно викликає `reload` при відкритті маршруту, фокусі вікна, зміні завдань у цьому ж вікні
 * або в іншій вкладці (через localStorage).
 */
export function useWorkTasksReload(reload: () => void) {
  const { pathname } = useLocation()

  useEffect(() => {
    reload()
    const onNotify = () => reload()
    const onStorage = (e: StorageEvent) => {
      if (e.key === WORK_TASKS_BUMP_KEY) onNotify()
    }
    window.addEventListener(WORK_TASKS_CHANGED_EVENT, onNotify)
    window.addEventListener('focus', onNotify)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(WORK_TASKS_CHANGED_EVENT, onNotify)
      window.removeEventListener('focus', onNotify)
      window.removeEventListener('storage', onStorage)
    }
  }, [pathname, reload])
}
