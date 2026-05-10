import mongoose from 'mongoose'

const salaryConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    rates: { type: Object, default: {} },
  },
  {
    versionKey: false,
    strict: false,
    collection: 'salary_config',
  },
)

export const SalaryConfigModel =
  mongoose.models.SalaryConfigModel || mongoose.model('SalaryConfigModel', salaryConfigSchema)
