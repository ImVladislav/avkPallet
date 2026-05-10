import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  createTask,
  deleteTask,
  fetchTasks,
  patchTaskStatus,
  updateTask,
} from '../api'
import { useAuth } from '../context/AuthContext'
import { PALLET_RECIPES } from '../helpers/palletRecipes'
import {
  formatOrderLinesAsTextCm,
  orderLinesFromDimensionRows,
  parseForemanOrderText,
  type OrderLine,
} from '../helpers/parseForemanOrders'
import type { TaskDimensionRow, TaskKind, WorkTask } from '../types/task'
import './TasksPage.css'

/** Технічні параметри плану (торець + пропили) — без полів у формі; типові для цеху. */
type ForemanTechFields = {
  radiusMm: number
  kerfBandMm: number
  kerfCircMm: number
}

const DEFAULT_TECH: ForemanTechFields = {
  radiusMm: 180,
  kerfBandMm: 4,
  kerfCircMm: 3,
}

const ASSIGN_LABELS: Record<string, string> = {
  sawyer: 'Станок 1 (стрічкова)',
  circular_operator: 'Станок 2 / циркулярка',
  pallet_assembly: 'Збірка піддонів',
}

const TASK_KIND_LABELS: Record<TaskKind, string> = {
  resaw: 'Розпил',
  circular: 'Циркулярка',
  pallets: 'Збірка піддонів',
}

const FORM_TABS: { id: TaskKind; hint: string }[] = [
  { id: 'resaw', hint: 'Стрічкова пила та багатопил: лише перетин (сторона 1 × сторона 2). Довжину вказують на вкладці циркулярки.' },
  { id: 'circular', hint: 'Наріз по довжині на циркулярці (розміри та довжина).' },
  { id: 'pallets', hint: 'Збірка піддонів: тип та кількість (окремо від циркулярки).' },
]

function taskKindOf(task: WorkTask): TaskKind {
  return task.taskKind ?? 'resaw'
}

/** Малюнок перетину дошки (прямокутник); сторони 20×40 і 40×20 дають той самий вигляд. */
function BoardCrossPreview({ sideACm, sideBCm }: { sideACm: string; sideBCm: string }) {
  const pa = Number(String(sideACm).replace(',', '.'))
  const pb = Number(String(sideBCm).replace(',', '.'))
  const a = Number.isFinite(pa) && pa > 0 ? pa : 0
  const b = Number.isFinite(pb) && pb > 0 ? pb : 0
  const min = Math.min(a, b)
  const max = Math.max(a, b)
  if (min <= 0 || max <= 0) {
    return (
      <span className="foremanBoardPreviewEmpty" title="Введіть дві сторони перетину, см">
        —
      </span>
    )
  }
  const vb = 56
  const scale = vb / max
  const rw = max * scale
  const rh = min * scale
  const ox = (vb - rw) / 2
  const oy = (vb - rh) / 2
  return (
    <div
      className="foremanBoardPreview"
      title={`Перетин дошки: ${min}×${max} см (менша × більша сторона; для плану це товщина × ширина)`}
    >
      <svg
        viewBox={`0 0 ${vb} ${vb}`}
        width={52}
        height={52}
        className="foremanBoardPreviewSvg"
        aria-hidden
      >
        <rect x={ox} y={oy} width={rw} height={rh} className="foremanBoardPreviewRect" rx={1.5} />
      </svg>
      <span className="foremanBoardPreviewLabel">
        {min}×{max} см
      </span>
    </div>
  )
}

type DimRow = {
  id: string
  kind: 'main' | 'secondary'
  qty: string
  height: string
  width: string
  length: string
}

function newRow(kind: 'main' | 'secondary' = 'main', withBoardLength = true): DimRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    qty: '1',
    height: '5',
    width: '5',
    length: withBoardLength ? '120' : '',
  }
}

function orderLinesToDimRows(lines: OrderLine[]): DimRow[] {
  return lines.map((l, i) => ({
    id: `row-${i}-${Math.random().toString(36).slice(2, 9)}`,
    kind: 'main',
    qty: String(l.qty),
    height: String(l.aMm / 10),
    width: String(l.bMm / 10),
    length: String(l.lengthMm / 10),
  }))
}

