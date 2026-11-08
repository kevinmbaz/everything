import { describe, it, expect, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({
  store: { listSnapshotProjects: vi.fn(), listSnapshots: vi.fn(), projectEntry: vi.fn(), getDoc: vi.fn() },
  modal: null,
}));
vi.mock('../src/lib/store.js', () => ({ store: fixtures.store }));
vi.mock('../src/lib/dom.js', () => ({
  el: (tag, attrs = {}, ...children) => ({ tag, ...attrs, children: children.flat(Infinity).filter(Boolean), append(...items) { this.children.push(...items); } }),
  clear: node => { node.children = []; },
}));
vi.mock('../src/ui/modal.js', () => ({ openModal: options => (fixtures.modal = options), confirmDialog: vi.fn() }));
vi.mock('../src/ui/icons.js', () => ({ icon: () => '' }));
vi.mock('../src/ui/bits.js', () => ({ emptyState: options => options }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../src/ui/history.js', () => ({ clearHistory: vi.fn() }));

function text(node) {
  if (typeof node === 'string') return node;
  return [node?.textContent, node?.title, ...(node?.children ?? []).map(text)].filter(Boolean).join(' ');
}
describe('restore points error state', () => {
  it('shows a storage failure, not an empty restore-point list', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fixtures.store.listSnapshotProjects.mockRejectedValueOnce(new Error('storage unavailable'));
    const { openRestorePoints } = await import('../src/ui/restorepoints.js');
    openRestorePoints();
    await vi.waitFor(() => expect(text(fixtures.modal.content)).toMatch(/could not load/i));
    expect(text(fixtures.modal.content)).not.toContain('No restore points yet');
    error.mockRestore();
  });
});
