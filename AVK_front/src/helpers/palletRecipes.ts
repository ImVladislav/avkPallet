import type { PalletMaterialLine } from '../types/task'

export type PalletRecipe = {
  id: string
  name: string
  description: string
  materials: PalletMaterialLine[]
}

export const PALLET_RECIPES: PalletRecipe[] = [
  {
    id: 'euro-1200x800',
    name: 'EUR 1200×800',
    description: 'Стандартний європіддон: настил, лижі та кубики.',
    materials: [
      { thicknessMm: 22, widthMm: 100, lengthMm: 1200, qty: 8 },
      { thicknessMm: 78, widthMm: 100, lengthMm: 1200, qty: 3 },
      { thicknessMm: 100, widthMm: 100, lengthMm: 145, qty: 9 },
    ],
  },
  {
    id: 'industrial-1200x1000',
    name: 'Industrial 1200×1000',
    description: 'Посилений промисловий піддон під ширший настил.',
    materials: [
      { thicknessMm: 22, widthMm: 100, lengthMm: 1200, qty: 9 },
      { thicknessMm: 78, widthMm: 100, lengthMm: 1200, qty: 3 },
      { thicknessMm: 100, widthMm: 100, lengthMm: 145, qty: 9 },
    ],
  },
  {
    id: 'stringer-1200x800',
    name: 'Легкий 1200×800',
    description: 'Легкий піддон на трьох поздовжніх брусах.',
    materials: [
      { thicknessMm: 20, widthMm: 80, lengthMm: 1200, qty: 5 },
      { thicknessMm: 40, widthMm: 80, lengthMm: 800, qty: 3 },
    ],
  },
]

export function palletMaterialKey(line: Pick<PalletMaterialLine, 'thicknessMm' | 'widthMm' | 'lengthMm'>): string {
  return `${Math.round(line.thicknessMm)}|${Math.round(line.widthMm)}|${Math.round(line.lengthMm)}`
}

export function fmtMaterial(line: Pick<PalletMaterialLine, 'thicknessMm' | 'widthMm' | 'lengthMm'>): string {
  return `${Math.round(line.thicknessMm)}×${Math.round(line.widthMm)}×${Math.round(line.lengthMm)} мм`
}
