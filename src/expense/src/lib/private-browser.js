import { preparePrivateBrowser } from '../../../../private_storage/browser.mjs';
export function prepareExpenseBrowser() {
  return preparePrivateBrowser({ cachePrefixes: ['expenses-'], serviceWorkerUrl: '/sw.js' });
}
