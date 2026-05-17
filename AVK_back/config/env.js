import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config({ path: path.join(__dirname, '..', '.env') })

export const PORT = Number(process.env.PORT) || 3001
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-in-production'
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'
export const MONGODB_URI = process.env.MONGODB_URI || process.env.COMPASS || ''

/** Вимкнути обхід Atlas+TLS на Windows (рідко, якщо потрібен саме IPv6). */
export const MONGODB_DUAL_STACK =
  process.env.MONGODB_DUAL_STACK === '1' || process.env.MONGODB_DUAL_STACK === 'true'

/** Увімкнути той самий обхід на Linux/macOS (на Windows він увімкнено за замовчуванням). */
export const MONGODB_FORCE_IPV4 =
  process.env.MONGODB_FORCE_IPV4 === '1' || process.env.MONGODB_FORCE_IPV4 === 'true'
