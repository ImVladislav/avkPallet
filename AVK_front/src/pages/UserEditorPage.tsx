import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  createUser,
  fetchUsers,
  updateUser,
  type UserAccessTab,
  type UserRole,
} from '../api'
import { TAB_LABELS, type TabId } from '../routes/paths'
import './LogsPage.css'

type UserFormState = {
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
  'salary',
]

const DEFAULT_API_ROLE: UserRole = 'sawyer'

const EMPTY_FORM: UserFormState = {
  username: '',
  displayName: '',
  role: DEFAULT_API_ROLE,
  password: '',
  tabs: ['band_saw', 'salary'],
}

function sortedTabs(tabs: string[]): UserAccessTab[] {
  return ALL_TABS.filter((tab) => tabs.includes(tab))
}

export function UserEditorPage() {
  const navigate = useNavigate()
  const params = useParams<{ userId: string }>()
  const userId = params.userId
  const isEditMode = Boolean(userId)

  const [form, setForm] = useState<UserFormState>(EMPTY_FORM)
  const [loading, setLoading] = useState(isEditMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const formTitle = isEditMode ? 'Редагування працівника' : 'Створення працівника'
  const submitTitle = isEditMode ? 'Зберегти зміни' : 'Створити користувача'

  useEffect(() => {
    if (!isEditMode || !userId) return
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const users = await fetchUsers()
        const target = users.find((item) => item.id === userId)
        if (!target) {
          setError('Працівника не знайдено')
          return
        }
        setForm({
          username: target.username,
          displayName: target.displayName,
          role: target.role,
          password: '',
          tabs: sortedTabs(target.tabs),
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не вдалося завантажити дані працівника')
      } finally {
        setLoading(false)
      }
    })()
  }, [isEditMode, userId])

  const canSubmit = useMemo(() => {
    const hasBase = form.username.trim().length > 0 && form.displayName.trim().length > 0
    const hasTabs = form.tabs.length > 0
    if (!hasBase || !hasTabs) return false
    if (!isEditMode) return form.password.trim().length > 0
    return true
  }, [form.displayName, form.password, form.tabs.length, form.username, isEditMode])

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
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    const payload = {
      username: form.username.trim(),
      displayName: form.displayName.trim(),
      role: form.role,
      tabs: sortedTabs(form.tabs),
      ...(form.password.trim() ? { password: form.password.trim() } : {}),
    }
    void (async () => {
      try {
        if (isEditMode && userId) {
          await updateUser(userId, payload)
        } else {
          await createUser(payload)
        }
        navigate('/users')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Помилка збереження користувача')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <section className="panel usersPage">
      <h2 className="logsPageTitle">{formTitle}</h2>
      {error && <p className="birkaMsgErr">{error}</p>}
      {loading ? (
        <p className="panelHint">Завантаження…</p>
      ) : (
        <div className="logsFormCard">
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
            <button type="button" className="btnSecondary" onClick={() => navigate('/users')} disabled={busy}>
              Назад до списку
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
