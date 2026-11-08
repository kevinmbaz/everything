/**
 * First-run onboarding: one decision — create a project, explore sample
 * data, or skip. Gated on an empty workspace; closing at any point marks
 * onboarding done so it never nags.
 */

import { isPrivateStorage } from '../lib/storage.js';
import { el } from '../lib/dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { store } from '../lib/store.js';
import { installSampleData } from '../lib/sample.js';
import { openProjectForm } from './projectform.js';
import { projectHash } from '../lib/routes.js';

export function shouldOnboard(store) {
  return !store.settings.onboarded && !store.settings.sampleData && store.projects.length === 0;
}

export function openOnboarding() {
  const markDone = () => {
    if (!store.settings.onboarded) store.updateSettings({ onboarded: true }).catch(() => {});
  };

  const body = el('div', {},
    el('div.empty.onboard-hero', {},
      el('div.empty-icon', { html: icon('board', 30) }),
      el('h3', {}, 'Plan it. Move it. Ship it.'),
      el('p', {}, isPrivateStorage ? 'Kanban boards, timelines, and milestones stored on your Jetson. Unsaved edits remain only in this tab; keep downloaded ZIP backups. Puter Drive links are unavailable.' : 'Kanban boards, timelines, and milestones for small teams. Everything is stored in your own Puter account, never sold or shared.')
    ),
    el('button.btn.btn-primary.btn-block.btn-tall', {
      type: 'button',
      onclick: () => {
        markDone();
        modal.close();
        // replace, not assign: the project form's own history entry is still
        // pending (see modal.js dismissOnBack).
        openProjectForm({ onDone: (p) => location.replace(projectHash(p.id)) });
      },
    }, 'Create my first project'),
    el('button.btn.btn-ghost.btn-block.btn-dashed', {
      type: 'button',
      html: icon('sparkle', 15, 2),
      onclick: useSampleData,
    }, ' Explore with sample data'),
    el('button.btn.btn-ghost.btn-block', {
      type: 'button',
      onclick: () => { markDone(); modal.close(); },
    }, 'Skip for now')
  );

  const modal = openModal({ title: 'Welcome', content: body, onClose: markDone });

  async function useSampleData(e) {
    // currentTarget is only set while the event dispatches, and target can
    // be the icon inside the button; hold the button itself for the
    // re-enable after the await.
    const btn = e.currentTarget;
    btn.disabled = true;
    let doc;
    try {
      doc = await installSampleData(store);
    } catch (err) {
      console.error(err);
      toast('Could not load the sample data. Check your connection', { icon: 'cloudOff' });
      btn.disabled = false;
      return;
    }
    modal.close();
    location.hash = `#/p/${doc.id}`;
    // The banner lives on All projects, and this lands on a board — so the
    // one place that is always reachable is what it names.
    toast('Sample project loaded. Wipe it any time from Settings', { icon: 'sparkle' });
  }
}
