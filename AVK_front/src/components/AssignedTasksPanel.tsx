import { useCallback, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useAppDialog } from '../context/AppDialogContext'
import { fetchTasks, patchTaskStatus } from '../api'
import { formatOrderTextAsHumanLines } from '../helpers/parseForemanOrders'
import { formatOpenSecondariesForCard } from '../helpers/taskOrderDisplay'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
import type { WorkTask } from '../types/task'
import './AssignedTasksPanel.css'

const ROLES_WITH_PANEL = ['sawyer', 'circular_operator', 'pallet_assembly'] as const

function statusLabel(s: WorkTask['status']) {
  if (s === 'pending') return 'Очікує'
  if (s === 'in_progress') return 'В роботі'
  return 'Виконано'
}

export function AssignedTasksPanel() {
  const { user } = useAuth()
  const { showAlert } = useAppDialog()
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!user || !ROLES_WITH_PANEL.includes(user.role as (typeof ROLES_WITH_PANEL)[number])) return
    setErr(null)
    setLoading(true)
    try {
      const list = await fetchTasks()
      setTasks(list)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка'
      setErr(msg)
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [user])

  useWorkTasksReload(load)

  if (!user || !ROLES_WITH_PANEL.includes(user.role as (typeof ROLES_WITH_PANEL)[number])) {
    return null
  }

  return (
    <section className="panel assignedTasksPanel">
      <h2>Завдання для вас</h2>
      <p className="panelHint">
        Показано лише завдання, які бригадир призначив на ваш етап. Оновіть сторінку після змін.
      </p>
      {loading && <p>Завантаження…</p>}
      {err && (
        <p className="assignedTasksErr">
          {err}
          {err.includes('404') || err.includes('Failed to fetch') ? (
            <>
              {' '}
              Переконайтеся, що API запущено: у корені проєкту <code>npm run dev:server</code> або{' '}
              <code>npm run dev:all</code> (порт 3001).
            </>
          ) : null}
        </p>
      )}
      {!loading && !err && tasks.length === 0 && <p>Немає призначених завдань.</p>}
      <ul className="assignedTasksList">
        {tasks.map((t) => {
          const unit = t.unit === 'cm' ? 'cm' : 'mm'
          const orderRaw = t.orderText.trim()
          const orderPretty =
            orderRaw.length > 0 ? formatOrderTextAsHumanLines(t.orderText, unit) : null
          const orderDisplay = orderPretty ?? orderRaw
          const openSec = formatOpenSecondariesForCard(t)
          return (
            <li key={t.id} className="assignedTasksItem">
              <div className="assignedTasksItemHead">
                <strong>{t.title}</strong>
                <span className={`assignedTasksBadge ${t.status}`}>{statusLabel(t.status)}</span>
              </div>
              {!!orderDisplay && <pre className="assignedTasksOrder">{orderDisplay}</pre>}
              {openSec && <p className="assignedTasksOpenSecondary">{openSec}</p>}
              <label className="assignedTasksStatus">
                Статус:
                <select
                  value={t.status}
                  onChange={async (e) => {
                    const v = e.target.value as WorkTask['status']
                    try {
                      const updated = await patchTaskStatus(t.id, v)
                      setTasks((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
                  } catch (ex) {
                    void showAlert({
                      title: 'Помилка',
                      message: ex instanceof Error ? ex.message : 'Не вдалося оновити статус.',
                    })
                  }
                  }}
                >
                  <option value="pending">Очікує</option>
                  <option value="in_progress">В роботі</option>
                  <option value="done">Виконано</option>
                </select>
              </label>
          </li>
          )
        })}
      </ul>
    </section>
  )
}
