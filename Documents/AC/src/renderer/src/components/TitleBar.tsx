import { useEffect, useState } from 'react'

/** macOS-style traffic-light title bar (frameless window). */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    return window.api.window.onMaximizedChange(setMaximized)
  }, [])

  return (
    <div className="titlebar">
      <div className="traffic-lights">
        <button className="tl tl-close" title="Close" onClick={() => window.api.window.close()}>
          <svg viewBox="0 0 12 12"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button className="tl tl-min" title="Minimize" onClick={() => window.api.window.minimize()}>
          <svg viewBox="0 0 12 12"><path d="M3 6h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button className="tl tl-max" title={maximized ? 'Restore' : 'Maximize'} onClick={() => window.api.window.toggleMaximize()}>
          <svg viewBox="0 0 12 12">
            {maximized ? (
              <path d="M4.5 4.5V3.5h4v4h-1M4 5h3.5v3.5H4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
            ) : (
              <path d="M3.5 3.5h5v5h-5z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
            )}
          </svg>
        </button>
      </div>
      <div className="titlebar-title">Rhythm</div>
    </div>
  )
}
