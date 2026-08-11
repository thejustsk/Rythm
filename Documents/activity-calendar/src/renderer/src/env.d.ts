/// <reference types="vite/client" />

declare global {
  interface Window {
    api: import('@shared/types').Api
  }
}

export {}
