import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'

// Surface any renderer errors for the automated smoke test
declare global {
  interface Window {
    __errors?: string[]
  }
}
window.__errors = []
window.addEventListener('error', (e) => {
  window.__errors!.push(String(e.error ?? e.message))
})
window.addEventListener('unhandledrejection', (e) => {
  window.__errors!.push(String(e.reason))
})

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
