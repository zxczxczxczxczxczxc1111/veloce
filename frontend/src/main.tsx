import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import { LangProvider } from './i18n/LangProvider'
import { Shell } from './components/layout/Shell'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <LangProvider>
      <Shell />
    </LangProvider>
  </React.StrictMode>,
)
