/** In-memory form dirtiness, never a browser-persistent draft or outbox. */
export function trackPrivateDraft(store, root, read, { initiallyDirty = false } = {}) {
  const token = {};
  let baseline = read();
  let unacknowledged = initiallyDirty;
  let disposed = false;
  const update = () => { if (!disposed) store.setDraftDirty(token, unacknowledged || read() !== baseline); };
  if (store.isPrivate) {
    for (const event of ['input', 'change', 'click']) root.addEventListener(event, update);
    if (unacknowledged) update();
  }
  return {
    acknowledge(value) { unacknowledged = false; baseline = value; update(); },
    dispose() { disposed = true; store.setDraftDirty(token, false); },
  };
}