function storedRowsToDimRows(rows: TaskDimensionRow[]): DimRow[] {
  return rows.map((r, i) => ({
    id: `stored-${i}-${Math.random().toString(36).slice(2, 9)}`,
    kind: r.kind === 'secondary' ? 'secondary' : 'main',
    qty: String(r.qty ?? ''),
    height: String(r.height ?? ''),
    width: String(r.width ?? ''),
    length: String(r.length ?? ''),
  }))
}

function dimRowsToStoredRows(rows: DimRow[]): TaskDimensionRow[] {
  return rows.map((r) => ({
    kind: r.kind,
    qty: r.qty,
    height: r.height,
    width: r.width,
    length: r.length,
  }))
}

function allRowsAsMain(rows: DimRow[]): DimRow[] {
  return rows.map((r) => ({ ...r, kind: 'main' as const }))
}

export function TasksPage() {
  const { user } = useAuth()
  const canManageTasks =
    user?.role === 'foreman' || user?.role === 'admin' || user?.role === 'super_admin'
  const [list, setList] = useState<WorkTask[]>([])
  const [listErr, setListErr] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)

  const [formTab, setFormTab] = useState<TaskKind>('resaw')
  const [resawTitle, setResawTitle] = useState('')
  const [resawRows, setResawRows] = useState<DimRow[]>(() => [newRow('main')])
  const [circTitle, setCircTitle] = useState('')
  const [circRows, setCircRows] = useState<DimRow[]>(() => [newRow('main')])
  const [palTitle, setPalTitle] = useState('')
  const [palPalletTypeId, setPalPalletTypeId] = useState(PALLET_RECIPES[0]?.id ?? '')
  const [palPalletQty, setPalPalletQty] = useState('1')

  const [tech, setTech] = useState<ForemanTechFields>(DEFAULT_TECH)
  const [foremanError, setForemanError] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const tabsScrollRef = useRef<HTMLDivElement | null>(null)

  const filteredList = useMemo(
    () => list.filter((t) => taskKindOf(t) === formTab),
    [list, formTab],
  )

  const loadList = useCallback(async () => {
    setListErr(null)
    setLoadingList(true)
    try {
      const tasks = await fetchTasks()
      setList(tasks)
    } catch (e) {
      setListErr(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    const wrap = tabsScrollRef.current
    const active = wrap?.querySelector('.taskFormTabActive') as HTMLElement | undefined
    if (!active) return
    const horizontalTabs = window.matchMedia('(min-width: 641px)').matches
    if (horizontalTabs) {
      active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    } else {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [formTab])

  const resetResawForm = () => {
    setResawTitle('')
    setResawRows([newRow('main')])
  }
  const resetCircForm = () => {
    setCircTitle('')
    setCircRows([newRow('main')])
  }
  const resetPalForm = () => {
    setPalTitle('')
    setPalPalletTypeId(PALLET_RECIPES[0]?.id ?? '')
    setPalPalletQty('1')
  }

  const cancelEdit = () => {
    setEditingId(null)
    resetResawForm()
    resetCircForm()
    resetPalForm()
    setTech({
      radiusMm: DEFAULT_TECH.radiusMm,
      kerfBandMm: DEFAULT_TECH.kerfBandMm,
      kerfCircMm: DEFAULT_TECH.kerfCircMm,
    })
    setForemanError(null)
    setSaveErr(null)
  }

  const startEdit = (task: WorkTask) => {
    setSaveErr(null)
    setForemanError(null)
    const kind = taskKindOf(task)
    setFormTab(kind)
    setTech({
      radiusMm: task.radiusMm,
      kerfBandMm: task.kerfBandMm,
      kerfCircMm: task.kerfCircMm,
    })
    setEditingId(task.id)

    if (kind === 'pallets') {
      setPalTitle(task.title)
      setPalPalletTypeId(task.palletTarget?.palletTypeId ?? PALLET_RECIPES[0]?.id ?? '')
      setPalPalletQty(String(task.palletTarget?.qty ?? 1))
      return
    }

    const parsed = parseForemanOrderText(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
    if (!parsed.ok) {
      setSaveErr(`Не вдалося прочитати замовлення: ${parsed.error}`)
      setEditingId(null)
      return
    }
    const storedRows = Array.isArray(task.dimensionRows) ? storedRowsToDimRows(task.dimensionRows) : []
    const baseRows = storedRows.length > 0 ? storedRows : orderLinesToDimRows(parsed.lines)
    if (kind === 'circular') {
      setCircTitle(task.title)
      setCircRows(allRowsAsMain(baseRows))
      return
    }
    setResawTitle(task.title)
    const mains = baseRows.filter((r) => r.kind === 'main')
    setResawRows(allRowsAsMain(mains.length > 0 ? mains : baseRows))
  }

  const removeTask = async (id: string) => {
    if (!window.confirm('Видалити це завдання? Дію не можна скасувати.')) return
    try {
      await deleteTask(id)
      if (editingId === id) cancelEdit()
      await loadList()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Помилка видалення')
    }
  }

  const saveTask = async () => {
    setSaveErr(null)
    setForemanError(null)
    if (tech.radiusMm <= 0) {
      setForemanError('Некоректний радіус у завданні.')
      return
    }

    const techPayload = {
      unit: 'cm' as const,
      radiusMm: tech.radiusMm,
      kerfBandMm: tech.kerfBandMm,
      kerfCircMm: tech.kerfCircMm,
    }

    setSaving(true)
    try {
      if (formTab === 'pallets') {
        const t = palTitle.trim()
        if (!t) {
          setSaveErr('Вкажіть назву завдання.')
          return
        }
        const recipe = PALLET_RECIPES.find((r) => r.id === palPalletTypeId) ?? PALLET_RECIPES[0]
        const q = Math.round(Number(palPalletQty) || 0)
        if (!Number.isFinite(q) || q < 1) {
          setSaveErr('Кількість піддонів має бути ≥ 1.')
          return
        }
        const payload = {
          title: t,
          orderText: '',
          taskKind: 'pallets' as const,
          palletTarget: {
            palletTypeId: recipe.id,
            palletTypeName: recipe.name,
            qty: q,
          },
          ...techPayload,
        }
        if (editingId) {
          await updateTask(editingId, payload)
        } else {
          await createTask(payload)
        }
        await loadList()
        cancelEdit()
        return
      }

      const rows = formTab === 'resaw' ? resawRows : circRows
      const titleText = (formTab === 'resaw' ? resawTitle : circTitle).trim()
      if (!titleText) {
        setSaveErr('Вкажіть назву завдання.')
        return
      }

      const parsed = orderLinesFromDimensionRows(rows, 'cm')
      if (parsed.ok === false) {
        setForemanError(parsed.error)
        return
      }

      const payload = {
        title: titleText,
        orderText: formatOrderLinesAsTextCm(parsed.lines),
        taskKind: formTab,
        dimensionRows: dimRowsToStoredRows(rows.map((r) => ({ ...r, kind: 'main' }))),
        ...techPayload,
      }

      if (editingId) {
        await updateTask(editingId, payload)
      } else {
        await createTask(payload)
      }
      await loadList()
      cancelEdit()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Не вдалося зберегти')
    } finally {
      setSaving(false)
    }
  }

  const changeFormTab = (tab: TaskKind) => {
    if (editingId) return
    setFormTab(tab)
    setForemanError(null)
    setSaveErr(null)
  }

  const statusLabel = (s: WorkTask['status']) => {
    if (s === 'pending') return 'Очікує'
    if (s === 'in_progress') return 'В роботі'
    return 'Виконано'
  }

  const statusClass = (s: WorkTask['status']) => s

  const renderDimSection = (
    rows: DimRow[],
    setRows: Dispatch<SetStateAction<DimRow[]>>,
    lengthHeader: string,
  ) => (
    <div className="foremanDimTableWrap">
      <table className="foremanDimTable">
        <thead>
          <tr>
            <th>№</th>
            <th>Скільки шт</th>
            <th title="Перша сторона перетину, см">Сторона 1, см</th>
            <th title="Друга сторона перетину, см">Сторона 2, см</th>
            <th>Перетин</th>
            <th>{lengthHeader}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.id}>
              <td>{idx + 1}</td>
              <td>
                <input
                  className="foremanDimInput"
                  value={row.qty}
                  onChange={(e) => {
                    const v = e.target.value
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, qty: v } : r)))
                  }}
                  inputMode="numeric"
                />
              </td>
              <td>
                <input
                  className="foremanDimInput"
                  value={row.height}
                  onChange={(e) => {
                    const v = e.target.value
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, height: v } : r)))
                  }}
                  inputMode="decimal"
                />
              </td>
              <td>
                <input
                  className="foremanDimInput"
                  value={row.width}
                  onChange={(e) => {
                    const v = e.target.value
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, width: v } : r)))
                  }}
                  inputMode="decimal"
                />
              </td>
              <td className="foremanBoardPreviewCell">
                <BoardCrossPreview sideACm={row.height} sideBCm={row.width} />
              </td>
              <td>
                <input
                  className="foremanDimInput"
                  value={row.length}
                  onChange={(e) => {
                    const v = e.target.value
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, length: v } : r)))
                  }}
                  inputMode="numeric"
                />
              </td>
              <td>
                <button
                  type="button"
                  className="ghost"
                  disabled={rows.length <= 1}
                  onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="ghost" onClick={() => setRows((prev) => [...prev, newRow('main')])}>
        + Рядок
      </button>
    </div>
  )

  const techBlock = (
    <div className="foremanTechRow row">
      <label>
        R колоди, мм
        <input
          type="number"
          value={tech.radiusMm}
          min={1}
          onChange={(e) => setTech((x) => ({ ...x, radiusMm: Number(e.target.value) || 0 }))}
        />
      </label>
      <label>
        Пропил стрічки, мм
        <input
          type="number"
          value={tech.kerfBandMm}
          min={0}
          onChange={(e) => setTech((x) => ({ ...x, kerfBandMm: Number(e.target.value) || 0 }))}
        />
      </label>
      <label>
        Пропил цирк., мм
        <input
          type="number"
          value={tech.kerfCircMm}
          min={0}
          onChange={(e) => setTech((x) => ({ ...x, kerfCircMm: Number(e.target.value) || 0 }))}
        />
      </label>
    </div>
  )

  return (
    <>
      <section className="panel">
        <div className="taskFormTabsChrome">
          <div className="taskFormTabsScroll" ref={tabsScrollRef}>
            <div className="taskFormTabsRow" role="tablist" aria-label="Тип завдання">
              {FORM_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={formTab === tab.id}
                  className={`taskFormTab ${formTab === tab.id ? 'taskFormTabActive' : ''}`}
                  disabled={!!editingId && formTab !== tab.id}
                  title={tab.hint}
                  onClick={() => changeFormTab(tab.id)}
                >
                  {TASK_KIND_LABELS[tab.id]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="taskFormBody">
          <p className="panelHint">{FORM_TABS.find((t) => t.id === formTab)?.hint}</p>

          {formTab === 'resaw' && (
            <>
              <div className="row">
                <label className="foremanTaLabel" style={{ flex: 1, minWidth: '220px' }}>
                  Назва завдання
                  <input
                    value={resawTitle}
                    onChange={(e) => setResawTitle(e.target.value)}
                    placeholder="Напр. Комплект смуг для замовлення"
                  />
                </label>
              </div>
              {techBlock}
              <h3 style={{ margin: '4px 0 8px' }}>Розміри (станок 1 та 2)</h3>
              {renderDimSection(resawRows, setResawRows, 'Довжина заготовки, см')}
            </>
          )}

          {formTab === 'circular' && (
            <>
              <div className="row">
                <label className="foremanTaLabel" style={{ flex: 1, minWidth: '220px' }}>
                  Назва завдання
                  <input
                    value={circTitle}
                    onChange={(e) => setCircTitle(e.target.value)}
                    placeholder="Напр. Підрізка брусів по довжині"
                  />
                </label>
              </div>
              {techBlock}
              <h3 style={{ margin: '4px 0 8px' }}>Дошки (сторона 1 × сторона 2 × довжина)</h3>
              {renderDimSection(circRows, setCircRows, 'Довжина, см')}
            </>
          )}

          {formTab === 'pallets' && (
            <>
              <div className="row">
                <label className="foremanTaLabel" style={{ flex: 1, minWidth: '220px' }}>
                  Назва завдання
                  <input
                    value={palTitle}
                    onChange={(e) => setPalTitle(e.target.value)}
                    placeholder="Напр. Збірка EUR на відвантаження"
                  />
                </label>
              </div>
              <h3 style={{ margin: '4px 0 8px' }}>Піддон та обсяг</h3>
              <div className="row foremanPalletPickRow">
                <label>
                  Тип піддону
                  <select
                    value={palPalletTypeId}
                    onChange={(e) => setPalPalletTypeId(e.target.value)}
                  >
                    {PALLET_RECIPES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Кількість піддонів
                  <input
                    value={palPalletQty}
                    onChange={(e) => setPalPalletQty(e.target.value)}
                    inputMode="numeric"
                    min={1}
                  />
                </label>
              </div>
              <p className="panelHint">
                План розпилу для такого завдання порожній — облік лише на сторінці збірки піддонів.
              </p>
            </>
          )}

          <div className="row">
            <button type="button" className="ghost" onClick={saveTask} disabled={saving}>
              {saving ? 'Збереження…' : editingId ? 'Зберегти зміни' : 'Зберегти завдання'}
            </button>
            {editingId && (
              <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>
                Скасувати редагування
              </button>
            )}
          </div>
          {editingId && (
            <p className="panelHint taskEditBanner">
              Редагується завдання зі списку нижче. Після збереження форма очиститься.
            </p>
          )}
          {foremanError && <p className="birkaMsgErr">{foremanError}</p>}
          {saveErr && <p className="birkaMsgErr">{saveErr}</p>}
        </div>
      </section>

      <section className="panel taskList">
        <h2>Список: {TASK_KIND_LABELS[formTab]}</h2>
        {loadingList && <p>Завантаження…</p>}
        {listErr && <p className="birkaMsgErr">{listErr}</p>}
        {!loadingList && filteredList.length === 0 && !listErr && (
          <p>Немає завдань цього типу. Перемкніть вкладку зверху або створіть нове.</p>
        )}

        {filteredList.map((task) => {
          return (
            <article key={task.id} className="taskCard">
              <div className="taskCardHead">
                <h3>{task.title}</h3>
                <div className="taskCardHeadRight">
                  {canManageTasks && (
                    <div className="taskCardActions">
                      <button type="button" className="ghost small" onClick={() => startEdit(task)}>
                        Редагувати
                      </button>
                      <button
                        type="button"
                        className="ghost small danger"
                        onClick={() => removeTask(task.id)}
                      >
                        Видалити
                      </button>
                    </div>
                  )}
                  <span className={`taskStatusBadge ${statusClass(task.status)}`}>
                    {statusLabel(task.status)}
                  </span>
                </div>
              </div>
              <p className="taskMeta">
                <span className="taskKindBadge">{TASK_KIND_LABELS[taskKindOf(task)]}</span>
                {' · '}
                {new Date(task.createdAt).toLocaleString()} · автор: {task.createdBy.username} · R{' '}
                {task.unit === 'cm'
                  ? `${(task.radiusMm / 10).toFixed(1)} см`
                  : `${task.radiusMm} мм`}
                · пропили: {task.kerfBandMm} / {task.kerfCircMm} мм
              </p>
              {taskKindOf(task) === 'pallets' && task.palletTarget && (
                <p className="taskPalletTarget">
                  <strong>Піддони:</strong> {task.palletTarget.palletTypeName} × {task.palletTarget.qty}{' '}
                  шт
                </p>
              )}
              <p className="taskAssign">
                <strong>Вид робіт:</strong>{' '}
                {task.assignTo.map((r) => ASSIGN_LABELS[r] ?? r).join(', ')}
              </p>
              {task.orderText.trim() && <pre className="taskOrderPreview">{task.orderText.trim()}</pre>}
              {(taskKindOf(task) === 'resaw' || taskKindOf(task) === 'circular') && (
                <p className="panelHint taskOrderFmtHint">
                  Формат рядка: <strong>кількість · сторона 1 · сторона 2 · довжина</strong> у см (у тексті
                  збереження сторони зведені min/max).
                </p>
              )}

              <div className="taskStatusRow">
                <label>
                  Статус:
                  <select
                    value={task.status}
                    onChange={async (e) => {
                      const v = e.target.value as WorkTask['status']
                      try {
                        const updated = await patchTaskStatus(task.id, v)
                        setList((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
                      } catch (err) {
                        alert(err instanceof Error ? err.message : 'Помилка')
                      }
                    }}
                  >
                    <option value="pending">Очікує</option>
                    <option value="in_progress">В роботі</option>
                    <option value="done">Виконано</option>
                  </select>
                </label>
              </div>
            </article>
          )
        })}
      </section>
    </>
  )
}
