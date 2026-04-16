import type { OrderLine } from './parseForemanOrders'
import { dominantPieceLengthMmForThickness } from './parseForemanOrders'

/**
 * Скільки заготовок довжиною pieceLengthMm можна нарізати з бруса logLengthMm по осі,
 * якщо між заготовками пропил kerfMm (етап циркулярки по довжині).
 * n * pieceLength + (n - 1) * kerf <= logLength
 */
export function workpiecesAlongOneLog(
  logLengthMm: number,
  pieceLengthMm: number,
  kerfBetweenPiecesMm: number,
): number {
  const logL = Math.max(0, Math.floor(logLengthMm))
  const piece = Math.max(0, pieceLengthMm)
  const k = Math.max(0, kerfBetweenPiecesMm)
  if (logL <= 0 || piece <= 0) return 0
  return Math.floor((logL + k) / (piece + k))
}

/** Скільки деталей по довжині дає одна знята смуга (домінантна довжина з замовлення). */
export function boardsPerPhysicalStrip(
  lines: OrderLine[],
  thicknessMm: number,
  logLengthMm: number,
  kerfCircMm: number,
): number {
  const dom = dominantPieceLengthMmForThickness(lines, thicknessMm)
  if (dom == null || dom <= 0) return 1
  const n = workpiecesAlongOneLog(logLengthMm, dom, kerfCircMm)
  return Math.max(1, n)
}
