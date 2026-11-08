import { existsSync } from 'node:fs';
import { it, expect, vi, afterEach } from 'vitest';
import { store } from '../src/lib/store.js';
import { openExpenseForm } from '../src/ui/expenseform.js';
import { openReportForm, reportsView } from '../src/views/reports.js';
import { settingsView, canSignOut } from '../src/views/settings.js';
import { openCapture } from '../src/ui/capture.js';
import { mountShell } from '../src/ui/shell.js';
import { closeAllModals } from '../src/ui/modal.js';
import { openOnboarding } from '../src/ui/onboarding.js';

const original = store.getSdk;
afterEach(() => {
  vi.spyOn(window,'confirm').mockReturnValue(true); closeAllModals();
  vi.restoreAllMocks(); store.getSdk = original;
  const toastRoot = document.querySelector('.toast-root');
  toastRoot?.replaceChildren();
  document.body.replaceChildren(...(toastRoot ? [toastRoot] : []));
});
function setup() {
  store.getSdk = () => ({mode:'private',events:new EventTarget()});
  store.reports=[]; store.months=[]; store._months=new Map();
  vi.spyOn(console,'error').mockImplementation(()=>{});
}
it('keeps the actual expense form and selected receipt after a rejected atomic save', async () => {
  setup();
  const save = vi.spyOn(store,'saveExpenseWithReceipt').mockRejectedValue(new Error('conflict'));
  const oldAdd = vi.spyOn(store,'addExpense').mockRejectedValue(new Error('wrong path'));
  const file = new File(['receipt'],'invoice.png',{type:'image/png'});
  const modal = openExpenseForm({prefill:{merchant:'Unsaved merchant',amount:25,date:'2026-01-01',notes:'Keep these notes'},receiptFile:file});
  const form = modal.panel.querySelector('form');
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].file).toBe(file);
  expect(oldAdd).not.toHaveBeenCalled();
  expect(modal.panel.querySelector('form')).toBe(form);
  expect(form.querySelector('textarea').value).toBe('Keep these notes');
  expect(form.textContent).toContain('invoice.png');
  expect(form.querySelector('button[type="submit"]').disabled).toBe(false);
  expect(modal.panel.closest('.modal-root').classList.contains('closing')).toBe(false);
});
it('preserves dirty report edits when Escape dismissal is rejected', async () => {
  setup(); vi.spyOn(window,'confirm').mockReturnValue(false);
  const modal = openReportForm();
  const input = modal.panel.querySelector('input'); input.value='Unsaved title';
  input.dispatchEvent(new Event('input',{bubbles:true}));
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
  expect(modal.panel.closest('.modal-root').classList.contains('closing')).toBe(false);
  expect(input.value).toBe('Unsaved title');
});
it('shows Jetson status and warns before unloading unsent form edits or failed writes', async () => {
  setup();
  expect(existsSync('src/ui/private-status.js')).toBe(true);
  const path = '../src/ui/private-status.js';
  const { mountPrivateStatus } = await import(/* @vite-ignore */ path);
  const sdk={mode:'private',events:new EventTarget()}; store.getSdk=()=>sdk;
  const dispose = mountPrivateStatus();
  expect(document.querySelector('[data-storage-status]').textContent).toContain('Jetson');
  const modal = openReportForm(); const input=modal.panel.querySelector('input');
  input.value='Not yet submitted'; input.dispatchEvent(new Event('input',{bubbles:true}));
  expect(document.querySelector('[data-storage-status]').textContent).toContain('Unsaved');
  const event=new Event('beforeunload',{cancelable:true}); window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  sdk.error=new Error('denied'); sdk.events.dispatchEvent(new Event('state'));
  expect(document.querySelector('[data-storage-status]').textContent).toContain('denied');
  modal.close();
  expect(document.querySelector('[data-storage-status]').textContent).not.toContain('Saved');
  dispose();
});

