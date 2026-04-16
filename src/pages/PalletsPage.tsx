import { AssignedTasksPanel } from '../components/AssignedTasksPanel'
import { useAuth } from '../context/AuthContext'

export function PalletsPage() {
  const { user } = useAuth()
  return (
    <>
      {user?.role === 'pallet_assembly' && <AssignedTasksPanel />}
      <section className="panel">
        <h2>Піддони</h2>
        <p>Заготовка під наступний етап: рецепти піддонів, норми матеріалу, собівартість.</p>
      </section>
    </>
  )
}
