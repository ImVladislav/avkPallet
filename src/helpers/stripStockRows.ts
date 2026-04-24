import { maxStripChordMmForBandThickness } from './crossSection'
import type { WorkTask } from '../types/task'

export type StripStockTaskRow = {
  thicknessMm: number
  /** Ширина смуги в торці до нарізу по ширині (хорда), мм — за R завдання та планом стрічкової пили. */
  undressedStripWidthMm: number | null
  remainder: number
  incoming: number
  cutSum: number
}

function dominantStripWidthFromInventory(task: WorkTask, thicknessMm: number): number | null {
  const th = Math.round(thicknessMm)
  const inv = task.stripInventory ?? []
  const byWidth = new Map<number, number>()
  for (const e of inv) {
    if (Math.round(Number(e.thicknessMm)) !== th) continue
    const w = Math.round(Number(e.stripWidthMm))
    if (!Number.isFinite(w) || w <= 0) continue
    const q = Math.max(1, Math.round(Number(e.qty) || 1))
    byWidth.set(w, (byWidth.get(w) ?? 0) + q)
  }
  let bestW: number | null = null
  let bestQty = -1
  for (const [w, q] of byWidth) {
    if (q > bestQty || (q === bestQty && bestW != null && w > bestW)) {
      bestQty = q
      bestW = w
    }
  }
  return bestW
}

/**
 * Оцінка ширини смуги «як зі стрічкової пили» (поперек волокон у торці), до багатопилу.
 */
export function undressedStripWidthMmForTask(task: WorkTask, thicknessMm: number): number | null {
  const th = Math.round(thicknessMm)
  const invWidth = dominantStripWidthFromInventory(task, th)
  if (invWidth != null && invWidth > 0) return invWidth
  const circ = task.plan?.circular?.find((c) => Math.round(c.thicknessMm) === th)
  const avg = circ != null ? Number(circ.avgChordMm) : NaN
  if (Number.isFinite(avg) && avg > 0) {
    return Math.round(avg)
  }
  const r = Number(task.radiusMm)
  const kb = Number(task.kerfBandMm) || 0
  if (r > 0 && th > 0) {
    const maxC = maxStripChordMmForBandThickness(r, th, kb, 'min_waste')
    if (maxC > 0) return Math.round(maxC)
  }
  return null
}

/** Смуги по завданню: прийшло, спиляно на багатопилі, залишок (як на сторінці багатопилу). */
export function stripStockRowsForTask(task: WorkTask): StripStockTaskRow[] {
  const inv = task.stripInventory ?? []
  const mInv = new Map<number, number>()
  for (const e of inv) {
    const th = Math.round(e.thicknessMm)
    mInv.set(th, (mInv.get(th) ?? 0) + Math.round(e.qty))
  }
  const cuts = task.stripSaw?.cuts ?? []
  const mCut = new Map<number, number>()
  for (const c of cuts) {
    const th = Math.round(c.thicknessMm)
    mCut.set(th, (mCut.get(th) ?? 0) + Math.round(c.stripQty))
  }
  const ov = task.stripSaw?.remainderOverrideByThicknessMm ?? {}
  const keys = new Set<number>([
    ...mInv.keys(),
    ...mCut.keys(),
    ...Object.keys(ov).map((k) => Math.round(Number(k))),
  ])
  return [...keys]
    .sort((a, b) => b - a)
    .map((th) => {
      const incoming = mInv.get(th) ?? 0
      const cutSum = mCut.get(th) ?? 0
      const k = String(th)
      const rawOv = ov[k]
      const hasOverride = rawOv !== undefined && rawOv !== null
      const remainder = hasOverride
        ? Math.max(0, Math.round(Number(rawOv)))
        : Math.max(0, incoming - cutSum)
      return {
        thicknessMm: th,
        undressedStripWidthMm: undressedStripWidthMmForTask(task, th),
        remainder,
        incoming,
        cutSum,
      }
    })
}
