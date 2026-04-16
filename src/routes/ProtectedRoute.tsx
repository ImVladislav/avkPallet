import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import type { TabId } from './paths'
import { firstAllowedPath } from './paths'

export function ProtectedRoute({ tab, children }: { tab: TabId; children: ReactNode }) {
  const { user, loading, canTab } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="appLoading">
        <p>Завантаження…</p>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (!canTab(tab)) {
    return <Navigate to={firstAllowedPath(user.tabs)} replace />
  }

  return <>{children}</>
}
