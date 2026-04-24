/** Рядок замовлення: кількість і два розміри (мм). */

/**
 * aMm — перший розмір перетину після кількості у рядку / полі «висота»: товщина смуги з стрічкової пили (мм).
 * bMm — другий розмір у записі бригадира (мм). Для багатопилу: ширина різу поперек смуги — сторона,
 * яка **не** збігається з обраною висотою смуги (див. boardWidthAcrossStripForThickness).
 */
export type OrderLine = {
  qty: number
  aMm: number
  bMm: number
  /** Довжина дошки вздовж волокон (вздовж колоди), мм; 0 якщо не вказано (старий формат). */
  lengthMm: number
}

/**
 * Підтримує рядки:
 * - 4 50 50
 * - 4 шт 50x50
 * - 3 40 на 40 см
 * - 8 20×20 мм
 */
export function parseForemanOrderText(raw: string, unitDefault: 'mm' | 'cm'): { ok: true; lines: OrderLine[] } | { ok: false; error: string } {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length === 0) return { ok: false, error: 'Введіть хоча б один рядок замовлення.' }

  const result: OrderLine[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const parsed = parseOneLine(line, unitDefault)
    if (parsed.ok === false) return { ok: false, error: `Рядок ${i + 1}: ${parsed.error}` }
    result.push(parsed.line)
  }

  return { ok: true, lines: mergeOrderLines(result) }
}

export type DimensionRowInput = {
  qty: string
  height: string
  width: string
  length: string
}

/** Об’єднує рядки з однаковою парою (товщина смуги, ширина бруса) і довжиною — у тому порядку, як у замовленні. */
export function mergeOrderLines(lines: OrderLine[]): OrderLine[] {
  const map = new Map<string, OrderLine>()
  for (const l of lines) {
    const aMm = Math.round(l.aMm)
    const bMm = Math.round(l.bMm)
    const L = Math.round(l.lengthMm)
    const key = `${aMm}|${bMm}|${L}`
    const prev = map.get(key)
    if (prev) {
      prev.qty += l.qty
    } else {
      map.set(key, { qty: l.qty, aMm, bMm, lengthMm: l.lengthMm })
    }
  }
  return [...map.values()].sort((x, y) => {
    if (x.aMm !== y.aMm) return y.aMm - x.aMm
    if (x.bMm !== y.bMm) return y.bMm - x.bMm
    return y.lengthMm - x.lengthMm
  })
}

export function orderLinesFromDimensionRows(
  rows: DimensionRowInput[],
  unitDefault: 'mm' | 'cm',
): { ok: true; lines: OrderLine[] } | { ok: false; error: string } {
  const lines: OrderLine[] = []
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]
    const qty = Math.round(Number(String(r.qty).replace(',', '.')))
    const rawH = Number(String(r.height).replace(',', '.'))
    const rawW = Number(String(r.width).replace(',', '.'))
    const aMm = toMm(rawH, unitDefault)
    const bMm = secondCrossSectionMm(rawH, rawW, unitDefault, unitDefault)
    const lengthMm = toMm(Number(String(r.length).replace(',', '.')), unitDefault)

    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: `Рядок ${i + 1}: кількість має бути > 0` }
    }
    if (!Number.isFinite(aMm) || !Number.isFinite(bMm) || aMm <= 0 || bMm <= 0) {
      return { ok: false, error: `Рядок ${i + 1}: обидві сторони перетину мають бути > 0` }
    }
    if (!Number.isFinite(lengthMm) || lengthMm <= 0) {
      return { ok: false, error: `Рядок ${i + 1}: довжина дошки (вздовж колоди) має бути > 0` }
    }
    lines.push({ qty, aMm, bMm, lengthMm })
  }
  if (lines.length === 0) return { ok: false, error: 'Додайте хоча б один рядок замовлення.' }
  return { ok: true, lines: mergeOrderLines(lines) }
}

/**
 * Ширина бруса поперек смуги на багатопилу (мм): та сторона перетину, яка не дорівнює висоті смуги th.
 * Якщо жодна сторона не дорівнює th — рядок не стосується цієї висоти (null).
 */
