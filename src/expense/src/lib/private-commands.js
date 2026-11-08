/** App-local unit of work: build a detached draft, commit through the shared
 * transaction API, then publish. This is not a transport or a storage fallback. */
const stateKeys = ['settings', 'categories', 'reports', 'months', '_months', '_statements'];
const monthPath = key => `expenses-data/exp-${key}.json`;
const validMonth = key => /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
const validReceipt = path => /^expenses-data\/receipts\/[A-Za-z0-9_-]{1,100}\.(jpg|jpeg|png|webp|heic|gif|pdf|bin)$/.test(path);

function validateMonths(expenses) {
  if (!expenses || typeof expenses !== 'object' || Array.isArray(expenses)) throw new Error('Invalid expense months');
  const ids = new Set();
  for (const [key, list] of Object.entries(expenses)) {
    if (!validMonth(key) || !Array.isArray(list)) throw new Error('Invalid expense month');
    for (const e of list) {
      if (!e || !/^[A-Za-z0-9_-]{1,100}$/.test(e.id) || ids.has(e.id)) throw new Error('Invalid or duplicate expense ID');
      ids.add(e.id);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || e.date.slice(0,7) !== key || !Number.isFinite(Date.parse(e.date)) || new Date(e.date).toISOString().slice(0,10) !== e.date) throw new Error('Invalid expense date/month');
      if (e.receiptPath && !validReceipt(e.receiptPath)) throw new Error('Invalid receipt reference');
    }
  }
}

function capture(value) {
  if (value instanceof Blob) return value; // immutable bytes; structuredClone differs in jsdom
  if (Array.isArray(value)) return value.map(capture);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,capture(v)]));
  return value;
}

export function installPrivateCommands(store, makeDraft) {
  let tail = Promise.resolve();
  let pending = 0;
  store.error = null;
  Object.defineProperty(store, 'dirty', { get: () => !!(pending || store.error || store.sdk?.dirty) });
  for (const name of ['saveExpenseWithReceipt', 'addExpense', 'updateExpense', 'deleteExpense', 'updateSettings', 'addCategory', 'updateCategory', 'deleteCategory', 'createReport', 'updateReport', 'transitionReport', 'deleteReport', 'setReport', 'addStatementLines', 'matchLine', 'unmatchLine', 'deleteStatementLine', 'deleteStatementBatch', 'importAll', 'wipeAll']) {
    const original = store[name];
    store[name] = function (...args) {
      if (store.sdk?.mode !== 'private') return original.apply(store, args);
      const captured = capture(args);
      pending++;
      store.dispatchEvent(new Event('storage-state'));
      const work = tail.then(async () => {
        const sdk = store.sdk;
        if (sdk.conflict) throw sdk.conflict;
        const operations = new Map();
        const cleanup = new Set();
        const stage = op => { operations.set(`${op.kind}:${op.key ?? op.path}`, op); };
        const draft = makeDraft({
          mode: 'private', auth: sdk.auth,
          kv: { get: sdk.kv.get, set: async (key, value) => stage({kind:'kv', key, method:'PUT', value:structuredClone(value)}) },
          fs: { ...sdk.fs,
            write: async (path, value) => value instanceof Blob
              ? sdk.fs.write(path, value)
              : stage({kind:'file', path, method:'PUT', value}),
            delete: async path => path.startsWith('expenses-data/receipts/')
              ? cleanup.add(path)
              : stage({kind:'file', path, method:'DELETE'}),
          },
        });
        for (const key of stateKeys) draft[key] = structuredClone(store[key]);
        draft.user = store.user;
        const changes = [];
        draft.emit = (type, detail) => changes.push([type, detail]);
        if (name === 'importAll' || name === 'wipeAll') {
          const incoming = name === 'importAll' ? captured[0]?.expenses || {} : {};
          validateMonths(incoming);
          await draft.loadAll();
          await draft.loadStatements();
          for (const key of Object.keys(incoming)) await draft.loadMonth(key);
        }
        if (name === 'transitionReport') await draft.loadAll();
        const result = await original.apply(draft, captured);
        if (cleanup.size) await draft.loadAll();
        draft.settings.autoOcr = false;
        validateMonths(Object.fromEntries(draft._months));
        if (name === 'transitionReport') {
          for (const key of draft.months) stage({kind:'file',path:monthPath(key),method:'PUT',value:JSON.stringify(draft._months.get(key))});
        }
        if ([...operations.values()].some(op => op.kind === 'file' && /^expenses-data\/exp-/.test(op.path))) {
          // Compare linked metadata too: a concurrent wipe/report transition must
          // not leave an orphan month or assign an expense to a deleted report.
          stage({kind:'kv',key:'exp:months:v1',method:'PUT',value:[...draft.months]});
          stage({kind:'file',path:'expenses-data/reports.json',method:'PUT',value:JSON.stringify(draft.reports)});
        }
        if (operations.size) await sdk.transaction([...operations.values()]);
        for (const key of stateKeys) store[key] = draft[key];
        for (const [type, detail] of changes) store.emit(type, detail);
        for (const path of cleanup) {
          if (draft.allExpenses().some(e => e.receiptPath === path)) continue;
          try {
            await sdk.fs.read(path); // actual immutable bytes establish the deletion baseline
            await sdk.fs.delete(path);
          } catch (err) {
            if (err.code !== 'ENOENT') store.error ||= new Error(`Saved metadata; receipt cleanup failed: ${err.message}`);
          }
        }
        return result;
      });
      tail = work.catch(() => {});
      return work.catch(err => { store.error ||= err; throw err; }).finally(() => {
        pending--;
        store.dispatchEvent(new Event('storage-state'));
      });
    };
  }
}
