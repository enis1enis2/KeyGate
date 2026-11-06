import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { setAdminToken } from './api'
import { isDemoMode } from './demo/mode'
import { installMockApi } from './demo/mockApi'

if (isDemoMode()) {
  installMockApi()
  setAdminToken('keygate-demo')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