export function boardWidthAcrossStripForThickness(
  line: OrderLine,
  stripThicknessMm: number,
): number | null {
  const a = Math.round(line.aMm)
  const b = Math.round(line.bMm)
  const t = Math.round(stripThicknessMm)
  if (a === t && b !== t) return b
  if (b === t && a !== t) return a
  if (a === t && b === t) return a
  return null
}

/**
 * Довжина заготовки за замовленням (мм) для пари: товщина смуги + ширина бруса поперек смуги.
 * Якщо кілька рядків збігаються — береться з рядка з більшою кількістю.
 */
export function orderLengthMmForThicknessAndBoardWidth(
  lines: OrderLine[],
  thicknessMm: number,
  boardWidthMm: number,
): number | null {
  const tw = Math.round(thicknessMm)
  const ww = Math.round(boardWidthMm)
  let best: { L: number; q: number } | null = null
  for (const o of lines) {
    const wAcross = boardWidthAcrossStripForThickness(o, tw)
    if (wAcross == null || Math.round(wAcross) !== ww) continue
    const L = Math.round(o.lengthMm)
    if (L <= 0) continue
    if (!best || o.qty > best.q || (o.qty === best.q && L > best.L)) {
      best = { L, q: o.qty }
    }
  }
  return best?.L ?? null
}

export function formatOrderLinesAsText(lines: OrderLine[]): string {
  return lines.map((l) => `${l.qty} ${l.aMm} ${l.bMm} ${l.lengthMm}`).join('\n')
}

/** Збереження замовлення в см (для unit: 'cm' на сервері). */
export function formatOrderLinesAsTextCm(lines: OrderLine[]): string {
  const fmt = (mm: number) => {
    const c = mm / 10
    return Number.isInteger(c) ? String(c) : String(Number(c.toFixed(1)))
  }
  return lines.map((l) => `${l.qty} ${fmt(l.aMm)} ${fmt(l.bMm)} ${fmt(l.lengthMm)}`).join('\n')
}

/** Ширина дошки в замовленні (поле «ширина» в рядку замовлення) для рядків з товщиною aMm ≈ thicknessMm. */
export function orderWidthsForThicknessMm(lines: OrderLine[], thicknessMm: number): number[] {
  const tw = Math.round(thicknessMm)
  const out: number[] = []
  for (const o of lines) {
    const w = boardWidthAcrossStripForThickness(o, tw)
    if (w != null) out.push(w)
  }
  return out
}

/**
 * Довжина заготовки (мм), що найчастіше в замовленні для цієї товщини — для оцінки
 * «скільки деталей з однієї смуги», якщо для товщини кілька різних довжин.
 */
export function dominantPieceLengthMmForThickness(
  lines: OrderLine[],
  thicknessMm: number,
): number | null {
  const tw = Math.round(thicknessMm)
  const byLen = new Map<number, number>()
  for (const o of lines) {
    if (boardWidthAcrossStripForThickness(o, tw) == null) continue
    const L = Math.round(o.lengthMm)
    if (L <= 0) continue
    byLen.set(L, (byLen.get(L) ?? 0) + o.qty)
  }
  let bestLen: number | null = null
  let bestQty = -1
  for (const [L, q] of byLen) {
    if (q > bestQty || (q === bestQty && bestLen != null && L > bestLen)) {
      bestQty = q
      bestLen = L
    }
  }
  return bestLen
}

/**
 * Найтиповіша ширина різу поперек смуги для цієї висоти смуги.
 */
export function dominantBoardWidthMmForThickness(
  lines: OrderLine[],
  thicknessMm: number,
): number | null {
  const tw = Math.round(thicknessMm)
  const byW = new Map<number, number>()
  for (const o of lines) {
    const w = boardWidthAcrossStripForThickness(o, tw)
    if (w == null) continue
    byW.set(w, (byW.get(w) ?? 0) + o.qty)
  }
  let bestW: number | null = null
  let bestQty = -1
  for (const [w, q] of byW) {
    if (q > bestQty || (q === bestQty && bestW != null && w > bestW)) {
      bestQty = q
      bestW = w
    }
  }
  return bestW
}

