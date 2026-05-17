import type { WorkTask } from '../types/task'

/** Побічні рядки без кількості: для картки лише «5×7 см» (без окремого заголовка). */
export function formatOpenSecondariesForCard(task: WorkTask): string | null {
  const rows = task.dimensionRows?.filter(
    (r) => r.kind === 'secondary' && !String(r.qty ?? '').trim(),
  )
  if (!rows?.length) return null
  const u = task.unit === 'cm' ? 'см' : 'мм'
  return rows
    .map((r) => {
      const h = String(r.height ?? '').trim()
      const w = String(r.width ?? '').trim()
      const L = String(r.length ?? '').trim()
      const cross = `${h}×${w} ${u}`
      return L ? `${cross}, ${L} ${u}` : cross
    })
    .join('; ')
}
