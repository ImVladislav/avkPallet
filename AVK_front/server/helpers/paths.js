import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const ROOT = path.join(__dirname, '..')
export const DATA_DIR = path.join(ROOT, 'data')
export const USERS_FILE = path.join(DATA_DIR, 'users.json')
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json')
/** Колоди на складі + журнал прийому / розпилу (кругляк) */
export const ROUNDWOOD_FILE = path.join(DATA_DIR, 'roundwood.json')
