import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { Login } from './components/Login'
import { AppLayout } from './components/layout/AppLayout'
import { useAuth } from './context/AuthContext'
import { BoardsPage } from './pages/BoardsPage'
import { BandSawPage } from './pages/BandSawPage'
import { CircularSawPage } from './pages/CircularSawPage'
import { StripSawPage } from './pages/StripSawPage'
import { LogsPage } from './pages/LogsPage'
import { WorkJournalPage } from './pages/WorkJournalPage'
import { PalletsPage } from './pages/PalletsPage'
import { TasksPage } from './pages/TasksPage'
import { WarehousePage } from './pages/WarehousePage'
import { ProtectedRoute } from './routes/ProtectedRoute'
import { firstAllowedPath } from './routes/paths'
import './styles/layout.css'

function AppLoading() {
  return (
    <div className="appLoading">
      <p>Завантаження…</p>
    </div>
  )
}

function LoginRoute() {
  const { user, loading } = useAuth()
  if (loading) return <AppLoading />
  if (user) return <Navigate to={firstAllowedPath(user.tabs)} replace />
  return <Login />
}

function RequireUser() {
  const { user, loading } = useAuth()
  if (loading) return <AppLoading />
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}

function HomeRedirect() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <Navigate to={firstAllowedPath(user.tabs)} replace />
}

function App() {
  const { loading } = useAuth()

  if (loading) {
    return <AppLoading />
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RequireUser />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomeRedirect />} />
          <Route
            path="/logs"
            element={
              <ProtectedRoute tab="logs">
                <LogsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/work-journal"
            element={
              <ProtectedRoute tab="work_journal">
                <WorkJournalPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/band-saw"
            element={
              <ProtectedRoute tab="band_saw">
                <BandSawPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/strip-saw"
            element={
              <ProtectedRoute tab="strip_saw">
                <StripSawPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/circular-saw"
            element={
              <ProtectedRoute tab="circular_saw">
                <CircularSawPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/tasks"
            element={
              <ProtectedRoute tab="tasks">
                <TasksPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/warehouse"
            element={
              <ProtectedRoute tab="warehouse">
                <WarehousePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/pallets"
            element={
              <ProtectedRoute tab="pallets">
                <PalletsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/boards"
            element={
              <ProtectedRoute tab="boards">
                <BoardsPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<HomeRedirect />} />
        </Route>
      </Route>
    </Routes>
  )
}

export default App
