import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildPallets, fetchTasks } from '../api'
import { useAuth } from '../context/AuthContext'
import { fmtMaterial, palletMaterialKey, PALLET_RECIPES } from '../helpers/palletRecipes'
import { useWorkTasksReload } from '../hooks/useWorkTasksReload'
import type { PalletMaterialLine, WorkTask } from '../types/task'
import './PalletsPage.css'

function stockForTask(task: WorkTask): Map<string, number> {
  const stock = new Map<string, number>()
  for (const cut of task.circularSaw?.cuts ?? []) {
    const qty = Math.round(Number(cut.qty))
    if (!Number.isFinite(qty) || qty <= 0) continue
    const key = palletMaterialKey(cut)
    stock.set(key, (stock.get(key) ?? 0) + qty)
  }
  for (const build of task.palletAssembly?.builds ?? []) {
    const buildQty = Math.max(1, Math.round(Number(build.qty) || 1))
    for (const material of build.materials ?? []) {
      const qty = Math.round(Number(material.qty))
      if (!Number.isFinite(qty) || qty <= 0) continue
      const key = palletMaterialKey(material)
      stock.set(key, (stock.get(key) ?? 0) - qty * buildQty)
    }
  }
  return stock
}

function materialNeed(line: PalletMaterialLine, qty: number): number {
  return line.qty * Math.max(1, qty)
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
}

