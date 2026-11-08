import { describe, it, expect, vi } from 'vitest';
import { Store, REPORTS_PATH, monthPath } from '../src/lib/store.js';

function privateSdk() {
  const kv = new Map();
  const files = new Map();
  const sdk = {
    mode: 'private',
    auth: { getUser: vi.fn(async () => ({ storage: 'jetson', app: 'expense' })) },
    kv: { get: vi.fn(async k => kv.get(k) ?? null), set: vi.fn(async (k,v) => kv.set(k, structuredClone(v))) },
    fs: {
      readdir: vi.fn(async () => []),
      read: vi.fn(async p => { if (!files.has(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { text: async () => files.get(p) }; }),
      write: vi.fn(async (p,v) => { files.set(p,v); return { path:p }; }),
      delete: vi.fn(async p => files.delete(p)),
    },
    transaction: vi.fn(async ops => { for (const op of ops) { const map = op.kind === 'kv' ? kv : files; const key = op.key ?? op.path; if (op.method === 'DELETE') map.delete(key); else map.set(key, structuredClone(op.value)); } return { ok:true }; }),
  };
  return { sdk, kv, files, store: new Store(() => sdk) };
}

export { privateSdk };

describe('private atomic edits', () => {
  it('commits month and index together, never publishes rejected state', async () => {
    const { store, sdk, kv, files } = privateSdk();
    await store.init();
    sdk.transaction.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.addExpense({ merchant:'Draft', date:'2026-01-02', amount:12 })).rejects.toThrow('disk full');
    expect(store.months).toEqual([]);
    expect(store.allExpenses()).toEqual([]);
    expect(kv.size).toBe(0);
    expect(files.size).toBe(0);
    expect(store.dirty).toBe(true);
    expect(store.error.message).toBe('disk full');
    await store.addExpense({ merchant:'Later', date:'2026-01-03', amount:13 });
    expect(sdk.transaction).toHaveBeenCalledTimes(2);
    expect(sdk.transaction.mock.calls[1][0].map(o => o.key ?? o.path).sort()).toEqual(['exp:months:v1',monthPath('2026-01'),REPORTS_PATH]);
    expect(sdk.kv.set).not.toHaveBeenCalled();
    expect(sdk.fs.write).not.toHaveBeenCalled();
    expect(store.dirty).toBe(true); // an unrelated success cannot acknowledge the failed draft
  });
});

describe('private compound commands', () => {
  it('serializes simultaneous cross-month moves and rolls back a rejected move', async () => {
    const { store, sdk, files } = privateSdk();
    await store.init();
    const e = await store.addExpense({date:'2026-01-02', merchant:'One', amount:1});
    sdk.transaction.mockRejectedValueOnce(new Error('conflict'));
    await expect(store.updateExpense(e.id, {date:'2026-02-02'})).rejects.toThrow('conflict');
    expect(store.getExpense(e.id).date).toBe('2026-01-02');
    expect(files.has(monthPath('2026-02'))).toBe(false);
    await Promise.all([store.updateExpense(e.id, {date:'2026-02-02'}), store.updateExpense(e.id, {date:'2026-03-02', notes:'Latest'})]);
    expect(store.allExpenses()).toHaveLength(1);
    expect(store.getExpense(e.id)).toMatchObject({date:'2026-03-02', notes:'Latest'});
    expect(JSON.parse(files.get(monthPath('2026-01')))).toEqual([]);
    expect(JSON.parse(files.get(monthPath('2026-02')))).toEqual([]);
  });
  it.each([
    ['updateSettings', [{baseCurrency:'EUR'}]], ['addCategory', [{name:'New'}]],
    ['updateCategory', ['meals',{name:'Changed'}]], ['deleteCategory', ['meals']],
    ['createReport', [{title:'Travel'}]], ['addStatementLines', [[{date:'2026-01-01',amount:1}]]],
    ['importAll', [{app:'expenses',expenses:{},reports:[],statements:[]}]], ['wipeAll', []],
  ])('%s rejects without changing visible metadata', async (name,args) => {
    const { store, sdk } = privateSdk(); await store.init();
    const before = JSON.stringify(await store.exportAll());
    sdk.transaction.mockRejectedValueOnce(new Error('denied'));
    await expect(store[name](...args)).rejects.toThrow('denied');
    const after = await store.exportAll(); const original = JSON.parse(before);
    delete after.exportedAt; delete original.exportedAt;
    expect(after).toEqual(original);
  });
});

describe('private linked documents', () => {
  it.each(['setReport','updateReport','transitionReport','deleteReport','matchLine','unmatchLine','deleteStatementLine','deleteStatementBatch','deleteExpense'])('%s is one atomic commit and preserves linked state on failure', async name => {
    const { store, sdk } = privateSdk(); await store.init();
    const e = await store.addExpense({date:'2026-01-02',amount:1,merchant:'A'});
    const report = await store.createReport({title:'Trip'});
    const {added:[line],batchId} = await store.addStatementLines([{date:e.date,amount:1}]);
    await store.setReport([e.id], report.id);
    await store.matchLine(line.id,e.id);
    const args = {
      setReport:[[e.id],null], updateReport:[report.id,{title:'Changed'}], transitionReport:[report.id,'submitted'],
      deleteReport:[report.id], matchLine:[line.id,e.id], unmatchLine:[line.id],
      deleteStatementLine:[line.id], deleteStatementBatch:[batchId], deleteExpense:[e.id],
    }[name];
    const before = await store.exportAll(); delete before.exportedAt;
    sdk.transaction.mockRejectedValueOnce(new Error('stale'));
    await expect(store[name](...args)).rejects.toThrow('stale');
    const after = await store.exportAll(); delete after.exportedAt;
    expect(after).toEqual(before);
    sdk.transaction.mockClear(); sdk.fs.write.mockClear();
    await store[name](...args);
    expect(sdk.fs.write).not.toHaveBeenCalled();
    expect(sdk.transaction).toHaveBeenCalledTimes(1);
    const ops = sdk.transaction.mock.calls[0][0];
    expect(new Set(ops.map(o=>o.key ?? o.path)).size).toBe(ops.length);
  });
});

describe('private receipt staging', () => {
  it('uses unique immutable names and never deletes old bytes on rejected metadata', async () => {
    const {store,sdk,files} = privateSdk(); await store.init();
    const old = 'expenses-data/receipts/old.png'; files.set(old,'original');
    const exp = await store.addExpense({date:'2026-01-02',amount:1,receiptPath:old});
    const file = new File(['new'], 'replacement.png', {type:'image/png'});
    expect(typeof store.saveExpenseWithReceipt).toBe('function');
    sdk.transaction.mockRejectedValueOnce(new Error('stale'));
    await expect(store.saveExpenseWithReceipt({id:exp.id,data:{merchant:'Draft'},file})).rejects.toThrow('stale');
    expect(files.get(old)).toBe('original');
    expect(store.getExpense(exp.id).receiptPath).toBe(old);
    expect(sdk.fs.delete).not.toHaveBeenCalled();
    const saved = await store.saveExpenseWithReceipt({id:exp.id,data:{merchant:'Saved'},file});
    expect(saved.receiptPath).toMatch(/^expenses-data\/receipts\/[A-Za-z0-9_-]+\.png$/);
    expect(saved.receiptPath).not.toBe(old);
    expect(sdk.fs.write.mock.calls[0][0]).not.toBe(sdk.fs.write.mock.calls[1][0]);
    expect(sdk.fs.write.mock.calls[1][1]).toBe(file);
    expect(files.has(old)).toBe(false);
    expect(sdk.fs.delete.mock.invocationCallOrder[0]).toBeGreaterThan(sdk.transaction.mock.invocationCallOrder.at(-1));
  });
  it('retains receipt bytes still referenced by an unloaded month', async () => {
    const {store,sdk,files} = privateSdk(); await store.init();
    const path='expenses-data/receipts/shared.png'; files.set(path,'shared bytes');
    const a=await store.addExpense({date:'2026-01-01',amount:1,receiptPath:path});
    await store.addExpense({date:'2026-02-01',amount:2,receiptPath:path});
    const fresh=new Store(()=>sdk); await fresh.init(); await fresh.loadMonth('2026-01');
    await fresh.deleteExpense(a.id);
    expect(files.get(path)).toBe('shared bytes');
    expect(sdk.fs.delete).not.toHaveBeenCalled();
  });
  it('surfaces private receipt deletion failures instead of treating denial as missing', async () => {
    const {store,sdk}=privateSdk(); await store.init();
    sdk.fs.delete.mockRejectedValueOnce(new Error('denied'));
    await expect(store.deleteReceipt('expenses-data/receipts/r.png')).rejects.toThrow('denied');
  });
  it('does not create metadata after upload failure and enforces receipt limits', async () => {
    const {store,sdk} = privateSdk(); await store.init();
    expect(typeof store.saveExpenseWithReceipt).toBe('function');
    sdk.fs.write.mockRejectedValueOnce(new Error('upload denied'));
    await expect(store.saveExpenseWithReceipt({data:{date:'2026-01-02',amount:1},file:new File(['x'],'x.png',{type:'image/png'})})).rejects.toThrow('upload denied');
    expect(sdk.transaction).not.toHaveBeenCalled();
    expect(store.months).toEqual([]);
    await expect(store.saveReceipt('x',new File(['x'],'x.html',{type:'text/html'}))).rejects.toThrow();
    await expect(store.saveReceipt('x',{size:10*1024*1024+1,type:'image/png',name:'x.png'})).rejects.toThrow();
  });
});

describe('private dependency and migration safety', () => {
  it('includes report and index preconditions when changing existing expenses or report state', async () => {
    const {store,sdk} = privateSdk(); await store.init();
    const e = await store.addExpense({date:'2026-01-02',amount:1});
    const r = await store.createReport({title:'Trip'});
    await store.setReport([e.id],r.id);
    expect(sdk.transaction.mock.calls.at(-1)[0].map(o=>o.key ?? o.path)).toContain(REPORTS_PATH);
    expect(sdk.transaction.mock.calls.at(-1)[0].map(o=>o.key ?? o.path)).toContain('exp:months:v1');
    await store.transitionReport(r.id,'submitted');
    expect(sdk.transaction.mock.calls.at(-1)[0].map(o=>o.key ?? o.path)).toContain(monthPath('2026-01'));
  });
  it('validates imports before committing and observes replaced files, including stale months', async () => {
    const {store,sdk} = privateSdk(); await store.init();
    const data = {app:'expenses',expenses:{'2026-13':[]}};
    await expect(store.importAll(data)).rejects.toThrow(/month/i);
    await expect(store.importAll({app:'expenses',expenses:{'2026-01':[{id:'../bad',date:'2026-01-02'}]}})).rejects.toThrow();
    await expect(store.importAll({app:'expenses',expenses:{'2026-01':[{id:'safe',date:'2026-01-02',receiptPath:'https://example.test/r'}]}})).rejects.toThrow();
    expect(sdk.transaction).not.toHaveBeenCalled();
    await store.importAll({app:'expenses',settings:{autoOcr:true},expenses:{'2026-01':[]}});
    expect(sdk.fs.read.mock.calls.map(c=>c[0])).toContain(monthPath('2026-01'));
    expect(store.settings.autoOcr).toBe(false);
  });
  it('wipes only observed receipt files after metadata commits, without directory deletes', async () => {
    const {store,sdk,files} = privateSdk(); await store.init();
    const p='expenses-data/receipts/keep.png'; files.set(p,'bytes');
    sdk.fs.readdir=vi.fn(async()=>[{path:p}]);
    await store.wipeAll();
    expect(sdk.transaction.mock.calls.at(-1)[0].some(o=>o.path==='expenses-data/receipts')).toBe(false);
    expect(sdk.fs.delete).toHaveBeenCalledWith(p);
    expect(files.has(p)).toBe(false);
  });
});

describe('private strict reads', () => {
  it('latches malformed read errors in the storage indicator and rejects a failed queued read cleanly', async () => {
    const {store,sdk,files}=privateSdk(); await store.init();
    files.set(monthPath('2026-01'),'{corrupt');
    await expect(store.loadMonth('2026-01')).rejects.toThrow();
    expect(store.error).toBeTruthy(); expect(store.dirty).toBe(true);
    sdk.fs.read.mockRejectedValueOnce(new Error('read denied'));
    await expect(store.addExpense({date:'2026-02-01',amount:1})).rejects.toThrow('read denied');
    expect(sdk.transaction).not.toHaveBeenCalled();
  });
  it('authenticates before any data read and rejects legacy string KV', async () => {
    const {sdk,kv,store} = privateSdk();
    sdk.auth.getUser.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(store.init()).rejects.toThrow('unauthorized');
    expect(sdk.kv.get).not.toHaveBeenCalled();
    expect(sdk.fs.read).not.toHaveBeenCalled();
    kv.set('exp:settings:v1', '{"autoOcr":true}');
    await expect(store.init()).rejects.toThrow(/settings/i);
    kv.set('exp:settings:v1', {autoOcr:true});
    await store.init(); expect(store.settings.autoOcr).toBe(false);
    await store.updateSettings({autoOcr:true}); expect(store.settings.autoOcr).toBe(false);
  });
  it('rejects denied and corrupt documents instead of treating them as empty', async () => {
    const { sdk, files, store } = privateSdk();
    sdk.fs.read.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'FORBIDDEN' }));
    await expect(store.init()).rejects.toThrow('denied');
    expect(store.ready).toBe(false);
    files.set(REPORTS_PATH, '{broken');
    await expect(store.init()).rejects.toThrow();
    files.set(REPORTS_PATH, '{}');
    await expect(store.init()).rejects.toThrow();
    files.delete(REPORTS_PATH);
    await store.init();
    expect(store.reports).toEqual([]);
    files.set(monthPath('2026-01'), '');
    await expect(store.loadMonth('2026-01')).rejects.toThrow();
  });
});
