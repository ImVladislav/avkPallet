export type CrossRow = {
  y: number
  chord: number
  boards: number
  boardWidth: number
}

export type CrossRowWithThickness = CrossRow & {
  thicknessMm: number
  /** Побічний орієнтир на карті — не з планового обсягу смуг */
  stripKind?: 'primary' | 'secondary'
}

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
 * Найбільша хорда серед рядів цієї товщини на торці (план стрічкової пили) — оцінка ширини смуги
 * для нарізки по ширині на багатопилу. Той самий режим торця, що й на стрічковій пилі (`fit`).
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

/** Крок лінійки розпилу: різ над штабелем, між смугами або під штабелем (зовні → всередину по мм). */
export type ResawRulerStep = {
  cutIndex: number
  /** Для різу між смугами — товщина внутрішньої смуги; для верху/низу — суміжна смуга штабелю. */
  thicknessMm: number
  /** Побічна смуга тієї ж товщини, що й у колонці «Товщ.». */
  stripKind?: 'primary' | 'secondary'
  /** Верхній різ (над першою смугою) або нижній (під останньою). */
  edge?: 'top' | 'bottom'
  /**
   * Відстань від низа торця на діаграмі (мм), та сама шкала, що вертикальна лінійка (0 внизу, 2R угорі).
   */
  heightFromBottomMm: number
  /** Зменшити показання лінійки від попереднього різу (мм); для 1-го — null. */
  decreaseScaleByMm: number | null
}

/** Геометрія одного різу для карти «Піфагор» і лінійки. */
export type PitagoResawCutDef = {
  cutYmm: number
  thicknessMm: number
  stripKind?: 'primary' | 'secondary'
  edge?: 'top' | 'bottom'
  /** Лише для різу між смугами (нижня смуга від шва). */
  betweenLowerMm?: number
  /** Лише для різу між смугами (верхня смуга від шва). */
  betweenUpperMm?: number
}

function round1mm(x: number): number {
  return Math.round(x * 10) / 10
}

/** Верх/низ вертикальної лінійки на карті «Піфагор» (SVG y): у збігу з BandSawPage. */
export const PITAGO_RULER_SVG_TOP = 1
export const PITAGO_RULER_SVG_BOTTOM = 239
export const PITAGO_SVG_CENTER_Y = 120
export const PITAGO_SVG_LOG_RADIUS = 119

/**
 * Висота центру різу від низа торця на схемі (мм), у тій самій шкалі, що вертикальна лінійка:
 * 0 — низ (великий SVG y), 2R — гори (малий SVG y). Не плутати з «математичним» y центру кола.
 */
export function pitagoCutHeightFromBottomMm(
  cutYmm: number,
  logRadiusMm: number,
): number {
  if (logRadiusMm <= 0) return 0
  const cutYSvg =
    PITAGO_SVG_CENTER_Y + (cutYmm / logRadiusMm) * PITAGO_SVG_LOG_RADIUS
  const span = PITAGO_RULER_SVG_BOTTOM - PITAGO_RULER_SVG_TOP
  const diam = 2 * logRadiusMm
  const v = round1mm((diam * (PITAGO_RULER_SVG_BOTTOM - cutYSvg)) / span)
  return Math.max(0, Math.min(diam, v))
}

/**
 * Усі різи карти: верхній (над 1-ю смугою), між сусідніми, нижній (під останньою).
 * Порядок у масиві: зверху схеми вниз (не сортований).
 */
export function listPitagoResawCuts(
  crossRows: CrossRowWithThickness[],
  kerfMm: number,
): PitagoResawCutDef[] {
  if (!crossRows.length) return []
  const kerf = Math.max(kerfMm, 0)
  const out: PitagoResawCutDef[] = []

  const first = crossRows[0]!
  out.push({
    cutYmm: first.y - first.thicknessMm / 2 - kerf / 2,
    thicknessMm: first.thicknessMm,
    stripKind: first.stripKind,
    edge: 'top',
  })

  for (let i = 0; i < crossRows.length - 1; i += 1) {
    const row = crossRows[i]!
    const inner = crossRows[i + 1]!
    out.push({
      cutYmm: row.y + row.thicknessMm / 2 + kerf / 2,
      thicknessMm: inner.thicknessMm,
      stripKind: inner.stripKind,
      betweenLowerMm: row.thicknessMm,
      betweenUpperMm: inner.thicknessMm,
    })
  }

  const last = crossRows[crossRows.length - 1]!
  out.push({
    cutYmm: last.y + last.thicknessMm / 2 + kerf / 2,
    thicknessMm: last.thicknessMm,
    stripKind: last.stripKind,
    edge: 'bottom',
  })

  return out
}

/**
 * Лінійка по різах (верх, між смугами, низ; основні й побічні), зовнішній різ — найбільше мм.
 * Шкала збігається з вертикальною лінійкою на SVG: 0 мм унизу діаграми, 2R — угорі.
 * Якщо вказати показання 1-го (зовнішнього) різу, лінійно масштабує інтервал [hₘᵢₙ, hₘₐₓ] → [hₘᵢₙ, U].
 */
export function buildResawRulerSteps(
  crossRows: CrossRowWithThickness[],
  logRadiusMm: number,
  kerfMm: number,
  firstCutMmRaw: string,
): ResawRulerStep[] {
  if (crossRows.length < 1 || logRadiusMm <= 0) return []

  const t = firstCutMmRaw.trim().replace(',', '.')
  const userFirst = t === '' ? NaN : Number(t)
  const userFirstMm = Number.isFinite(userFirst) ? round1mm(userFirst) : NaN
  const hasCalib = Number.isFinite(userFirstMm) && userFirstMm > 0

  const defs = listPitagoResawCuts(crossRows, kerfMm)
  type RawCut = {
    thicknessMm: number
    stripKind?: 'primary' | 'secondary'
    edge?: 'top' | 'bottom'
    heightAbs: number
  }

  const raw: RawCut[] = defs.map((d) => ({
    thicknessMm: d.thicknessMm,
    stripKind: d.stripKind,
    edge: d.edge,
    heightAbs: pitagoCutHeightFromBottomMm(d.cutYmm, logRadiusMm),
  }))

  raw.sort((a, b) => b.heightAbs - a.heightAbs)
  const hMin = raw[raw.length - 1]!.heightAbs
  const hMax = raw[0]!.heightAbs
  const span = hMax - hMin

  const mapHeight = (h: number): number => {
    if (hasCalib && span > 1e-6) {
      return round1mm(hMin + ((h - hMin) / span) * (userFirstMm - hMin))
    }
    return round1mm(h)
  }

  const heightsMm = raw.map((r) => mapHeight(r.heightAbs))

  return raw.map((r, i) => ({
    cutIndex: i + 1,
    thicknessMm: r.thicknessMm,
    stripKind: r.stripKind,
    edge: r.edge,
    heightFromBottomMm: heightsMm[i]!,
    decreaseScaleByMm:
      i > 0 ? round1mm(heightsMm[i - 1]! - heightsMm[i]!) : null,
  }))
}