export function PalletsPage() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [recipeId, setRecipeId] = useState(PALLET_RECIPES[0]?.id ?? '')
  const [qtyText, setQtyText] = useState('1')
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

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

  useEffect(() => {
    reload()
  }, [reload])

  useWorkTasksReload(reload)

  const visibleTasks = useMemo(() => {
    if (!user) return []
    const canSeeAll = user.role === 'foreman' || user.role === 'admin' || user.role === 'super_admin'
    return tasks
      .filter((task) => {
        if (canSeeAll) return true
        if (!task.assignTo.includes('pallet_assembly')) return false
        const k = task.taskKind ?? 'resaw'
        return k === 'pallets' || k === 'resaw'
      })
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
  }, [tasks, user])

  useEffect(() => {
    if (selectedTaskId && visibleTasks.some((task) => task.id === selectedTaskId)) return
    setSelectedTaskId(visibleTasks[0]?.id ?? '')
  }, [selectedTaskId, visibleTasks])

  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId) ?? null
  const recipe = PALLET_RECIPES.find((r) => r.id === recipeId) ?? PALLET_RECIPES[0]
  const qty = Math.max(1, Math.round(Number(qtyText) || 1))
  const stock = useMemo(() => (selectedTask ? stockForTask(selectedTask) : new Map<string, number>()), [selectedTask])

  const materialRows = useMemo(() => {
    if (!recipe) return []
    return recipe.materials.map((line) => {
      const have = stock.get(palletMaterialKey(line)) ?? 0
      const need = materialNeed(line, qty)
      return {
        ...line,
        have,
        need,
        missing: Math.max(0, need - have),
      }
    })
  }, [qty, recipe, stock])

  const maxBuildQty = useMemo(() => {
    if (!recipe) return 0
    return recipe.materials.reduce((min, line) => {
      const have = stock.get(palletMaterialKey(line)) ?? 0
      return Math.min(min, Math.floor(have / line.qty))
    }, Number.POSITIVE_INFINITY)
  }, [recipe, stock])

  const builtTotal = useMemo(() => {
    if (!selectedTask) return 0
    return (selectedTask.palletAssembly?.builds ?? []).reduce((sum, build) => sum + (build.qty ?? 0), 0)
  }, [selectedTask])

  const canBuild = Boolean(selectedTask && recipe && materialRows.length > 0 && materialRows.every((row) => row.missing === 0))

  const submit = () => {
    if (!selectedTask || !recipe || busy) return
    setBusy(true)
    setErr(null)
    setMsg(null)
    void (async () => {
      try {
        const updated = await buildPallets(selectedTask.id, { palletTypeId: recipe.id, qty })
        setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)))
        setMsg(`Створено ${qty} шт: ${recipe.name}. Матеріал списано зі складу деталей.`)
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Не вдалося створити піддон')
      } finally {
        setBusy(false)
      }
    })()
  }

  if (!user) return null

  return (
    <>
      <section className="panel">
        <div className="palletsHeader">
          <div>
            <h2>Піддони</h2>
            <p>
              Оберіть завдання і тип піддону. Система підтягне норму матеріалу, покаже дефіцит,
              спише готові бруси та запише зібрані піддони.
            </p>
          </div>
          <div className="palletsKpi">
            <span>Зібрано</span>
            <strong>{builtTotal}</strong>
          </div>
        </div>

        {err && <p className="birkaMsgErr">{err}</p>}
        {msg && <p className="birkaMsgOk">{msg}</p>}

        <div className="palletsGrid">
          <div className="palletsCard">
            <h3>1. Завдання і тип</h3>
            <label className="palletsField">
              <span>Завдання</span>
              <select value={selectedTaskId} onChange={(e) => setSelectedTaskId(e.target.value)}>
                {visibleTasks.length === 0 ? (
                  <option value="">Немає доступних завдань</option>
                ) : (
                  visibleTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label className="palletsField">
              <span>Тип піддону</span>
              <select value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
                {PALLET_RECIPES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>

            {recipe && <p className="palletsRecipeText">{recipe.description}</p>}

            <label className="palletsField">
              <span>Скільки створити</span>
              <input
                type="number"
                min="1"
                step="1"
                value={qtyText}
                onChange={(e) => setQtyText(e.target.value)}
              />
            </label>

            <div className="palletsCapacity">
              <span>Можна зібрати зараз</span>
              <strong>{Number.isFinite(maxBuildQty) ? maxBuildQty : 0} шт</strong>
            </div>

            <button type="button" disabled={!canBuild || busy} onClick={submit}>
              {busy ? 'Створюю…' : 'Створити піддон і списати бруси'}
            </button>
          </div>

          <div className="palletsCard">
            <h3>2. Матеріал по нормі</h3>
            {materialRows.length === 0 ? (
              <p className="palletsEmpty">Оберіть тип піддону.</p>
            ) : (
              <div className="palletsTableWrap">
                <table className="palletsTable">
                  <thead>
                    <tr>
                      <th>Брус / деталь</th>
                      <th>На 1 піддон</th>
                      <th>Треба</th>
                      <th>Є</th>
                      <th>Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {materialRows.map((row) => (
                      <tr key={palletMaterialKey(row)}>
                        <td data-label="Брус / деталь">{fmtMaterial(row)}</td>
                        <td data-label="На 1 піддон">{row.qty}</td>
                        <td data-label="Треба">{row.need}</td>
                        <td data-label="Є">{row.have}</td>
                        <td data-label="Статус">
                          {row.missing > 0 ? (
                            <span className="palletsBad">Не вистачає {row.missing}</span>
                          ) : (
                            <span className="palletsGood">Достатньо</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <section className="palletsCard palletsHistory">
          <h3>Історія складання</h3>
          {!selectedTask || (selectedTask.palletAssembly?.builds ?? []).length === 0 ? (
            <p className="palletsEmpty">По цьому завданню піддони ще не створювали.</p>
          ) : (
            <div className="palletsBuildList">
              {(selectedTask.palletAssembly?.builds ?? []).slice().reverse().map((build, idx) => (
                <div className="palletsBuildItem" key={`${build.recordedAt}-${idx}`}>
                  <div>
                    <strong>{build.palletTypeName}</strong>
                    <span>{fmtDate(build.recordedAt)}</span>
                  </div>
                  <b>{build.qty} шт</b>
                </div>
              ))}
            </div>
          )}
        </section>
      </section>
    </>
  )
}
