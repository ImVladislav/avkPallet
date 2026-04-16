import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { normalizeAuthUser } from '../auth/normalizeUser'
import type { AuthUser } from '../api'
import * as authApi from '../api'

type AuthState = {
  user: AuthUser | null
  loading: boolean
  error: string | null
  login: (username: string, password: string) => Promise<AuthUser>
  logout: () => void
  canTab: (tab: string) => boolean
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!authApi.getToken()) {
        setLoading(false)
        return
      }
      try {
        const u = await authApi.fetchMe()
        if (!cancelled) setUser(normalizeAuthUser(u))
      } catch {
        authApi.logout()
        if (!cancelled) setUser(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    setError(null)
    const u = await authApi.login(username, password)
    const normalized = normalizeAuthUser(u)
    setUser(normalized)
    return normalized
  }, [])

  const logout = useCallback(() => {
    authApi.logout()
    setUser(null)
  }, [])

  const canTab = useCallback(
    (tab: string) => {
      if (!user) return false
      return user.tabs.includes(tab)
    },
    [user],
  )

  const value = useMemo(
    () => ({ user, loading, error, login, logout, canTab }),
    [user, loading, error, login, logout, canTab],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** @see https://react.dev/learn/reusing-logic-with-custom-hooks */
// eslint-disable-next-line react-refresh/only-export-components -- hook must live next to context
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
