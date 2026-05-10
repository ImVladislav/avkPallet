import fs from 'fs/promises'
import { connectMongo } from './mongo.js'
import { UserModel } from './models/userModel.js'
import { TaskModel } from './models/taskModel.js'
import { RoundwoodStateModel } from './models/roundwoodStateModel.js'
import { ROUNDWOOD_FILE, TASKS_FILE, USERS_FILE } from '../helpers/paths.js'

async function readLocalJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function readFromLegacyKv(collection, key) {
  const doc = await collection.findOne({ key })
  return doc?.data
}

async function migrateUsers(kvCollection) {
  const count = await UserModel.countDocuments()
  if (count > 0) return
  const fromKv = await readFromLegacyKv(kvCollection, USERS_FILE)
  const fromFile = await readLocalJson(USERS_FILE, [])
  const source = Array.isArray(fromKv) && fromKv.length > 0 ? fromKv : fromFile
  if (!Array.isArray(source) || source.length === 0) return
  await UserModel.insertMany(source, { ordered: false })
}

async function migrateTasks(kvCollection) {
  const count = await TaskModel.countDocuments()
  if (count > 0) return
  const fromKv = await readFromLegacyKv(kvCollection, TASKS_FILE)
  const fromFile = await readLocalJson(TASKS_FILE, [])
  const source = Array.isArray(fromKv) && fromKv.length > 0 ? fromKv : fromFile
  if (!Array.isArray(source) || source.length === 0) return
  await TaskModel.insertMany(source, { ordered: false })
}

async function migrateRoundwood(kvCollection) {
  const count = await RoundwoodStateModel.countDocuments({ key: 'singleton' })
  if (count > 0) return
  const fromKv = await readFromLegacyKv(kvCollection, ROUNDWOOD_FILE)
  const fromFile = await readLocalJson(ROUNDWOOD_FILE, { stock: [], journal: [] })
  const source =
    fromKv && typeof fromKv === 'object' && !Array.isArray(fromKv) ? fromKv : fromFile
  const stock = Array.isArray(source?.stock) ? source.stock : []
  const journal = Array.isArray(source?.journal) ? source.journal : []
  await RoundwoodStateModel.updateOne(
    { key: 'singleton' },
    { $set: { key: 'singleton', stock, journal } },
    { upsert: true },
  )
}

export async function migrateLegacyData() {
  const conn = await connectMongo()
  const kvCollection = conn.collection('kv_store')
  await migrateUsers(kvCollection)
  await migrateTasks(kvCollection)
  await migrateRoundwood(kvCollection)
  await kvCollection.deleteMany({ key: { $in: [USERS_FILE, TASKS_FILE, ROUNDWOOD_FILE] } })
  try {
    const left = await kvCollection.countDocuments()
    if (left === 0) {
      await kvCollection.drop()
    }
  } catch {
    // no-op: collection may not exist or may be locked temporarily
  }
}
