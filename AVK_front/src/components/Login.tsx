import { useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { firstAllowedPath } from '../routes/paths'
import './Login.css'

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      const u = await login(username.trim(), password)
      const target =
        from && from !== '/login' && from.startsWith('/') ? from : firstAllowedPath(u.tabs)
      navigate(target, { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Помилка входу')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="loginPage">
      <div className="loginCard">
        <h1>AVK Pallet</h1>
        <p className="loginSub">Вхід у систему деревообробки</p>
        <form onSubmit={onSubmit}>
          <label>
            Логін
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              disabled={busy}
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          </label>
          {err && <p className="loginErr">{err}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Вхід…' : 'Увійти'}
          </button>
        </form>
        <p className="loginHint">
          Тестові акаунти (пароль <b>1</b>): rozpyl (стрічкова пила), cyrkul (циркулярка), zbirka,{' '}
          <strong>brygadyr</strong> (бригадир, розділ «Завдання» на <code>/tasks</code>), admin
        </p>
      </div>
    </div>
  )
}
