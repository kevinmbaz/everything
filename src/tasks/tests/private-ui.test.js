import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ modal: null, nodes: [],
  store: { isPrivate: true, settings: {}, lists: [{ id: 'l', name: 'Personal' }],
    allTags: () => [], listById: () => ({ id: 'l' }),
    updateTask: vi.fn(), addTask: vi.fn(), updateList: vi.fn(), addList: vi.fn(),
    setDraftDirty: vi.fn(), privateError: null, collabMode: () => 'link',
    addEventListener: vi.fn(), removeEventListener: vi.fn() },
}));
vi.mock('../src/lib/store.js', () => ({ store: f.store,
  PRIORITIES: [{ value: 0, label: 'None' }], LIST_ICON_CHOICES: ['list'] }));
vi.mock('../src/lib/dom.js', () => ({
  el: (tag, attrs = {}, ...children) => {
    const n = { tag, ...attrs, children: children.flat(Infinity).filter(Boolean),
      append(...xs) { this.children.push(...xs.flat(Infinity)); },
      setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; },
      addEventListener(k, fn) { this['on' + k] = fn; }, focus() {},
      querySelector() { return null; }, querySelectorAll() { return []; } };
    f.nodes.push(n); return n;
  }, clear: n => { n.children = []; },
}));
vi.mock('../src/ui/icons.js', () => ({ icon: () => '' }));
vi.mock('../src/ui/modal.js', () => ({
  openModal: options => (f.modal = { ...options, close: vi.fn(), panel: { addEventListener: vi.fn() } }),
  confirmDialog: vi.fn(),
}));
vi.mock('../src/ui/theme.js', () => ({ applyTheme: vi.fn() }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => { f.nodes = []; f.modal = null; vi.clearAllMocks(); });
function field(label) { return f.nodes.find(n => n['aria-label'] === label); }
it('keeps list edits typed during a delayed acknowledgement', async () => {
  const { openListForm } = await import('../src/ui/listform.js');
  let resolve; f.store.updateList.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  openListForm({ list: { id: 'l', name: 'Initial' } });
  const name = field('List name'); name.value = 'Submitted'; name.oninput({ target: name });
  const saving = button('Save').onclick();
  name.value = 'Later'; name.oninput({ target: name });
  resolve(); await saving;
  expect(f.modal.close).not.toHaveBeenCalled();
  expect(button('Save').disabled).toBe(false);
  f.modal.content.oninput({ target: name });
  expect(f.store.setDraftDirty).toHaveBeenLastCalledWith(expect.anything(), true);
});
function button(label) { return f.nodes.find(n => n.tag.startsWith('button') && n.children.includes(label)); }
function text(n) { return typeof n === 'string' ? n : [n?.textContent, ...(n?.children || []).map(text)].filter(Boolean).join(' '); }
it('disables sharing UI and public routes without parsing links or making requests', async () => {
  const { openShareSheet } = await import('../src/ui/sharesheet.js');
  openShareSheet({ id: 'l', name: 'Personal' });
  expect(text(f.modal.content)).toMatch(/unavailable in private mode/i);
  const { sharedView } = await import('../src/views/shared.js');
  expect(text(sharedView())).toMatch(/unavailable in private mode/i);
  const { joinView, approveView } = await import('../src/views/collab.js');
  expect(text(joinView())).toMatch(/unavailable in private mode/i);
  expect(text(approveView())).toMatch(/unavailable in private mode/i);
});
it('settings disables public feeds, keeps local export and labels archive omissions', async () => {
  const { settingsView } = await import('../src/views/settings.js');
  const root = settingsView();
  expect(text(root)).toMatch(/Jetson/);
  expect(text(root)).toMatch(/archive.*not included/i);
  const feed = f.nodes.find(n => n.tag.startsWith('button') && text(n).includes('Calendar feed'));
  expect(feed.disabled).toBe(true);
});
it('onboarding explains personal Jetson storage instead of promising Puter collaboration', async () => {
  const { openOnboarding } = await import('../src/ui/onboarding.js');
  openOnboarding();
  expect(text(f.modal.content)).toMatch(/Jetson/);
  expect(text(f.modal.content)).not.toMatch(/own Puter cloud/);
});
it('keeps a rejected task form open with its entered text', async () => {
  const { openTaskForm } = await import('../src/ui/taskform.js');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    f.store.updateTask.mockRejectedValueOnce(new Error('Denied'));
    openTaskForm({ task: { id: 't', title: 'Initial', listId: 'l' } });
    const title = field('Task title'); title.value = 'Keep this text'; title.oninput({ target: title });
    f.modal.content.oninput({ target: title });
    await button('Save changes').onclick();
    expect(f.modal.close).not.toHaveBeenCalled(); expect(title.value).toBe('Keep this text');
    expect(f.store.setDraftDirty).toHaveBeenLastCalledWith(expect.anything(), true);
  } finally { error.mockRestore(); }
});
it('a newly created task edited during save is updated rather than added twice', async () => {
  const { openTaskForm } = await import('../src/ui/taskform.js');
  let resolve; f.store.addTask.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  f.store.updateTask.mockResolvedValueOnce(undefined);
  openTaskForm();
  const title = field('Task title'); title.value = 'First'; title.oninput({ target: title });
  const first = button('Add task').onclick();
  title.value = 'Second'; title.oninput({ target: title });
  resolve({ id: 'created' }); await first;
  await button('Add task').onclick();
  expect(f.store.addTask).toHaveBeenCalledOnce();
  expect(f.store.updateTask).toHaveBeenCalledWith('created', expect.objectContaining({ title: 'Second' }));
});
it('keeps task edits typed during a delayed acknowledgement open and dirty', async () => {
  const { openTaskForm } = await import('../src/ui/taskform.js');
  let resolve; f.store.updateTask.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  openTaskForm({ task: { id: 't', title: 'Initial', listId: 'l' } });
  const title = field('Task title'); title.value = 'Submitted'; title.oninput({ target: title });
  const saving = button('Save changes').onclick();
  title.value = 'Typed while saving'; title.oninput({ target: title });
  f.modal.content.oninput({ target: title });
  expect(f.store.setDraftDirty).toHaveBeenLastCalledWith(expect.anything(), true);
  resolve(); await saving;
  expect(f.modal.close).not.toHaveBeenCalled();
  expect(title.value).toBe('Typed while saving');
  expect(button('Save changes').disabled).toBe(false);
});
