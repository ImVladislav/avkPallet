import { useCallback, useEffect, useMemo, useState } from 'react'
import { createTask, deleteTask, fetchTasks, patchTaskStatus, updateTask } from '../api'
import { useAuth } from '../context/AuthContext'
import { buildForemanPlan } from '../helpers/foremanPlan'
import {
  formatOrderLinesAsTextCm,
  orderLinesFromDimensionRows,
  parseForemanOrderText,
  type OrderLine,
} from '../helpers/parseForemanOrders'
import { minRadiusMmForOrder } from '../helpers/pickLogForOrder'
import type { WorkTask } from '../types/task'
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
  sawyer: 'Стрічкова пила (розпиловщик)',
  circular_operator: 'Циркулярка',
  pallet_assembly: 'Збірка / склад',
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

function PlanTables({
  plan,
  minRadiusMm,
}: {
  plan: WorkTask['plan']
  minRadiusMm?: number | null
}) {
  const along = 'alongLog' in plan && plan.alongLog ? plan.alongLog : null
  return (
    <div className="foremanResults">
      {along && (
        <>
          <h3>Колоди (можна кілька)</h3>
          <p className="panelHint">
            Замовлення можна виконати з <strong>кількох колод</strong>: сумарна довжина по осі (усі
            заготовки та пропил стрічкової пили між ними) — не менша за значення в таблиці. Окремі колоди
            можуть бути коротші, якщо їх сумарно вистачає; для торця кожна колода повинна мати{' '}
            <strong>R ≥ мінімального радіуса</strong> (див. нижче).
          </p>
          <table className="foremanTable">
            <tbody>
              <tr>
                <th>Всього заготовок</th>
                <td>{along.totalPieces} шт</td>
              </tr>
              <tr>
                <th>Сума довжин (без пропилів)</th>
                <td>{(along.sumQtyTimesLengthMm / 10).toFixed(1)} см</td>
              </tr>
              <tr>
                <th>Пропилів вздовж колоди (оцінка)</th>
                <td>{(along.kerfAlongLogMm / 10).toFixed(1)} см</td>
              </tr>
              <tr>
                <th>Сумарна довжина по осі (мінімум)</th>
                <td>
                  <strong>{(along.minLogLengthMm / 10).toFixed(1)} см</strong> (
                  {along.minLogLengthMm.toFixed(0)} мм)
                </td>
              </tr>
              {minRadiusMm != null && minRadiusMm > 0 && (
                <tr>
                  <th>Мінімальний R колоди (торець)</th>
                  <td>
                    <strong>{(minRadiusMm / 10).toFixed(1)} см</strong> ({minRadiusMm} мм)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
      <h3>Стрічкова пила — по висоті кругляка (торець)</h3>
      <p className="panelHint">
        Для кожної товщини смуги: скільки рядів по колу, скільки дощок з одного повного перерізу,
        скільки таких перерізів по довжині колоди треба, щоб покрити замовлення.
      </p>
      <table className="foremanTable">
        <thead>
          <tr>
            <th>Товщина смуги</th>
            <th>Потрібно шт</th>
            <th>Рядів по висоті</th>
            <th>Дощок з 1 перерізу</th>
            <th>Перерізів (оцінка)</th>
            <th>Надлишок (шт)</th>
          </tr>
        </thead>
        <tbody>
          {plan.band.map((b) => (
            <tr key={b.thicknessMm}>
              <td>{b.thicknessMm} мм</td>
              <td>{b.qtyNeeded}</td>
              <td>{b.rowsAlongHeight}</td>
              <td>{b.boardsFromOneCrossSection}</td>
              <td>{b.crossSectionsNeeded}</td>
              <td>{b.overshootBoards ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Циркулярка — наріз поперек смуги</h3>
      <p className="panelHint">
        Оцінка кількості пропилів циркулярки між дошками на один торець і загалом (з урахуванням
        кількості перерізів).
      </p>
      <table className="foremanTable">
        <thead>
          <tr>
            <th>Товщина</th>
            <th>Готово / потрібно шт</th>
            <th>Сер. хорда / ширина дошки</th>
            <th>Пропилів на 1 переріз</th>
            <th>Пропилів загалом (оцінка)</th>
          </tr>
        </thead>
        <tbody>
          {plan.circular.map((c) => (
            <tr key={c.thicknessMm}>
              <td>{c.thicknessMm} мм</td>
              <td>
                {c.qtyDone ?? 0} / {c.qtyNeeded}
              </td>
              <td>
                {c.avgChordMm.toFixed(0)} / {c.avgBoardWidthMm.toFixed(0)} мм
              </td>
              <td>{c.circularCutsPerCrossSection}</td>
              <td>{c.circularCutsTotalEstimate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type DimRow = {
  id: string
  qty: string
  height: string
  width: string
  length: string
}

function newRow(): DimRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    qty: '1',
    height: '5',
    width: '5',
    length: '120',
  }
}

function orderLinesToDimRows(lines: OrderLine[]): DimRow[] {
  return lines.map((l, i) => ({
    id: `row-${i}-${Math.random().toString(36).slice(2, 9)}`,
    qty: String(l.qty),
    height: String(l.aMm / 10),
    width: String(l.bMm / 10),
    length: String(l.lengthMm / 10),
  }))
}

export function TasksPage() {
  const { user } = useAuth()
  const canManageTasks = user?.role === 'foreman' || user?.role === 'admin'
  const [list, setList] = useState<WorkTask[]>([])
  const [listErr, setListErr] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)

  const [title, setTitle] = useState('')
  const [dimRows, setDimRows] = useState<DimRow[]>(() => [newRow()])
  /** Параметри для buildForemanPlan: за замовчуванням типові; при редагуванні — з завдання. */
  const [tech, setTech] = useState<ForemanTechFields>(DEFAULT_TECH)
  const [assignSawyer, setAssignSawyer] = useState(true)
  const [assignCircular, setAssignCircular] = useState(true)
  const [assignPallet, setAssignPallet] = useState(false)

  const [foremanError, setForemanError] = useState<string | null>(null)
  const [foremanCalc, setForemanCalc] = useState<ReturnType<typeof buildForemanPlan> | null>(null)
  const [lastOrderLines, setLastOrderLines] = useState<OrderLine[] | null>(null)

  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

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

  const minRadiusMm = useMemo(() => {
    if (!lastOrderLines?.length) return null
    return minRadiusMmForOrder(
      lastOrderLines,
      tech.kerfBandMm,
      tech.kerfCircMm,
    )
  }, [lastOrderLines, tech.kerfBandMm, tech.kerfCircMm])

  const cancelEdit = () => {
    setEditingId(null)
    setTitle('')
    setDimRows([newRow()])
    setTech({
      radiusMm: DEFAULT_TECH.radiusMm,
      kerfBandMm: DEFAULT_TECH.kerfBandMm,
      kerfCircMm: DEFAULT_TECH.kerfCircMm,
    })
    setAssignSawyer(true)
    setAssignCircular(true)
    setAssignPallet(false)
    setForemanCalc(null)
    setLastOrderLines(null)
    setForemanError(null)
    setSaveErr(null)
  }

  const startEdit = (task: WorkTask) => {
    setSaveErr(null)
    setForemanError(null)
    const parsed = parseForemanOrderText(task.orderText, task.unit === 'cm' ? 'cm' : 'mm')
    if (!parsed.ok) {
      setSaveErr(`Не вдалося прочитати замовлення: ${parsed.error}`)
      return
    }
    setDimRows(orderLinesToDimRows(parsed.lines))
    setTitle(task.title)
    setTech({
      radiusMm: task.radiusMm,
      kerfBandMm: task.kerfBandMm,
      kerfCircMm: task.kerfCircMm,
    })
    setAssignSawyer(task.assignTo.includes('sawyer'))
    setAssignCircular(task.assignTo.includes('circular_operator'))
    setAssignPallet(task.assignTo.includes('pallet_assembly'))
    setEditingId(task.id)
    setForemanCalc(
      buildForemanPlan(
        parsed.lines,
        task.radiusMm,
        task.kerfBandMm,
        task.kerfCircMm,
      ),
    )
    setLastOrderLines(parsed.lines)
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

  const runForemanCalc = () => {
    setForemanError(null)
    const parsed = orderLinesFromDimensionRows(dimRows, 'cm')
    if (parsed.ok === false) {
      setForemanError(parsed.error)
      setForemanCalc(null)
      setLastOrderLines(null)
      return
    }
    const Rmm = tech.radiusMm
    if (Rmm <= 0) {
      setForemanError('Некоректний радіус у завданні (зверніться до адміна).')
      setForemanCalc(null)
      setLastOrderLines(null)
      return
    }
    const plan = buildForemanPlan(
      parsed.lines,
      Rmm,
      tech.kerfBandMm,
      tech.kerfCircMm,
    )
    setForemanCalc(plan)
    setLastOrderLines(parsed.lines)
    setDimRows(orderLinesToDimRows(parsed.lines))
  }

  const saveTask = async () => {
    setSaveErr(null)
    if (!foremanCalc || !lastOrderLines?.length) {
      setSaveErr('Спочатку натисніть «Переглянути план».')
      return
    }
    const t = title.trim()
    if (!t) {
      setSaveErr('Вкажіть назву завдання.')
      return
    }
    const assignTo: string[] = []
    if (assignSawyer) assignTo.push('sawyer')
    if (assignCircular) assignTo.push('circular_operator')
    if (assignPallet) assignTo.push('pallet_assembly')
    if (assignTo.length === 0) {
      setSaveErr('Оберіть хоча б одного виконавця.')
      return
    }

    setSaving(true)
    try {
      const payload = {
        title: t,
        orderText: formatOrderLinesAsTextCm(lastOrderLines),
        unit: 'cm' as const,
        radiusMm: tech.radiusMm,
        kerfBandMm: tech.kerfBandMm,
        kerfCircMm: tech.kerfCircMm,
        assignTo,
      }
      if (editingId) {
        await updateTask(editingId, payload)
        await loadList()
        cancelEdit()
      } else {
        await createTask(payload)
        await loadList()
        setTitle('')
        setDimRows([newRow()])
        setTech({
          radiusMm: DEFAULT_TECH.radiusMm,
          kerfBandMm: DEFAULT_TECH.kerfBandMm,
          kerfCircMm: DEFAULT_TECH.kerfCircMm,
        })
        setForemanCalc(null)
        setLastOrderLines(null)
        setForemanError(null)
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Не вдалося зберегти')
    } finally {
      setSaving(false)
    }
  }

  const statusLabel = (s: WorkTask['status']) => {
    if (s === 'pending') return 'Очікує'
    if (s === 'in_progress') return 'В роботі'
    return 'Виконано'
  }

  const statusClass = (s: WorkTask['status']) => s

  return (
    <>
      <section className="panel">
        <h2>Завдання — план розпилу</h2>
        <p className="panelHint workflowHint">
          Вкажіть <strong>кількість</strong> і <strong>дві сторони перетину</strong> дошки (см) та{' '}
          <strong>довжину</strong> вздовж волокон (см). Порядок сторін не важливий:{' '}
          <strong>20×40 і 40×20 — одна й та сама деталь</strong> — при «Переглянути план» / збереженні
          такі рядки <strong>об’єднуються</strong>, у таблиці лишаються менша сторона (товщина смуги) і
          більша (ширина бруса). Додайте рядки через «+ Рядок», перегляньте план і збережіть завдання.
        </p>

            <div className="row">
              <label className="foremanTaLabel" style={{ flex: 1, minWidth: '220px' }}>
                Назва завдання
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Напр. Піддон А — комплект дощок"
                />
              </label>
            </div>
            <div className="foremanDimTableWrap">
              <table className="foremanDimTable">
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Скільки шт</th>
                    <th title="Перша сторона перетину, см (порядок з другою неважливий)">
                      Сторона 1, см
                    </th>
                    <th title="Друга сторона перетину, см">Сторона 2, см</th>
                    <th title="Схема після зведення min×max">Перетин</th>
                    <th>Довжина, см</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {dimRows.map((row, idx) => (
                    <tr key={row.id}>
                      <td>{idx + 1}</td>
                      <td>
                        <input
                          className="foremanDimInput"
                          value={row.qty}
                          onChange={(e) => {
                            const v = e.target.value
                            setDimRows((prev) =>
                              prev.map((r) => (r.id === row.id ? { ...r, qty: v } : r)),
                            )
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
                            setDimRows((prev) =>
                              prev.map((r) => (r.id === row.id ? { ...r, height: v } : r)),
                            )
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
                            setDimRows((prev) =>
                              prev.map((r) => (r.id === row.id ? { ...r, width: v } : r)),
                            )
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
                            setDimRows((prev) =>
                              prev.map((r) => (r.id === row.id ? { ...r, length: v } : r)),
                            )
                          }}
                          inputMode="numeric"
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ghost"
                          disabled={dimRows.length <= 1}
                          onClick={() =>
                            setDimRows((prev) => prev.filter((r) => r.id !== row.id))
                          }
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                className="ghost"
                onClick={() => setDimRows((prev) => [...prev, newRow()])}
              >
                + Рядок
              </button>
            </div>
            <p className="panelHint">
              Кому показати завдання:
            </p>
            <div className="row taskAssignRow">
              <label>
                <input
                  type="checkbox"
                  checked={assignSawyer}
                  onChange={(e) => setAssignSawyer(e.target.checked)}
                />{' '}
                {ASSIGN_LABELS.sawyer}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={assignCircular}
                  onChange={(e) => setAssignCircular(e.target.checked)}
                />{' '}
                {ASSIGN_LABELS.circular_operator}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={assignPallet}
                  onChange={(e) => setAssignPallet(e.target.checked)}
                />{' '}
                {ASSIGN_LABELS.pallet_assembly}
              </label>
            </div>
            <div className="row">
              <button type="button" onClick={runForemanCalc}>
                Переглянути план
              </button>
              <button type="button" className="ghost" onClick={saveTask} disabled={saving}>
                {saving
                  ? 'Збереження…'
                  : editingId
                    ? 'Зберегти зміни'
                    : 'Зберегти завдання'}
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
            {foremanCalc && (
              <PlanTables plan={foremanCalc} minRadiusMm={minRadiusMm} />
            )}
      </section>

      <section className="panel taskList">
        <h2>Список завдань</h2>
        {loadingList && <p>Завантаження…</p>}
        {listErr && <p className="birkaMsgErr">{listErr}</p>}
        {!loadingList && list.length === 0 && !listErr && <p>Поки немає збережених завдань.</p>}

        {list.map((task) => {
          return (
            <article key={task.id} className="taskCard">
              <div className="taskCardHead">
                <h3>{task.title}</h3>
                <div className="taskCardHeadRight">
                  {canManageTasks && (
                    <div className="taskCardActions">
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => startEdit(task)}
                      >
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
                {new Date(task.createdAt).toLocaleString()} · автор: {task.createdBy.username} · R{' '}
                {task.unit === 'cm'
                  ? `${(task.radiusMm / 10).toFixed(1)} см`
                  : `${task.radiusMm} мм`}{' '}
                · пропили: {task.kerfBandMm} / {task.kerfCircMm} мм · замовлення: {task.unit}
              </p>
              <p className="taskAssign">
                <strong>Для кого:</strong>{' '}
                {task.assignTo.map((r) => ASSIGN_LABELS[r] ?? r).join(', ')}
              </p>
              <pre className="taskOrderPreview">{task.orderText.trim()}</pre>
              <p className="panelHint taskOrderFmtHint">
                Формат рядка: <strong>кількість · менша сторона перетину · більша сторона · довжина</strong> у{' '}
                {task.unit === 'cm' ? 'сантиметрах' : 'міліметрах'}. Пару сторін можна було ввести в
                довільному порядку — у збереженому тексті вони зведені (min/max). Перше число — завжди{' '}
                <strong>кількість</strong>.
              </p>

              <details className="taskPreview">
                <summary>План розпилу (таблиці)</summary>
                <PlanTables plan={task.plan} />
              </details>

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
