/**
 * @param {number} radius
 * @param {number} boardThickness
 * @param {number} kerf
 * @param {'min_waste' | 'max_inscribed'} [fit]
 */
function rowChordMm(radius, yCenter, thicknessMm, fit) {
  if (radius <= 0) return 0
  const r2 = radius * radius
  if (fit !== 'max_inscribed') {
    return 2 * Math.sqrt(Math.max(r2 - yCenter * yCenter, 0))
  }
  const halfT = thicknessMm / 2
  const cTop = 2 * Math.sqrt(Math.max(r2 - (yCenter - halfT) ** 2, 0))
  const cBot = 2 * Math.sqrt(Math.max(r2 - (yCenter + halfT) ** 2, 0))
  return Math.min(cTop, cBot)
}

/**
 * @param {number} radius
 * @param {number} boardThickness
 * @param {number} kerf
 * @param {'min_waste' | 'max_inscribed'} [fit]
 */
export function buildCrossSectionRows(radius, boardThickness, kerf, fit = 'min_waste') {
  if (radius <= 0 || boardThickness <= 0) return []
  const rows = []
  const k = Math.max(kerf, 0)
  const rowStep = boardThickness + k
  let y = -radius + boardThickness / 2

  while (y <= radius - boardThickness / 2 + 0.001) {
    const chord = rowChordMm(radius, y, boardThickness, fit)
    const boards = Math.floor((chord + k) / (boardThickness + k))
    if (boards > 0) {
      const boardWidth = (chord - k * (boards - 1)) / boards
      rows.push({ y, chord, boards, boardWidth })
    }
    y += rowStep
  }

  return rows
}
