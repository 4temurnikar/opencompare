// Email sign-up box, shared by the app and the static pages (brief, privacy). Settings: site.json.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Shown only when fully set up, including a contact address for the privacy page */
export function newsletterReady(c) {
  const n = c?.newsletter || {};
  return !!(n.enabled && c.contactEmail && n.provider && (n.mode === 'link' ? n.link : n.action));
}

/** A plain HTML form (works without JavaScript). `root` is the relative path to the site root. */
export function signupBox(c, root, heading = 'Get the weekly energy brief by email') {
  if (!newsletterReady(c)) return '';
  const n = c.newsletter;
  const small = `<p class="small muted">One email a week, from OpenCompare. You'll get an email to confirm, and you can unsubscribe at any time. Your address is held by ${esc(n.provider)} and used only to send the brief. See our <a href="${root}privacy/">privacy page</a>.</p>`;
  const intro = `<h2>${esc(heading)}</h2><p>What changed in energy prices this week, worked out from every published plan.</p>`;
  if (n.mode === 'link') return `<aside class="signup card">${intro}<p><a class="btn-primary" href="${esc(n.link)}" target="_blank" rel="noopener">Subscribe</a></p>${small}</aside>`;
  const hidden = Object.entries(n.hidden || {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`).join('');
  return `<aside class="signup card">${intro}<form class="signup-form" action="${esc(n.action)}" method="post" target="_blank">${hidden}<label class="sr-only" for="signup-email">Email address</label><input id="signup-email" type="email" name="${esc(n.emailField || 'email')}" required placeholder="you@example.com" autocomplete="email" /><button class="btn-primary" type="submit">Subscribe</button></form>${small}</aside>`;
}
