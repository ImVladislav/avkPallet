import { createApp } from './app.js'
import { PORT } from '../config/env.js'
import { ensureSeedUsers } from '../helpers/seedUsers.js'
import { connectMongo } from '../db/mongo.js'
import { migrateLegacyData } from '../db/migrateLegacyData.js'

await connectMongo()
await migrateLegacyData()
await ensureSeedUsers()

const app = createApp()
app.listen(PORT, () => {
  console.log(`API http://localhost:${PORT}  (health: /health, api: /api)`)
  console.log('Сховище: MongoDB (users, tasks, roundwood_state)')
})
