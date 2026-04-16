export type LengthUnit = 'm' | 'cm'

const LS_DEFAULT_LENGTH_MM = 'pallet.defaultLengthMm'
const LS_LENGTH_UNIT = 'pallet.lengthUnit'

export const DEFAULT_LENGTH_MM = 4000

export function readDefaultLengthMm(): number {
  const raw = localStorage.getItem(LS_DEFAULT_LENGTH_MM)
  if (!raw) return DEFAULT_LENGTH_MM
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_LENGTH_MM
}

export function writeDefaultLengthMm(mm: number) {
  localStorage.setItem(LS_DEFAULT_LENGTH_MM, String(Math.round(mm)))
}

export function readLengthUnit(): LengthUnit {
  return localStorage.getItem(LS_LENGTH_UNIT) === 'cm' ? 'cm' : 'm'
}

export function persistLengthUnit(unit: LengthUnit) {
  localStorage.setItem(LS_LENGTH_UNIT, unit)
}

export function mmToDisplay(mm: number, unit: LengthUnit): number {
  return unit === 'm' ? mm / 1000 : mm / 10
}

export function displayToMm(value: number, unit: LengthUnit): number {
  if (!Number.isFinite(value) || value <= 0) return NaN
  return unit === 'm' ? Math.round(value * 1000) : Math.round(value * 10)
}

export function formatLengthInput(mm: number, unit: LengthUnit): string {
  const v = mmToDisplay(mm, unit)
  const fixed = unit === 'm' ? v.toFixed(3) : v.toFixed(1)
  return String(parseFloat(fixed))
}

/** Парсить рядок у мм за обраною одиницею довжини (м або см) — для полів на сторінці з перемикачем. */
export function parseDisplayValueToMm(value: string, unit: LengthUnit): number | null {
  const normalized = value.replace(',', '.').trim()
  const n = Number(normalized)
  if (!Number.isFinite(n) || n <= 0) return null
  const mm = displayToMm(n, unit)
  return Number.isFinite(mm) && mm > 0 ? mm : null
}
