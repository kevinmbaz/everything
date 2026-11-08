import { createContactsStorage } from './private-storage.js'

export const privateMode = import.meta.env.VITE_PRIVATE_STORAGE === '1'
let privateStorage
// An app-local adapter, never a global SDK replacement.
export function getStorage() {
  if (!privateMode) return window.puter
  return privateStorage ??= createContactsStorage()
}
