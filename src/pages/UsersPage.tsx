import { useEffect, useMemo, useState } from 'react'
import {
  createUser,
  deleteUser,
  fetchUsers,
  updateUser,
  type ManagedUser,
  type UserAccessTab,
  type UserRole,
} from '../api'
import { useAuth } from '../context/AuthContext'
import { TAB_LABELS, type TabId } from '../routes/paths'
import './LogsPage.css'

type UserFormState = {
  id?: string
  username: string
  displayName: string
  role: UserRole
  password: string
  tabs: UserAccessTab[]
}

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
]

/** Технічне значення для API: роль у формі не показуємо, доступи задаються вкладками. */
const DEFAULT_API_ROLE: UserRole = 'sawyer'

const EMPTY_FORM: UserFormState = {
  username: '',
  displayName: '',
  role: DEFAULT_API_ROLE,
  password: '',
  tabs: ['logs', 'work_journal', 'band_saw'],
}

function sortedTabs(tabs: string[]): UserAccessTab[] {
  return ALL_TABS.filter((tab) => tabs.includes(tab))
}

export function UsersPage() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [form, setForm] = useState<UserFormState>(EMPTY_FORM)
  const [isEditMode, setIsEditMode] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const formTitle = isEditMode ? 'Редагування користувача' : 'Новий користувач'
  const submitTitle = isEditMode ? 'Зберегти зміни' : 'Створити користувача'

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

  const canSubmit = useMemo(() => {
    const hasBase = form.username.trim().length > 0 && form.displayName.trim().length > 0
    const hasTabs = form.tabs.length > 0
    if (!hasBase || !hasTabs) return false
    if (!isEditMode) return form.password.trim().length > 0
    return true
  }, [form.displayName, form.password, form.tabs.length, form.username, isEditMode])

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setIsEditMode(false)
  }

  const startEdit = (user: ManagedUser) => {
    setForm({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      password: '',
      tabs: sortedTabs(user.tabs),
    })
    setIsEditMode(true)
    setMsg(null)
  }

  const toggleTab = (tab: UserAccessTab, checked: boolean) => {
    setForm((prev) => {
      if (checked) {
        if (prev.tabs.includes(tab)) return prev
        return { ...prev, tabs: [...prev.tabs, tab] }
      }
      return { ...prev, tabs: prev.tabs.filter((item) => item !== tab) }
    })
  }

  const onSubmit = () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    setMsg(null)
    const payload = {
      username: form.username.trim(),
      displayName: form.displayName.trim(),
      role: form.role,
      tabs: sortedTabs(form.tabs),
      ...(form.password.trim() ? { password: form.password.trim() } : {}),
    }
    void (async () => {
      try {
        if (isEditMode && form.id) {
          await updateUser(form.id, payload)
          setMsg('Дані працівника збережено.')
        } else {
          await createUser(payload)
          setMsg('Працівника створено.')
        }
        await reload()
        resetForm()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Помилка збереження користувача')
      } finally {
        setBusy(false)
      }
    })()
  }

  const onDelete = (target: ManagedUser) => {
    if (currentUser?.id === target.id) {
      setError('Не можна видалити власний обліковий запис.')
      return
    }
    const ok = window.confirm(
      `Видалити працівника «${target.displayName}» (${target.username})? Цю дію не можна скасувати.`,
    )
    if (!ok) return
    setDeletingId(target.id)
    setError(null)
    setMsg(null)
    void (async () => {
      try {
        await deleteUser(target.id)
        if (form.id === target.id) resetForm()
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
    <section className="panel">
      <h2 className="logsPageTitle">Працівники</h2>
      <p className="logsLead">
        Створення, редагування та видалення облікових записів. Логін, ім’я, пароль і доступи до розділів.
      </p>
      {error && <p className="birkaMsgErr">{error}</p>}
      {msg && <p className="panelHint">{msg}</p>}

      <div className="logsFormCard">
        <h3 style={{ marginTop: 0 }}>{formTitle}</h3>
        <div className="row">
          <label>
            Логін
            <input
              value={form.username}
              onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
              autoComplete="off"
              readOnly={isEditMode}
              title={isEditMode ? 'Логін не змінюється після створення' : undefined}
              placeholder="напр. operator1"
            />
          </label>
          <label>
            Ім’я
            <input
              value={form.displayName}
              onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
              autoComplete="off"
              placeholder="ПІБ або ім’я"
            />
          </label>
        </div>
        <div className="row">
          <label>
            Пароль {isEditMode ? '(необов’язково)' : ''}
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
              autoComplete="new-password"
              placeholder={isEditMode ? 'залиш порожнім, щоб не змінювати' : 'вкажіть пароль'}
            />
          </label>
        </div>
        <div className="row">
          <div className="lengthField">
            <span className="lengthFieldLabel">Доступи до вкладок</span>
            <div className="usersAccessGrid">
              {ALL_TABS.map((tab) => (
                <label key={tab} className="usersAccessItem">
                  <input
                    type="checkbox"
                    checked={form.tabs.includes(tab)}
                    onChange={(e) => toggleTab(tab, e.target.checked)}
                  />
                  <span>{TAB_LABELS[tab as TabId]}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="row" style={{ marginBottom: 0 }}>
          <button type="button" onClick={onSubmit} disabled={busy || !canSubmit}>
            {busy ? 'Збереження…' : submitTitle}
          </button>
          {isEditMode && (
            <button type="button" className="btnSecondary" onClick={resetForm} disabled={busy}>
              Скасувати редагування
            </button>
          )}
        </div>
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
          <table className="logsTable">
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
                  <td>{user.username}</td>
                  <td>{user.displayName}</td>
                  <td>{sortedTabs(user.tabs).map((tab) => TAB_LABELS[tab as TabId]).join(', ')}</td>
                  <td className="logsActionCell">
                    <div className="usersRowActions">
                      <button
                        type="button"
                        className="btnSecondary"
                        onClick={() => startEdit(user)}
                        disabled={busy || deletingId !== null}
                      >
                        Редагувати
                      </button>
                      <button
                        type="button"
                        className="btnDanger"
                        onClick={() => onDelete(user)}
                        disabled={
                          busy ||
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
