import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { ROUNDWOOD_BUMP_KEY, ROUNDWOOD_CHANGED_EVENT } from '../api'

/** Повторно завантажує кругляк при зміні маршруту, фокусі або події з іншої вкладки. */
export function useRoundwoodReload(reload: () => void) {
  const { pathname } = useLocation()

  useEffect(() => {
    reload()
    const onNotify = () => reload()
    const onStorage = (e: StorageEvent) => {
      if (e.key === ROUNDWOOD_BUMP_KEY) onNotify()
    }
    window.addEventListener(ROUNDWOOD_CHANGED_EVENT, onNotify)
    window.addEventListener('focus', onNotify)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(ROUNDWOOD_CHANGED_EVENT, onNotify)
      window.removeEventListener('focus', onNotify)
      window.removeEventListener('storage', onStorage)
    }
  }, [pathname, reload])
}
