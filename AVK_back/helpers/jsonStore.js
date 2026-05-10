import { connectMongo } from '../db/mongo.js'
import { RoundwoodStateModel } from '../db/models/roundwoodStateModel.js'
import { TaskModel } from '../db/models/taskModel.js'
import { UserModel } from '../db/models/userModel.js'
import { ROUNDWOOD_FILE, TASKS_FILE, USERS_FILE } from './paths.js'

function storeKey(filePath) {
  if (filePath === USERS_FILE) return 'users'
  if (filePath === TASKS_FILE) return 'tasks'
  if (filePath === ROUNDWOOD_FILE) return 'roundwood'
  return null
}

/**
 * @param {string} filePath
 * @param {unknown} defaultValue
 */
export async function readJson(filePath, defaultValue) {
  await connectMongo()
  const key = storeKey(String(filePath))
  if (key === 'users') {
    const users = await UserModel.find({}, { _id: 0 }).lean()
    return users.length > 0 ? users : defaultValue
  }
  if (key === 'tasks') {
    const tasks = await TaskModel.find({}, { _id: 0 }).lean()
    return tasks.length > 0 ? tasks : defaultValue
  }
  if (key === 'roundwood') {
    const state = await RoundwoodStateModel.findOne({ key: 'singleton' }, { _id: 0, key: 0 }).lean()
    if (state) return state
    await RoundwoodStateModel.create({
      key: 'singleton',
      stock: Array.isArray(defaultValue?.stock) ? defaultValue.stock : [],
      brusStock: Array.isArray(defaultValue?.brusStock) ? defaultValue.brusStock : [],
      journal: Array.isArray(defaultValue?.journal) ? defaultValue.journal : [],
    })
    return defaultValue
  }
  throw new Error(`Unsupported storage key: ${filePath}`)
}

/**
 * @param {string} filePath
 * @param {unknown} data
 */
export async function writeJson(filePath, data) {
  await connectMongo()
  const key = storeKey(String(filePath))
  if (key === 'users') {
    const rows = Array.isArray(data) ? data : []
    await UserModel.deleteMany({})
    if (rows.length > 0) await UserModel.insertMany(rows, { ordered: false })
    return
  }
  if (key === 'tasks') {
    const rows = Array.isArray(data) ? data : []
    await TaskModel.deleteMany({})
    if (rows.length > 0) await TaskModel.insertMany(rows, { ordered: false })
    return
  }
  if (key === 'roundwood') {
    const stock = Array.isArray(data?.stock) ? data.stock : []
    const brusStock = Array.isArray(data?.brusStock) ? data.brusStock : []
    const journal = Array.isArray(data?.journal) ? data.journal : []
    await RoundwoodStateModel.updateOne(
      { key: 'singleton' },
      { $set: { key: 'singleton', stock, brusStock, journal } },
      { upsert: true },
    )
    return
  }
  throw new Error(`Unsupported storage key: ${filePath}`)
}
