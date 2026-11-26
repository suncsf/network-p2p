import type { LatticeApi } from './index'

declare global {
  interface Window {
    api: LatticeApi
  }
}