/** Унікальні довжини заготовок (вздовж колоди) для рядків з даною товщиною смуги. */
export function orderPieceLengthsForThicknessMm(
  lines: OrderLine[],
  thicknessMm: number,
): number[] {
  const tw = Math.round(thicknessMm)
  const s = new Set<number>()
  for (const o of lines) {
    if (boardWidthAcrossStripForThickness(o, tw) == null) continue
    const L = Math.round(o.lengthMm)
    if (L > 0) s.add(L)
  }
  return [...s].sort((a, b) => b - a)
}

export function orderBoardWidthsGrouped(
  lines: OrderLine[],
  thicknessMm: number,
): { widthMm: number; qty: number }[] {
  const tw = Math.round(thicknessMm)
  const m = new Map<number, number>()
  for (const o of lines) {
    const w = boardWidthAcrossStripForThickness(o, tw)
    if (w == null) continue
    m.set(w, (m.get(w) ?? 0) + o.qty)
  }
  return [...m.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([widthMm, qty]) => ({ widthMm, qty }))
}

export function orderWidthSummaryForThicknessMm(
  lines: OrderLine[],
  thicknessMm: number,
): { min: number; max: number; avg: number } | null {
  const widths = orderWidthsForThicknessMm(lines, thicknessMm)
  if (widths.length === 0) return null
  const min = Math.min(...widths)
  const max = Math.max(...widths)
  const avg = widths.reduce((a, b) => a + b, 0) / widths.length
  return { min, max, avg }
}

function toMm(n: number, unit: 'mm' | 'cm'): number {
  return unit === 'cm' ? Math.round(n * 10) : Math.round(n)
}

/**
 * Завдання з unit «см»: висоту смуги вводять у см, а другу сторону перетину часто плутають і пишуть у мм * (напр. 50 замість 5 см). Якщо «ширина в см» виходить нереалістично великою — трактуємо друге число як мм.
 */
function secondCrossSectionMm(
  firstRaw: number,
  secondRaw: number,
  lineUnit: 'mm' | 'cm',
  taskUnitDefault: 'mm' | 'cm',
): number {
  const hMm = toMm(firstRaw, lineUnit)
  const wIfSameUnit = toMm(secondRaw, lineUnit)
  if (
    taskUnitDefault === 'cm' &&
    lineUnit === 'cm' &&
    wIfSameUnit > hMm * 1.75 &&
    secondRaw >= 35 &&
    secondRaw <= 200
  ) {
    return Math.round(secondRaw)
  }
  return wIfSameUnit
}

function parseOneLine(
  line: string,
  unitDefault: 'mm' | 'cm',
): { ok: true; line: OrderLine } | { ok: false; error: string } {
  let unit: 'mm' | 'cm' = unitDefault
  if (/\bсм\b/i.test(line)) unit = 'cm'
  if (/\bмм\b/i.test(line)) unit = 'mm'

  const cleaned = line
    .replace(/шт\.?/gi, '')
    .replace(/[×xх]/gi, ' ')
    .replace(/на/gi, ' ')
    .replace(/(мм|см)\b/gi, '')
    .trim()

  const nums = cleaned.match(/-?\d+(?:[.,]\d+)?/g)
  if (!nums || nums.length < 3) {
    return {
      ok: false,
      error:
        'очікується: кількість, висота (товщина смуги), ширина дошки, за потреби довжина — напр. 4 50 50 1200',
    }
  }

  const n1 = Number(nums[1].replace(',', '.'))
  const n2 = Number(nums[2].replace(',', '.'))
  const qty = Math.round(Number(nums[0].replace(',', '.')))
  const a = toMm(n1, unit)
  const b = secondCrossSectionMm(n1, n2, unit, unitDefault)
  const lengthMm = nums.length >= 4 ? toMm(Number(nums[3].replace(',', '.')), unit) : 0

  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'кількість має бути > 0' }
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return { ok: false, error: 'розміри мають бути додатні' }
  }
  if (nums.length >= 4 && (!Number.isFinite(lengthMm) || lengthMm <= 0)) {
    return { ok: false, error: 'довжина має бути > 0, якщо вказана' }
  }

  return { ok: true, line: { qty, aMm: a, bMm: b, lengthMm } }
}
