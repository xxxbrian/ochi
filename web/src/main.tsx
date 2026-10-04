import React from 'react'
import ReactDOM from 'react-dom/client'
import './design/tokens.css'
import './styles.css'
import './components/ui/ui.css'
import './pages/pages.css'
import './pages/admin/admin.css'
import App from './App'
import { ComputerPanel } from './components/ComputerPanel'

const nativeComputer = window.location.pathname === '/native/computer'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {nativeComputer ? <ComputerPanel standalone onClose={() => window.history.back()} /> : <App />}
  </React.StrictMode>,
)
