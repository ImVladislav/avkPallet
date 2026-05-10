/** @param {{ aMm: number; bMm: number; lengthMm: number; qty: number }[]} lines */
export function dominantPieceLengthMm(lines, thicknessMm) {
  const tw = Math.round(thicknessMm)
  const map = new Map()
  for (const o of lines) {
    if (Math.round(o.aMm) !== tw) continue
    const L = Math.round(o.lengthMm)
    if (L <= 0) continue
    map.set(L, (map.get(L) ?? 0) + o.qty)
  }
  let bestLen = null
  let bestQty = -1
  for (const [L, q] of map) {
    if (q > bestQty || (q === bestQty && bestLen != null && L > bestLen)) {
      bestQty = q
      bestLen = L
    }
  }
  return bestLen
}

export function workpiecesAlongOneLog(logLengthMm, pieceLengthMm, kerfBetweenPiecesMm) {
  const logL = Math.max(0, Math.floor(logLengthMm))
  const piece = Math.max(0, pieceLengthMm)
  const k = Math.max(0, kerfBetweenPiecesMm)
  if (logL <= 0 || piece <= 0) return 0
  return Math.floor((logL + k) / (piece + k))
}

/** Скільки деталей по довжині з однієї смуги (домінантна довжина в замовленні). */
export function boardsPerPhysicalStrip(orderLines, thicknessMm, logLenMm, kerfCircMm) {
  const dom = dominantPieceLengthMm(orderLines, thicknessMm)
  if (dom == null || dom <= 0) return 1
  const n = workpiecesAlongOneLog(logLenMm, dom, kerfCircMm)
  return Math.max(1, n)
}
