export type CrossRow = {
  y: number
  chord: number
  boards: number
  boardWidth: number
}

export type CrossRowWithThickness = CrossRow & { thicknessMm: number }

/** Як рахувати ширину ряду в торці: мін. відходи vs повне вміщення прямокутника смуги в коло. */
export type BandCrossFitMode = 'min_waste' | 'max_inscribed'

export const BAND_CROSS_FIT_STORAGE_KEY = 'avk_band_cross_fit'

/** Ефективна хорда (мм) для ряду: центр y, товщина смуги T, радіус R. */
export function rowChordMm(
  radius: number,
  yCenter: number,
  thicknessMm: number,
  fit: BandCrossFitMode,
): number {
  if (radius <= 0) return 0
  const r2 = radius * radius
  if (fit === 'min_waste') {
    return 2 * Math.sqrt(Math.max(r2 - yCenter * yCenter, 0))
  }
  const halfT = thicknessMm / 2
  const cTop = 2 * Math.sqrt(Math.max(r2 - (yCenter - halfT) ** 2, 0))
  const cBot = 2 * Math.sqrt(Math.max(r2 - (yCenter + halfT) ** 2, 0))
  return Math.min(cTop, cBot)
}

export function buildCrossSectionRows(
  radius: number,
  boardThickness: number,
  kerf: number,
  fit: BandCrossFitMode = 'min_waste',
): CrossRow[] {
  if (radius <= 0 || boardThickness <= 0) return []
  const rows: CrossRow[] = []
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

/**
 * Найбільша хорда серед рядів цієї товщини на торці (план ленточної) — оцінка ширини смуги
 * для нарізки по ширині на станку 2. Той самий режим торця, що й на ленточній (`fit`).
 */
export function maxStripChordMmForBandThickness(
  radiusMm: number,
  stripThicknessMm: number,
  kerfBandMm: number,
  fit: BandCrossFitMode = 'min_waste',
): number {
  const rows = buildCrossSectionRows(radiusMm, stripThicknessMm, kerfBandMm, fit)
  if (!rows.length) return 0
  return Math.max(...rows.map((r) => r.chord))
}

/**
 * Ряди з центром y ≥ yMinCenter (перший центр на сітці кроку, як у buildCrossSectionRows).
 * Для наступної товщини після зовнішніх шарів — зона «кришки» до полюса.
 */
export function buildCrossSectionRowsFromYMin(
  radius: number,
  boardThickness: number,
  kerf: number,
  yMinCenter: number,
  fit: BandCrossFitMode = 'min_waste',
): CrossRow[] {
  if (radius <= 0 || boardThickness <= 0) return []
  const rows: CrossRow[] = []
  const k = Math.max(kerf, 0)
  const rowStep = boardThickness + k
  let y = -radius + boardThickness / 2
  while (y < yMinCenter - 0.001) {
    y += rowStep
  }
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

/**
 * Торець у порядку фізичного різання (товстіші першими): повний набір рядів для T₁,
 * під ними — ряди T₂ у залишку до полюса, тощо (умовна схема одного торця після зняття шарів).
 */
export function buildStackedBandCrossSection(
  radiusMm: number,
  thicknessesMm: number[],
  kerfMm: number,
  fit: BandCrossFitMode = 'min_waste',
): CrossRowWithThickness[] {
  if (radiusMm <= 0 || !thicknessesMm.length) return []
  const kerf = Math.max(kerfMm, 0)
  const out: CrossRowWithThickness[] = []
  const filtered = thicknessesMm.filter((t) => t > 0)
  if (!filtered.length) return []

  const firstT = filtered[0]
  const firstChunk = buildCrossSectionRows(radiusMm, firstT, kerf, fit)
  for (const r of firstChunk) {
    out.push({ ...r, thicknessMm: firstT })
  }

  for (let i = 1; i < filtered.length; i += 1) {
    const T = filtered[i]
    if (!out.length) break
    const prev = out[out.length - 1]
    const yMinCenter = prev.y + prev.thicknessMm / 2 + kerf + T / 2
    const chunk = buildCrossSectionRowsFromYMin(radiusMm, T, kerf, yMinCenter, fit)
    for (const r of chunk) {
      out.push({ ...r, thicknessMm: T })
    }
  }

  return out
}

function rowIsEntirelySurplus(
  row: CrossRowWithThickness,
  budgets: Map<number, number>,
): boolean {
  const t = row.thicknessMm
  let b = budgets.get(t) ?? 0
  for (let j = 0; j < row.boards; j += 1) {
    if (b > 0) return false
  }
  return true
}

function consumeRowStripBudget(row: CrossRowWithThickness, budgets: Map<number, number>): void {
  const t = row.thicknessMm
  let b = budgets.get(t) ?? 0
  for (let j = 0; j < row.boards; j += 1) {
    if (b > 0) b -= 1
  }
  budgets.set(t, b)
}

function rowsOverlapByHeight(
  a: CrossRowWithThickness,
  b: CrossRowWithThickness,
): boolean {
  const aTop = a.y - a.thicknessMm / 2
  const aBottom = a.y + a.thicknessMm / 2
  const bTop = b.y - b.thicknessMm / 2
  const bBottom = b.y + b.thicknessMm / 2
  return !(aBottom <= bTop || bBottom <= aTop)
}

/**
 * Як buildStackedBandCrossSection, але рядки, де всі смуги вже «понад норму» (бюджет 0 на
 * початку ряду), не включаються; наступна товщина рахується від останнього залишеного ряду —
 * без «порожнього» хвоста з повністю зайвими рядами.
 * Якщо зовнішній шар повністю «закритий» і жоден його ряд не потрапив у out — наступну товщину
 * будуємо по повному колу (як окрему смугу), інакше схема лишалась би порожньою.
 */
export function buildStackedBandCrossSectionForDemand(
  radiusMm: number,
  thicknessesMm: number[],
  kerfMm: number,
  remainingByThicknessMm: Map<number, number>,
  fit: BandCrossFitMode = 'min_waste',
): CrossRowWithThickness[] {
  if (radiusMm <= 0 || !thicknessesMm.length) return []
  const kerf = Math.max(kerfMm, 0)
  const filtered = thicknessesMm.filter((t) => t > 0)
  if (!filtered.length) return []

  const budgets = new Map(remainingByThicknessMm)
  const out: CrossRowWithThickness[] = []

  const firstT = filtered[0]
  const firstChunk = buildCrossSectionRows(radiusMm, firstT, kerf, fit)
  for (const r of firstChunk) {
    const row: CrossRowWithThickness = { ...r, thicknessMm: firstT }
    if (rowIsEntirelySurplus(row, budgets)) continue
    out.push(row)
    consumeRowStripBudget(row, budgets)
  }

  for (let i = 1; i < filtered.length; i += 1) {
    const T = filtered[i]
    let chunk =
      out.length === 0
        ? buildCrossSectionRows(radiusMm, T, kerf, fit)
        : buildCrossSectionRowsFromYMin(
            radiusMm,
            T,
            kerf,
            out[out.length - 1]!.y + out[out.length - 1]!.thicknessMm / 2 + kerf + T / 2,
            fit,
          )
    // Якщо для цієї товщини в "залишковій шапці" немає рядів, показуємо повний переріз товщини.
    // Це дає оператору реальну комбіновану карту по товщинах (а не порожній шар).
    if (chunk.length === 0) {
      chunk = buildCrossSectionRows(radiusMm, T, kerf, fit)
    }
    for (const r of chunk) {
      const row: CrossRowWithThickness = { ...r, thicknessMm: T }
      if (rowIsEntirelySurplus(row, budgets)) continue
      if (out.some((placed) => rowsOverlapByHeight(placed, row))) continue
      out.push(row)
      consumeRowStripBudget(row, budgets)
    }
  }

  return out
}

/**
 * Для кожної смуги в crossRows: true = надлишок у цьому торці (залишок комірок після
 * зарахування перших `remainingByThicknessMm.get(T)` штук), обхід як у рендері — ряд за рядом,
 * у рядку зліва направо (зовні → всередину колоди).
 */
export function markSurplusStripsInCrossRows(
  rows: CrossRowWithThickness[],
  remainingByThicknessMm: Map<number, number>,
): boolean[][] {
  const budgets = new Map(remainingByThicknessMm)
  return rows.map((row) => {
    const t = row.thicknessMm
    const flags: boolean[] = []
    for (let j = 0; j < row.boards; j += 1) {
      const b = budgets.get(t) ?? 0
      if (b > 0) {
        budgets.set(t, b - 1)
        flags.push(false)
      } else {
        flags.push(true)
      }
    }
    return flags
  })
}

/**
 * Відстань (мм) від нижнього краю останнього ряду до нижнього полюса кола по вертикалі.
 * Типово > 0, бо крок рядів (товщина + пропил) рідко «лягає» рівно на діаметр —
 * у цій зоні ще можлива нарізка меншою товщиною.
 */
export function crossSectionSouthPoleGapMm(
  radiusMm: number,
  boardThicknessMm: number,
  kerfMm: number,
  fit: BandCrossFitMode = 'min_waste',
): number {
  const rows = buildCrossSectionRows(radiusMm, boardThicknessMm, kerfMm, fit)
  if (!rows.length) return 0
  const last = rows[rows.length - 1]
  return crossSectionSouthPoleGapAfterLastRow(radiusMm, last.y, boardThicknessMm)
}

export function crossSectionSouthPoleGapAfterLastRow(
  radiusMm: number,
  lastRowCenterY: number,
  lastRowThicknessMm: number,
): number {
  const bottomEdge = lastRowCenterY + lastRowThicknessMm / 2
  return Math.max(0, radiusMm - bottomEdge)
}

/** Максимальна товщина смуги (мм), при якій з кола радіуса R ще можна зняти хоч одну дошку. */
export function maxThicknessFeasibleForRadius(
  radiusMm: number,
  kerfMm: number,
  fit: BandCrossFitMode = 'min_waste',
): number {
  if (radiusMm <= 0) return 0
  let lo = 1
  let hi = Math.min(Math.ceil(2 * radiusMm), 4000)
  let best = 0
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const rows = buildCrossSectionRows(radiusMm, mid, kerfMm, fit)
    const boards = rows.reduce((s, r) => s + r.boards, 0)
    if (boards > 0) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/** Крок лінійки розпилу: один горизонтальний ряд смуг на торці (зовні → всередину). */
export type ResawRulerStep = {
  cutIndex: number
  thicknessMm: number
  /**
   * Відстань від низу торця до лінії центру різу (мм, одна цифра після коми), на спад до 0 на останньому ряді.
   */
  heightFromBottomMm: number
  /** Зменшити показання лінійки від попереднього різу (мм); для 1-го — null. */
  decreaseScaleByMm: number | null
}

function round1mm(x: number): number {
  return Math.round(x * 10) / 10
}

/**
 * Лінійка: від низу торця (останній ряд = 0 мм), зовнішній різ — найбільше; далі на спад.
 * Усі значення округлені до 0,1 мм. Якщо вказати показання 1-го різу (мм), решта масштабуються; останній = 0.
 */
export function buildResawRulerSteps(
  crossRows: CrossRowWithThickness[],
  logRadiusMm: number,
  firstCutMmRaw: string,
): ResawRulerStep[] {
  if (!crossRows.length || logRadiusMm <= 0) return []

  const fromBottomMm = crossRows.map((r) => logRadiusMm - r.y)
  const bottomRefMm = fromBottomMm[crossRows.length - 1]!
  const relMm = fromBottomMm.map((d) => d - bottomRefMm)

  const t = firstCutMmRaw.trim().replace(',', '.')
  const userFirst = t === '' ? NaN : Number(t)
  const userFirstMm = Number.isFinite(userFirst) ? round1mm(userFirst) : NaN
  const hasCalib = Number.isFinite(userFirstMm) && userFirstMm > 0
  const rel0 = relMm[0]!

  const heightMmAt = (i: number): number => {
    if (hasCalib && rel0 > 1e-6) {
      return round1mm((relMm[i]! / rel0) * userFirstMm)
    }
    return round1mm(relMm[i]!)
  }

  const heightsMm = crossRows.map((_, i) => heightMmAt(i))

  return crossRows.map((row, i) => ({
    cutIndex: i + 1,
    thicknessMm: row.thicknessMm,
    heightFromBottomMm: heightsMm[i]!,
    decreaseScaleByMm:
      i > 0 ? round1mm(heightsMm[i - 1]! - heightsMm[i]!) : null,
  }))
}
