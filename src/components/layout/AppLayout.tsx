import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { TAB_LABELS, TAB_ORDER, TAB_PATHS, pathToTab } from '../../routes/paths'
import '../../styles/layout.css'

export function AppLayout() {
  const { user, logout, canTab } = useAuth()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)

  const tab = pathToTab(location.pathname)
  const pageTitle = tab ? TAB_LABELS[tab] : 'Розділ'

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [menuOpen])

  const visibleTabs = TAB_ORDER.filter((id) => canTab(id))

  return (
    <div className="appShell">
      <div
        className={`drawerBackdrop ${menuOpen ? 'isOpen' : ''}`}
        onClick={() => setMenuOpen(false)}
        aria-hidden={!menuOpen}
      />
      <aside
        className={`drawer ${menuOpen ? 'isOpen' : ''}`}
        id="app-drawer"
        aria-hidden={!menuOpen}
        aria-label="Головне меню"
      >
        <div className="drawerHeader">
          <span className="drawerTitle">Розділи</span>
          <button
            type="button"
            className="drawerClose"
            onClick={() => setMenuOpen(false)}
            aria-label="Закрити меню"
          >
            ×
          </button>
        </div>
        <nav className="drawerNav">
          {visibleTabs.map((id, i) => (
            <NavLink
              key={id}
              to={TAB_PATHS[id]}
              className={({ isActive }) => `drawerLink ${isActive ? 'active' : ''}`}
              onClick={() => setMenuOpen(false)}
            >
              <span className="drawerLinkNum">{i + 1}</span>
              {TAB_LABELS[id]}
            </NavLink>
          ))}
        </nav>
        <div className="drawerFooter">
          <span className="drawerUser">
            {user?.displayName} · {user?.username}
          </span>
        </div>
      </aside>

      <main className="layout">
        <header className="appHeader">
          <div className="appHeaderMain">
            <button
              type="button"
              className="burgerBtn"
              onClick={() => setMenuOpen(true)}
              aria-label="Відкрити меню"
              aria-expanded={menuOpen}
              aria-controls="app-drawer"
            >
              <span className="burgerLine" />
              <span className="burgerLine" />
              <span className="burgerLine" />
            </button>
            <div className="appHeaderTitles">
              <h1>Виробництво піддонів і дошок</h1>
              <p>
                <span className="pageCrumb">{pageTitle}</span>
                {' · '}
                Облік кругляка та оптимізація порізки
              </p>
            </div>
          </div>
          <div className="userBar">
            <span className="userName">
              {user?.displayName} ({user?.username})
            </span>
            <button type="button" className="ghost" onClick={() => logout()}>
              Вийти
            </button>
          </div>
        </header>

        <Outlet />
      </main>
    </div>
  )
}
