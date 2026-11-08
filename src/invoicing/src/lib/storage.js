import { createPrivateStorage } from './private-storage.js';

// This is a build choice, never inferred from failed authentication. A private
// deployment must not fall back to Puter or pretend a Puter user signed in.
export const isPrivate = import.meta.env.VITE_PRIVATE_STORAGE === '1';
let privateStorage;
const local = () => (privateStorage ??= createPrivateStorage({
  onConflict: () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('invoicing-storage-conflict'));
  },
}));

export const storage = {
  get kv() { return isPrivate ? local().kv : globalThis.puter.kv; },
  get fs() { return isPrivate ? local().fs : globalThis.puter.fs; },
  getUser() {
    return isPrivate ? local().getUser() : globalThis.puter.auth.getUser();
  },
};
