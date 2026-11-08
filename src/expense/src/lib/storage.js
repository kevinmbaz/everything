import { createPrivateStorage } from '../../../../private_storage/client.mjs';

export const isPrivateStorage = import.meta.env.VITE_PRIVATE_STORAGE === '1';
let privateStorage;
export function getStorage() {
  if (!isPrivateStorage) return globalThis.puter;
  return privateStorage ||= createPrivateStorage({ app: 'expense' });
}
export async function prepareStorageBrowser() {
  if (!isPrivateStorage) return;
  const { prepareExpenseBrowser } = await import('./private-browser.js');
  await prepareExpenseBrowser();
}
