import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'danger'
  actionLabel?: string
  onAction?: () => void
  duration?: number
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
  clear: () => void
}

let nextId = 1

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++
    set({ toasts: [...get().toasts, { ...t, id }] })
    const dur = t.duration ?? (t.actionLabel ? 6000 : 2500)
    setTimeout(() => get().dismiss(id), dur)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
  clear: () => set({ toasts: [] })
}))
