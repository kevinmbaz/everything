// @vitest-environment node
// Contract integration, not a backend deployment test: real shared client +
// real app Store against a deterministic revision-checking fetch fixture.
import { it, expect } from 'vitest';
import { createPrivateStorage } from '../../../private_storage/client.mjs';
import { Store, monthPath } from '../src/lib/store.js';

function revisionServer() {
  const records=new Map(); const calls=[];
  const get=id=>records.get(id) || {value:null,rev:0};
  const tag=r=>`"${r.rev}"`;
  const reply=(body,status=200,etag)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...(etag?{ETag:etag}:{})}});
  const fetch=async (url,options={})=>{
    calls.push({url,options});
    const u=new URL(url,'https://expense.test');
    if(u.pathname==='/api/session') return reply({app:'expense',storage:'jetson',username:'Jetson storage',uuid:'owner'});
    if(u.pathname==='/api/transaction') {
      const {operations}=JSON.parse(options.body);
      if(operations.some(o=>o.ifMatch!==tag(get(`${o.kind}:${o.key??o.path}`)))) return reply({error:'CONFLICT'},409);
      const revisions=operations.map(o=>{
        const id=`${o.kind}:${o.key??o.path}`; const next={value:o.method==='DELETE'?null:o.value,rev:get(id).rev+1}; records.set(id,next);
        return {kind:o.kind,...(o.kind==='kv'?{key:o.key}:{path:o.path}),etag:tag(next)};
      });
      return reply({ok:true,revisions});
    }
    const kind=u.pathname==='/api/kv'?'kv':'file'; const name=u.searchParams.get(kind==='kv'?'key':'path');
    const id=`${kind}:${name}`; const r=get(id);
    if(!options.method || options.method==='GET') {
      if(kind==='kv') return reply({value:r.value},200,tag(r));
      if(r.value===null) return reply({error:'ENOENT'},404,tag(r));
      if(u.searchParams.has('stat')) return reply({path:name,size:1,modified:r.rev},200,tag(r));
      return new Response(r.value,{headers:{ETag:tag(r)}});
    }
    if(options.headers['If-Match']!==tag(r)) return reply({error:'CONFLICT'},409);
    records.set(id,{value:options.method==='DELETE'?null:options.body,rev:r.rev+1});
    return reply({ok:true},200,tag(get(id)));
  };
  const client=()=>{const sdk=createPrivateStorage({app:'expense',fetch});return {sdk,store:new Store(()=>sdk)};};
  return {records,calls,client};
}
it('rejects a stale second client atomically and latches before another receipt upload', async () => {
  const server=revisionServer(); const a=server.client(); await a.store.init();
  const expense=await a.store.saveExpenseWithReceipt({data:{date:'2026-01-02',amount:42,merchant:'Original'},file:new File(['old bytes'],'old.png',{type:'image/png'})});
  const b=server.client(); await b.store.init(); await b.store.loadAll();
  await a.store.updateExpense(expense.id,{merchant:'Winner'});
  await expect(b.store.saveExpenseWithReceipt({id:expense.id,data:{date:'2026-02-02',merchant:'Stale'},file:new File(['loser bytes'],'new.png',{type:'image/png'})})).rejects.toMatchObject({code:'ECONFLICT'});
  expect(b.store.getExpense(expense.id).merchant).toBe('Original');
  expect(b.store.dirty).toBe(true);
  expect(server.records.get(`file:${expense.receiptPath}`).value).not.toBeNull();
  expect(server.records.has(`file:${monthPath('2026-02')}`)).toBe(false);
  const count=server.calls.length;
  await expect(b.store.saveExpenseWithReceipt({id:expense.id,data:{},file:new File(['retry'],'retry.png',{type:'image/png'})})).rejects.toMatchObject({code:'ECONFLICT'});
  expect(server.calls).toHaveLength(count);
  const reopened=server.client(); await reopened.store.init(); await reopened.store.loadAll();
  expect(reopened.store.getExpense(expense.id).merchant).toBe('Winner');
  expect(await (await reopened.store.readReceipt(expense.receiptPath)).text()).toBe('old bytes');
});
it('stores native JSON KV exactly once and transacts reconciliation with its month', async () => {
  const server=revisionServer(); const {store}=server.client(); await store.init();
  await store.updateSettings({baseCurrency:'EUR'});
  const wire=server.records.get('kv:exp:settings:v1').value;
  expect(JSON.parse(wire)).toMatchObject({baseCurrency:'EUR',autoOcr:false});
  const e=await store.addExpense({date:'2026-01-02',amount:5});
  const {added:[line]}=await store.addStatementLines([{date:e.date,amount:5}]);
  await store.matchLine(line.id,e.id);
  const tx=JSON.parse(server.calls.filter(c=>c.url==='/api/transaction').at(-1).options.body);
  expect(tx.operations.map(o=>o.path)).toEqual(expect.arrayContaining([monthPath('2026-01'),'expenses-data/statements.json']));
  const fresh=server.client(); await fresh.store.init(); await fresh.store.loadAll(); await fresh.store.loadStatements();
  expect(fresh.store.getExpense(e.id).statementLineId).toBe(line.id);
  expect(fresh.store.statementLine(line.id).matchedExpenseId).toBe(e.id);
});
