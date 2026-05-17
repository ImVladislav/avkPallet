import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import './AppDialog.css'

export type AppConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Червона кнопка підтвердження (видалення тощо) */
  danger?: boolean
}

export type AppAlertOptions = {
  title: string
  message: string
  okLabel?: string
}

type DialogState =
  | {
      kind: 'confirm'
      options: AppConfirmOptions
      resolve: (value: boolean) => void
    }
  | {
      kind: 'alert'
      options: AppAlertOptions
      resolve: () => void
    }

type AppDialogContextValue = {
  confirm: (options: AppConfirmOptions) => Promise<boolean>
  showAlert: (options: AppAlertOptions) => Promise<void>
}

const AppDialogContext = createContext<AppDialogContextValue | null>(null)

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null)

  const confirm = useCallback((options: AppConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ kind: 'confirm', options, resolve })
    })
  }, [])

  const showAlert = useCallback((options: AppAlertOptions) => {
    return new Promise<void>((resolve) => {
      setState({ kind: 'alert', options, resolve })
    })
  }, [])

  const ctx = useMemo(() => ({ confirm, showAlert }), [confirm, showAlert])

  const closeConfirm = useCallback((value: boolean) => {
    setState((s) => {
      if (s?.kind === 'confirm') {
        s.resolve(value)
      }
      return null
    })
  }, [])

  const closeAlert = useCallback(() => {
    setState((s) => {
      if (s?.kind === 'alert') {
        s.resolve()
      }
      return null
    })
  }, [])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (state.kind === 'confirm') closeConfirm(false)
      else closeAlert()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, closeConfirm, closeAlert])

  return (
    <AppDialogContext.Provider value={ctx}>
      {children}
      {state?.kind === 'confirm' && (
        <div
          className="appDialogBackdrop"
          role="presentation"
          onClick={() => closeConfirm(false)}
        >
          <div
            className="appDialogModal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="appDialogTitle"
            aria-describedby="appDialogDesc"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="appDialogTitle" className="appDialogTitle">
              {state.options.title}
            </h2>
            <p id="appDialogDesc" className="appDialogMessage">
              {state.options.message}
            </p>
            <div className="appDialogActions">
              <button
                type="button"
                className="ghost appDialogBtnSecondary"
                onClick={() => closeConfirm(false)}
              >
                {state.options.cancelLabel ?? 'Скасувати'}
              </button>
              <button
                type="button"
                className={
                  state.options.danger ? 'appDialogBtnDanger' : 'appDialogBtnPrimary'
                }
                onClick={() => closeConfirm(true)}
              >
                {state.options.confirmLabel ?? 'Підтвердити'}
              </button>
            </div>
          </div>
        </div>
      )}
      {state?.kind === 'alert' && (
        <div
          className="appDialogBackdrop"
          role="presentation"
          onClick={() => closeAlert()}
        >
          <div
            className="appDialogModal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="appDialogAlertTitle"
            aria-describedby="appDialogAlertDesc"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="appDialogAlertTitle" className="appDialogTitle">
              {state.options.title}
            </h2>
            <p id="appDialogAlertDesc" className="appDialogMessage">
              {state.options.message}
            </p>
            <div className="appDialogActions appDialogActionsSingle">
              <button type="button" className="appDialogBtnPrimary" onClick={() => closeAlert()}>
                {state.options.okLabel ?? 'Зрозуміло'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppDialogContext.Provider>
  )
}

export function useAppDialog(): AppDialogContextValue {
  const v = useContext(AppDialogContext)
  if (!v) {
    throw new Error('useAppDialog має бути всередині AppDialogProvider')
  }
  return v
}
