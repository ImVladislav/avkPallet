import { createApp } from './app.js'
import { PORT } from '../config/env.js'
import { TASKS_FILE } from '../helpers/paths.js'
import { ensureSeedUsers } from '../helpers/seedUsers.js'

await ensureSeedUsers()

const app = createApp()
app.listen(PORT, () => {
  console.log(`API http://localhost:${PORT}  (health: /health, api: /api)`)
  console.log(`Завдання зберігаються у файлі: ${TASKS_FILE}`)
})