it('keeps onboarding currency form open when settings are rejected', async () => {
  setup(); store.settings.onboarded=false;
  vi.spyOn(store,'updateSettings').mockRejectedValue(new Error('denied'));
  openOnboarding();
  [...document.querySelectorAll('button')].find(b=>b.textContent==='Set up my expenses').click();
  const select=document.querySelector('[aria-label="Base currency"]'); select.value='EUR';
  select.dispatchEvent(new Event('change',{bubbles:true}));
  [...document.querySelectorAll('button')].find(b=>b.textContent==='I’ll add expenses later').click();
  await vi.waitFor(()=>expect(store.updateSettings).toHaveBeenCalled());
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(select.isConnected).toBe(true);
  expect(select.closest('.modal-root').classList.contains('closing')).toBe(false);
  expect(select.value).toBe('EUR');
});
it('retains failed settings controls across unrelated successful store notifications', async () => {
  setup(); vi.spyOn(store,'updateSettings').mockRejectedValue(new Error('denied'));
  const view=settingsView(); document.body.append(view);
  const select=view.querySelector('[aria-label="Base currency"]'); select.value='EUR';
  select.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(()=>expect(store.updateSettings).toHaveBeenCalled());
  store.emit('expenses');
  expect(view.querySelector('[aria-label="Base currency"]')).toBe(select);
  expect(select.value).toBe('EUR'); view.destroy();
});
it('clears all form dirty markers only after a successful explicit close', async () => {
  setup();
  const path='../src/ui/private-status.js'; const {mountPrivateStatus}=await import(path);
  const dispose=mountPrivateStatus();
  const modal=openReportForm(); const input=modal.panel.querySelector('input');
  input.value='Saved report'; input.dispatchEvent(new Event('input',{bubbles:true}));
  modal.close();
  expect(document.querySelector('[data-storage-status]').textContent).toContain('Saved');
  dispose();
});
it('keeps rejected settings edits in their real controls when navigation is declined', async () => {
  setup(); vi.spyOn(window,'confirm').mockReturnValue(false); vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
  vi.spyOn(store,'updateSettings').mockRejectedValue(new Error('denied'));
  vi.spyOn(store,'loadAll').mockResolvedValue([]); vi.spyOn(store,'loadStatements').mockResolvedValue([]);
  history.replaceState(null,'','#/settings');
  const app=document.createElement('div'); app.id='app'; document.body.append(app); mountShell(app);
  const select=app.querySelector('[aria-label="Base currency"]'); select.value='EUR'; select.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(()=>expect(store.updateSettings).toHaveBeenCalled());
  history.replaceState(null,'','#/reports'); window.dispatchEvent(new Event('hashchange'));
  expect(select.isConnected).toBe(true); expect(select.value).toBe('EUR');
});

it('never announces a successful report withdrawal after rejection', async () => {
  setup(); store.reports=[{id:'r',title:'Trip',status:'submitted',createdAt:1}];
  vi.spyOn(store,'loadAll').mockResolvedValue([]);
  vi.spyOn(store,'transitionReport').mockRejectedValue(new Error('denied'));
  const view=reportsView({navigate:vi.fn(),params:{id:'r'}}); document.body.append(view);
  await vi.waitFor(()=>expect([...view.querySelectorAll('button')].some(b=>b.textContent==='Withdraw')).toBe(true));
  [...view.querySelectorAll('button')].find(b=>b.textContent==='Withdraw').click();
  await vi.waitFor(()=>expect(document.body.textContent).toContain('Couldn’t withdraw'));
  expect(document.body.textContent).not.toContain('Report back in draft');
  view.destroy();
});
it('marks receipt-only removal as an unsaved edit before submitting', () => {
  setup(); vi.spyOn(store,'readReceipt').mockResolvedValue(new Blob(['x'],{type:'image/png'}));
  const modal=openExpenseForm({expense:{id:'receipt-only',date:'2026-01-01',amount:1,merchant:'A',receiptPath:'expenses-data/receipts/a.png'}});
  modal.panel.querySelector('[aria-label="Remove receipt"]').click();
  expect(modal.panel.dataset.privateDirty).toBe('1');
});
it('visibly disables cloud OCR and private sign-out despite inherited autoOcr', () => {
  setup(); store.settings.autoOcr=true;
  expect(canSignOut(store.sdk)).toBe(false);
  const view = settingsView(); document.body.append(view);
  expect(view.textContent).toContain('unavailable in private mode');
  expect(view.querySelector('[aria-label="Vision model"]')).toBeNull();
  view.destroy();
  openCapture();
  expect(document.body.textContent).toContain('Manual entry');
});
