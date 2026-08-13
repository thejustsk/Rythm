import { useUi } from '@/state/store'
import { useCoins } from '@/state/coins'
import { useToasts } from '@/state/toasts'
import Coin from './Coin'

/** cup 3: confirmation dialog when the Coins pill in the header is clicked.
 *  Toggles the whole coin system (settings 'coinSystem'):
 *   OFF → no "How did it go?", no coin widgets in the sidebar, no coin
 *         toasters, Coins page shows a "disabled" notice. All data is kept —
 *         turning it ON resumes exactly where it left off. */
export default function CoinSystemDialog() {
  const ui = useUi()
  const systemOn = useCoins((s) => s.systemOn)
  if (!ui.coinSystemConfirm) return null

  const confirm = async () => {
    const next = !systemOn
    await useCoins.getState().setSystem(next)
    useToasts.getState().push({
      message: next ? '🪙 Rhythm Coins enabled — welcome back!' : '🪙 Rhythm Coins disabled — data kept, ready to resume anytime.',
      kind: 'info',
      duration: 4000
    })
    ui.closeCoinSystemConfirm()
    void useCoins.getState().refresh()
    // enabling never re-opens prompts or adds coins — it simply resumes
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && ui.closeCoinSystemConfirm()}>
      <div className="dialog coin-system-dialog">
        <div className="dialog-title">
          <Coin size={20} /> {systemOn ? 'Turn Rhythm Coins OFF?' : 'Turn Rhythm Coins ON?'}
        </div>
        <div className="repeat-note muted">
          {systemOn ? (
            <>
              While OFF: the "How did it go?" prompt stops appearing, Rhythm Coins
              widgets are hidden from the sidebar, and coin toasts won't show. Your
              balance and progress are kept — turning it back ON resumes exactly where you left off.
            </>
          ) : (
            <>
              Turn Rhythm Coins back on? Your balance, milestones and streak are
              all still here — it will resume exactly where you left off.
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={ui.closeCoinSystemConfirm}>
            Cancel
          </button>
          <button className={`btn ${systemOn ? 'danger' : 'primary'}`} onClick={() => void confirm()}>
            {systemOn ? 'Yes, disable' : 'Yes, enable'}
          </button>
        </div>
      </div>
    </div>
  )
}
