import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  deleteUser,
  fetchUsers,
  type ManagedUser,
} from '../api'
import { useAuth } from '../context/AuthContext'
import { useAppDialog } from '../context/AppDialogContext'
import { TAB_LABELS, type TabId } from '../routes/paths'
import './LogsPage.css'
import type { UserAccessTab } from '../api'

const ALL_TABS: UserAccessTab[] = [
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
  'salary',
]

function sortedTabs(tabs: string[]): UserAccessTab[] {
  return ALL_TABS.filter((tab) => tabs.includes(tab))
}

export function UsersPage() {
  const navigate = useNavigate()
  const { user: currentUser } = useAuth()
  const { confirm } = useAppDialog()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await fetchUsers()
      setUsers(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося завантажити список користувачів')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const onDelete = async (target: ManagedUser) => {
    if (currentUser?.id === target.id) {
      setError('Не можна видалити власний обліковий запис.')
      return
    }
    const ok = await confirm({
      title: 'Видалити працівника?',
      message: `«${target.displayName}» (${target.username}). Цю дію не можна скасувати.`,
      confirmLabel: 'Видалити',
      cancelLabel: 'Скасувати',
      danger: true,
    })
    if (!ok) return
    setDeletingId(target.id)
    setError(null)
    setMsg(null)
    void (async () => {
      try {
        await deleteUser(target.id)
        setMsg('Працівника видалено.')
        await reload()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Помилка видалення')
      } finally {
        setDeletingId(null)
      }
    })()
  }

  return (
    <section className="panel usersPage">
      <h2 className="logsPageTitle">Працівники</h2>
      <p className="logsLead">
        Створення, редагування та видалення облікових записів. Логін, ім’я, пароль і доступи до розділів.
      </p>
      {error && <p className="birkaMsgErr">{error}</p>}
      {msg && <p className="panelHint">{msg}</p>}
      <div className="row" style={{ marginBottom: 12 }}>
        <button type="button" onClick={() => navigate('/users/new')}>
          Створити користувача
        </button>
        <button type="button" className="btnSecondary" onClick={() => navigate('/users/salary')}>
          ЗП і тарифи
        </button>
      </div>

      <div className="logsTableWrap">
        <h3>Список працівників</h3>
        {loading ? (
          <p className="panelHint" style={{ padding: '12px 14px', margin: 0 }}>
            Завантаження…
          </p>
        ) : users.length === 0 ? (
          <p className="panelHint" style={{ padding: '12px 14px', margin: 0 }}>
            Працівників поки немає.
          </p>
        ) : (
          <table className="logsTable usersTable">
            <thead>
              <tr>
                <th>Логін</th>
                <th>Ім’я</th>
                <th>Доступи</th>
                <th style={{ minWidth: 200 }}>Дії</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td data-label="Логін">{user.username}</td>
                  <td data-label="Ім’я">{user.displayName}</td>
                  <td data-label="Доступи">
                    {sortedTabs(user.tabs)
                      .map((tab) => TAB_LABELS[tab as TabId])
                      .join(', ')}
                  </td>
                  <td className="logsActionCell" data-label="Дії">
                    <div className="usersRowActions">
                      <button
                        type="button"
                        className="btnSecondary"
                        onClick={() => navigate(`/users/${encodeURIComponent(user.id)}/edit`)}
                        disabled={deletingId !== null}
                      >
                        Редагувати
                      </button>
                      <button
                        type="button"
                        className="btnDanger"
                        onClick={() => void onDelete(user)}
                        disabled={
                          deletingId !== null ||
                          currentUser?.id === user.id
                        }
                        title={
                          currentUser?.id === user.id
                            ? 'Не можна видалити власний запис'
                            : 'Видалити працівника'
                        }
                      >
                        {deletingId === user.id ? 'Видалення…' : 'Видалити'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
