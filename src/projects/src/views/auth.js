import { auth } from '../lib/storage.js';
import { el } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { appIcon } from '../ui/bits.js';

/** Signed-out intro page: what the app is, one button to get in. */
export function authView({ onSignedIn }) {
  const cta = el('button.btn.btn-primary.auth-cta', {
    onclick: async () => {
      cta.disabled = true;
      cta.textContent = 'Waiting for Puter…';
      try {
        await auth.signIn();
        onSignedIn();
      } catch {
        cta.disabled = false;
        cta.textContent = 'Sign in';
      }
    },
  }, 'Sign in');

  return el('div.auth-view', {},
    appIcon(84, 'auth-logo'),
    el('h1.auth-title', {}, 'Project Management'),
    el('p.auth-sub', {}, 'Boards, timelines, and milestones for people who ship. Light enough to enjoy, structured enough to trust.'),
    el('div.auth-features', {},
      feature('board', 'Kanban boards with drag and drop, labels, priorities, and assignees'),
      feature('timeline', 'A timeline that shows every dated task and milestone at a glance'),
      feature('cloud', 'Comments and files on every task, stored in your own Puter cloud')
    ),
    cta,
    el('p.auth-note', {}, 'Free. No ads. Powered by ',
      el('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Puter'))
  );

  function feature(ic, text) {
    return el('div.auth-feature', { html: icon(ic, 20, 1.8) }, el('span', {}, text));
  }
}
