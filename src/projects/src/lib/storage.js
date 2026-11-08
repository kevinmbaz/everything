import { createPrivateStorage } from './private-storage.js';

export const isPrivateStorage = import.meta.env?.VITE_PRIVATE_STORAGE === '1';
export const storageLabel = isPrivateStorage ? 'Jetson storage' : 'Puter';

// Lazy access preserves the upstream SDK bootstrap and test doubles. Nothing
// installs or impersonates a global Puter object in the private build.
const cloud = {
  get kv() { return globalThis.puter.kv; },
  get fs() { return globalThis.puter.fs; },
  getUser: () => globalThis.puter.auth.getUser(),
};
export const storage = isPrivateStorage ? createPrivateStorage() : cloud;
export const cloudUI = () => isPrivateStorage ? null : globalThis.puter?.ui;
export const isPuterDesktop = () => !isPrivateStorage && globalThis.puter?.env === 'app';
export const auth = {
  isAvailable: () => isPrivateStorage || !!globalThis.puter,
  isSignedIn: () => isPrivateStorage ? storage.getUser().then(() => true) : globalThis.puter.auth.isSignedIn(),
  signIn: () => isPrivateStorage ? storage.getUser() : globalThis.puter.auth.signIn(),
  signOut: () => {
    if (isPrivateStorage) throw new Error('Private access is managed by your authenticated connection, not Puter');
    return globalThis.puter.auth.signOut();
  },
};
