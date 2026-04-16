import { AssignedTasksPanel } from '../components/AssignedTasksPanel'
import { useAuth } from '../context/AuthContext'

export function BoardsPage() {
  const { user } = useAuth()
  return (
    <>
      {user?.role === 'pallet_assembly' && <AssignedTasksPanel />}
      <section className="panel">
        <h2>Дошки</h2>
        <p>Заготовка під наступний етап: облік дощок, сортування та склад.</p>
      </section>
    </>
  )
}
