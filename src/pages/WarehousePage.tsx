import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearRoundwoodStock, fetchRoundwoodState, fetchTasks } from '../api'
import { useAuth } from '../context/AuthContext'
import { useRoundwoodReload } from '../hooks/useRoundwoodReload'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
import { stripStockRowsForTask } from '../helpers/stripStockRows'
import type { WorkTask } from '../types/task'
import './WarehousePage.css'

function fmtMm(mm: number): string {
  return `${Math.round(mm)} мм`
}

export function WarehousePage() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [roundwoodCount, setRoundwoodCount] = useState<number | null>(null)
  const [roundwoodErr, setRoundwoodErr] = useState<string | null>(null)
  const [roundwoodBusy, setRoundwoodBusy] = useState(false)
  const seq = useRef(0)
  const rwSeq = useRef(0)

  const canClearRoundwood = user?.role === 'foreman' || user?.role === 'admin'

  const reload = useCallback(() => {
    const n = ++seq.current
    void (async () => {
      try {
        const list = await fetchTasks()
        if (seq.current !== n) return
        setTasks(list)
        setErr(null)
      } catch (e) {
        if (seq.current !== n) return
        setTasks([])
        setErr(e instanceof Error ? e.message : 'Не вдалося завантажити завдання')
      }
    })()
  }, [])

  const reloadRoundwood = useCallback(() => {
    const n = ++rwSeq.current
    void (async () => {
      try {
        const { stock } = await fetchRoundwoodState()
        if (rwSeq.current !== n) return
        setRoundwoodCount(stock.length)
        setRoundwoodErr(null)
      } catch (e) {
        if (rwSeq.current !== n) return
        setRoundwoodCount(null)
        setRoundwoodErr(e instanceof Error ? e.message : 'Не вдалося завантажити кругляк')
      }
    })()
  }, [])

  useEffect(() => {
    reload()
    reloadRoundwood()
  }, [reload, reloadRoundwood])

  useWorkTasksReload(reload)
  useRoundwoodReload(reloadRoundwood)

  const clearRoundwoodRemainder = () => {
    if (!canClearRoundwood) return
    if (
      !window.confirm(
        'Очистити весь залишок кругляка на сервері? Журнал збережеться.',
      )
    ) {
      return
    }
    setRoundwoodBusy(true)
    setRoundwoodErr(null)
    void (async () => {
      try {
        await clearRoundwoodStock()
        await reloadRoundwood()
      } catch (e) {
        setRoundwoodErr(e instanceof Error ? e.message : 'Помилка очищення')
      } finally {
        setRoundwoodBusy(false)
      }
    })()
  }

  const stripRows = useMemo(() => {
    const out: {
      taskId: string
      taskTitle: string
      thicknessMm: number
      undressedStripWidthMm: number | null
      incoming: number
      cutSum: number
      remainder: number
    }[] = []
    for (const t of tasks) {
      for (const r of stripStockRowsForTask(t)) {
        if (r.incoming === 0 && r.cutSum === 0 && r.remainder === 0) continue
        out.push({
          taskId: t.id,
          taskTitle: t.title,
          thicknessMm: r.thicknessMm,
          undressedStripWidthMm: r.undressedStripWidthMm,
          incoming: r.incoming,
          cutSum: r.cutSum,
          remainder: r.remainder,
        })
      }
    }
    return out.sort((a, b) => b.thicknessMm - a.thicknessMm || a.taskTitle.localeCompare(b.taskTitle))
  }, [tasks])

  const stripTotals = useMemo(() => {
    let rem = 0
    let inc = 0
    for (const r of stripRows) {
      rem += r.remainder
      inc += r.incoming
    }
    return { remainder: rem, incoming: inc }
  }, [stripRows])

  const brusRows = useMemo(() => {
    const out: {
      taskId: string
      taskTitle: string
      thicknessMm: number
      qtyNeeded: number
      qtyDone: number
      left: number
    }[] = []
    for (const t of tasks) {
      const circ = t.plan?.circular ?? []
      for (const c of circ) {
        const need = c.qtyNeeded ?? 0
        const done = c.qtyDone ?? 0
        if (need === 0 && done === 0) continue
        out.push({
          taskId: t.id,
          taskTitle: t.title,
          thicknessMm: c.thicknessMm,
          qtyNeeded: need,
          qtyDone: done,
          left: Math.max(0, need - done),
        })
      }
    }
    return out.sort((a, b) => b.thicknessMm - a.thicknessMm || a.taskTitle.localeCompare(b.taskTitle))
  }, [tasks])

  const brusTotals = useMemo(() => {
    let need = 0
    let done = 0
    let left = 0
    for (const r of brusRows) {
      need += r.qtyNeeded
      done += r.qtyDone
      left += r.left
    }
    return { need, done, left }
  }, [brusRows])

  if (!user) return null

  return (
    <section className="panel">
      <h1 className="warehousePageTitle">Склад</h1>
      <p className="warehouseLead">
        Залишки за завданнями на сервері. Прийом кругляка — окрема сторінка; повне очищення кругляка —
        тут (бригадир / адмін).
      </p>
      {err && <p className="birkaMsgErr">{err}</p>}

      <div className="warehouseGrid">
        <div className="warehouseCard">
          <div className="warehouseCardHead">
            <h2>
              Кругляк
              <span className="warehousePill">сервер</span>
            </h2>
            <span className="warehouseCardMeta" title="Прийом — «Прийом кругляка»">
              Прийом окремо
            </span>
          </div>
          <div className="warehouseCardBody">
            {roundwoodErr && <p className="birkaMsgErr">{roundwoodErr}</p>}
            <div className="warehouseKpiRow">
              <div>
                <span className="warehouseKpiLabel">Колод</span>
                <span className="warehouseKpi">{roundwoodCount ?? '—'}</span>
              </div>
              {canClearRoundwood && (
                <button
                  type="button"
                  className="ghost"
                  disabled={roundwoodBusy || roundwoodCount === 0}
                  onClick={clearRoundwoodRemainder}
                >
                  {roundwoodBusy ? '…' : 'Очистити залишок'}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="warehouseCard">
          <div className="warehouseCardHead">
            <h2>
              Дошка
              <span className="warehousePill">смуги</span>
            </h2>
            <span
              className="warehouseCardMeta"
              title="До різу по ширині на ст.2; хорда в торці"
            >
              До ст.2
            </span>
          </div>
          <div className="warehouseCardBody">
            {stripRows.length === 0 ? (
              <p className="warehouseEmpty">Немає смуг у залишку.</p>
            ) : (
              <>
                <table className="warehouseTable">
                  <thead>
                    <tr>
                      <th>Завдання</th>
                      <th>Висота</th>
                      <th>Шир. до різу</th>
                      <th>Було</th>
                      <th>Ст.2</th>
                      <th>Зал.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stripRows.map((r) => (
                      <tr key={`${r.taskId}-${r.thicknessMm}`}>
                        <td>{r.taskTitle}</td>
                        <td className="warehouseNum">{fmtMm(r.thicknessMm)}</td>
                        <td className="warehouseNum">
                          {r.undressedStripWidthMm != null ? fmtMm(r.undressedStripWidthMm) : '—'}
                        </td>
                        <td className="warehouseNum">{r.incoming}</td>
                        <td className="warehouseNum">{r.cutSum}</td>
                        <td
                          className={`warehouseNum ${r.remainder > 0 ? 'warehouseNumWarn' : 'warehouseNumOk'}`}
                        >
                          {r.remainder}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="warehouseFoot">
                  Разом: прийшло <span className="warehouseNum">{stripTotals.incoming}</span>, залишок{' '}
                  <span className="warehouseNum">{stripTotals.remainder}</span> смуг.
                </div>
              </>
            )}
          </div>
        </div>

        <div className="warehouseCard">
          <div className="warehouseCardHead">
            <h2>
              Брус
              <span className="warehousePill">деталі</span>
            </h2>
            <span className="warehouseCardMeta">План циркулярки</span>
          </div>
          <div className="warehouseCardBody">
            {brusRows.length === 0 ? (
              <p className="warehouseEmpty">Немає рядків плану.</p>
            ) : (
              <>
                <table className="warehouseTable">
                  <thead>
                    <tr>
                      <th>Завдання</th>
                      <th>Висота</th>
                      <th>Треба</th>
                      <th>Зробл.</th>
                      <th>Зал.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brusRows.map((r) => (
                      <tr key={`${r.taskId}-${r.thicknessMm}`}>
                        <td>{r.taskTitle}</td>
                        <td className="warehouseNum">{fmtMm(r.thicknessMm)}</td>
                        <td className="warehouseNum">{r.qtyNeeded}</td>
                        <td className="warehouseNum">{r.qtyDone}</td>
                        <td className={`warehouseNum ${r.left > 0 ? 'warehouseNumWarn' : 'warehouseNumOk'}`}>
                          {r.left}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="warehouseFoot">
                  Разом: треба <span className="warehouseNum">{brusTotals.need}</span>, зроблено{' '}
                  <span className="warehouseNum">{brusTotals.done}</span>, залишилось{' '}
                  <span className="warehouseNum">{brusTotals.left}</span>.
                </div>
              </>
            )}
          </div>
        </div>

        <div className="warehouseCard">
          <div className="warehouseCardHead">
            <h2>
              Піддони
              <span className="warehousePill">немає</span>
            </h2>
          </div>
          <div className="warehouseCardBody">
            <p className="warehouseEmpty" style={{ margin: 0 }}>
              Облік піддонів у системі ще не підключений.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
