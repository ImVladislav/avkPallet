import { Link } from 'react-router-dom'
import '../components/Login.css'
import './HelpPage.css'

export function HelpPage() {
  return (
    <div className="loginPage">
      <div className="loginCard helpCard">
        <h1>Довідка</h1>
        <p className="loginSub">Тестові облікові записи для розгортання</p>

        <section className="helpSection">
          <h2>Тестові акаунти</h2>
          <p>Пароль для всіх тестових користувачів: <strong>1</strong></p>
          <ul className="helpList">
            <li>
              <strong>rozpyl</strong> — стрічкова пила
            </li>
            <li>
              <strong>cyrkul</strong> — циркулярка
            </li>
            <li>
              <strong>zbirka</strong> — збірка
            </li>
            <li>
              <strong>brygadyr</strong> — бригадир (розділ «Завдання» на маршруті <code>/tasks</code>)
            </li>
            <li>
              <strong>admin</strong> — адміністратор
            </li>
          </ul>
        </section>

        <section className="helpSection">
          <h2>Якщо не вдається увійти з прод-сайту</h2>
          <p className="helpHint">
            На хостингу фронту (наприклад Vercel) має бути змінна{' '}
            <code>VITE_API_BASE_URL</code> з URL бекенду без слешу в кінці, наприклад{' '}
            <code>https://avkpallet-back.onrender.com</code>. На Render для бекенду в{' '}
            <code>CORS_ORIGINS</code> вкажіть URL вашого фронту через кому.
          </p>
        </section>

        <p className="loginHelpLink">
          <Link to="/login">← Назад до входу</Link>
        </p>
      </div>
    </div>
  )
}
