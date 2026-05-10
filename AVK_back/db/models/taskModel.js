import mongoose from 'mongoose'

const taskSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
  },
  {
    versionKey: false,
    strict: false,
    collection: 'tasks',
  },
)

export const TaskModel = mongoose.models.TaskModel || mongoose.model('TaskModel', taskSchema)
