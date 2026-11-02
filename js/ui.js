// easynostr: DOM helpers, words, time and note-text formatting. No innerHTML on anything from the network.
import { settings, profiles } from './store.js';
import { decode, npubEncode, noteEncode } from './nostr.js';

// h('tag.class', {attrs}, ...children)
export function h(sel, attrs = {}, ...kids) {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with our own static strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

// Icons: our own simple inline SVG, always hidden from screen readers.
const ICONS = {
  reply: 'M4 12l7-7v4c6 0 9 3 9 10-2-4-5-5-9-5v4z',
  repost: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
  like: 'M12 21s-7-4.5-9.5-9C1 8.5 3 5 6.5 5c2 0 3.5 1 5.5 3 2-2 3.5-3 5.5-3C21 5 23 8.5 21.5 12 19 16.5 12 21 12 21z',
  thread: 'M4 5h16v2H4zm0 6h16v2H4zm0 6h10v2H4z',
  trash: 'M6 7h12l-1 14H7zm3-4h6l1 2h4v2H4V5h4z',
  copy: 'M8 8h12v12H8zM4 4h12v2H6v10H4z',
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ''); svg.append(p);
  return svg;
}

// ---------- the ONE live region ----------
let clearTimer;
export function announce(msg) {
  const el = document.getElementById('status');
  if (!el) return;
  clearTimeout(clearTimer);
  el.textContent = '';
  // a short gap so screen readers notice the same words said twice
  setTimeout(() => {
    el.textContent = msg;
    el.classList.add('show');
    clearTimer = setTimeout(() => { el.classList.remove('show'); el.textContent = ''; }, 5000);
  }, 60);
}

// ---------- words (plain-language mode swaps the jargon) ----------
const WORDS = {
  note: ['note', 'post'], notes: ['notes', 'posts'], Note: ['Note', 'Post'], Notes: ['Notes', 'Posts'],
  repost: ['repost', 'share'], Repost: ['Repost', 'Share'], reposts: ['reposts', 'shares'], reposted: ['reposted', 'shared'],
  relay: ['relay', 'server'], relays: ['relays', 'servers'], Relays: ['Relays', 'Servers'],
  npub: ['public key (npub)', 'public ID'], nsec: ['secret key (nsec)', 'secret key'],
  Global: ['Global', 'Everyone'], 'Global feed': ['Global feed', 'Everyone'],
};
export const w = (k) => (WORDS[k] ? WORDS[k][settings.plain ? 1 : 0] : k);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- names ----------
export function shortNpub(pubkey) {
  try { const n = npubEncode(pubkey); return n.slice(0, 10) + '…' + n.slice(-4); } catch { return 'unknown'; }
}
export function displayName(pubkey) {
  const p = profiles.get(pubkey);
  const name = (p?.display_name || p?.displayName || p?.name || '').trim();
  return name ? name.slice(0, 60) : (settings.plain ? 'Someone' : shortNpub(pubkey));
}
export function handleOf(pubkey) {
  const p = profiles.get(pubkey);
  if (p?.nip05 && typeof p.nip05 === 'string') return p.nip05.replace(/^_@/, '');
  // with no name we already show the short key as the name, so don't repeat it
  return settings.plain || !p ? '' : shortNpub(pubkey);
}
export const profileHref = (pubkey) => '#/p/' + npubEncode(pubkey);
export const noteHref = (id) => '#/n/' + noteEncode(id);

function hue(pubkey) { return parseInt(pubkey.slice(0, 6), 16) % 360; }
export function avatar(pubkey, size = 'md') {
  const p = profiles.get(pubkey);
  const wrap = h(`span.avatar.avatar-${size}`, { 'aria-hidden': 'true', style: `--h:${hue(pubkey)}` });
  wrap.textContent = (displayName(pubkey).replace(/[^\p{L}\p{N}]/gu, '')[0] || '?').toUpperCase();
  if (settings.showImages && typeof p?.picture === 'string' && /^https:\/\//.test(p.picture)) {
    const img = h('img', { src: p.picture, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    wrap.append(img);
  }
  return wrap;
}

// ---------- time ----------
export function timeAgo(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return plural(m, 'minute', 'minutes') + ' ago';
  const hr = Math.round(s / 3600); if (hr < 24) return plural(hr, 'hour', 'hours') + ' ago';
  const d = Math.round(s / 86400); if (d < 7) return plural(d, 'day', 'days') + ' ago';
  const date = new Date(ts * 1000);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export function timeEl(ts) {
  const d = new Date(ts * 1000);
  return h('time', { datetime: d.toISOString(), title: d.toLocaleString('en-US') }, timeAgo(ts));
}

// ---------- note text ----------
const IMG_RE = /\.(jpe?g|png|gif|webp|avif)(\?\S*)?$/i;
const VID_RE = /\.(mp4|webm|mov|m4v)(\?\S*)?$/i;
const TOKEN_RE = /(https?:\/\/[^\s<>"']+|nostr:(?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+)/gi;

// NIP-92 imeta: ["imeta", "url https://...", "alt words", ...]
export function imetaAlts(event) {
  const map = new Map();
  for (const t of event.tags || []) {
    if (t[0] !== 'imeta') continue;
    const f = {};
    for (const part of t.slice(1)) { const i = part.indexOf(' '); if (i > 0) f[part.slice(0, i)] = part.slice(i + 1); }
    if (f.url) map.set(f.url, (f.alt || '').trim());
  }
  return map;
}

export function mentionedPubkeys(event) {
  const out = new Set();
  for (const m of (event.content || '').matchAll(/nostr:(npub|nprofile)1[02-9ac-hj-np-z]+/gi)) {
    try { const d = decode(m[0]); out.add(d.type === 'npub' ? d.data : d.data.pubkey); } catch {}
  }
  return out;
}

function linkLabel(url) {
  try {
    const u = new URL(url);
    let path = (u.pathname + u.search).replace(/\/$/, '');
    if (path.length > 24) path = path.slice(0, 22) + '…';
    return u.hostname.replace(/^www\./, '') + path;
  } catch { return 'link'; }
}

// Returns { body: <div>, media: [<figure>|<a>] }
export function formatContent(event) {
  const alts = imetaAlts(event);
  const media = [];
  const body = h('div.content');
  const text = (event.content || '').replace(/\r\n/g, '\n').trim();
  const paras = text.split(/\n{2,}/);
  for (const para of paras) {
    const p = h('p');
    const lines = para.split('\n');
    lines.forEach((line, li) => {
      if (li) p.append(h('br'));
      let last = 0;
      for (const m of line.matchAll(TOKEN_RE)) {
        if (m.index > last) p.append(line.slice(last, m.index));
        last = m.index + m[0].length;
        let tok = m[0];
        let trail = '';
        const tm = tok.match(/[.,;:!?)\]]+$/);
        if (tm && tok.startsWith('http')) { trail = tm[0]; tok = tok.slice(0, -trail.length); }
        p.append(...tokenNodes(tok, alts, media));
        if (trail) p.append(trail);
      }
      if (last < line.length) p.append(line.slice(last));
    });
    if (p.textContent.trim()) body.append(p);
  }
  return { body, media };
}

function tokenNodes(tok, alts, media) {
  if (tok.startsWith('nostr:')) {
    try {
      const d = decode(tok);
      if (d.type === 'npub' || d.type === 'nprofile') {
        const pk = d.type === 'npub' ? d.data : d.data.pubkey;
        return [h('a.mention', { href: profileHref(pk) }, '@' + displayName(pk))];
      }
      if (d.type === 'note' || d.type === 'nevent') {
        const id = d.type === 'note' ? d.data : d.data.id;
        return [h('a.quote-link', { href: noteHref(id) }, `quoted ${w('note')}`)];
      }
    } catch {}
    return [tok.slice(0, 20) + '…'];
  }
  if (IMG_RE.test(tok)) {
    const alt = alts.get(tok) || '';
    if (settings.showImages) {
      media.push(h('figure.media', {},
        h('a', { href: tok, target: '_blank', rel: 'noopener noreferrer nofollow' },
          h('img', { src: tok, alt: alt || 'image, no description', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }))));
      return [];
    }
    return [h('a.ext', { href: tok, target: '_blank', rel: 'noopener noreferrer nofollow' }, alt ? `image: ${alt}` : 'image, no description')];
  }
  if (VID_RE.test(tok)) {
    return [h('a.ext', { href: tok, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'video: ' + linkLabel(tok))];
  }
  return [h('a.ext', { href: tok, target: '_blank', rel: 'noopener noreferrer nofollow', title: tok }, linkLabel(tok))];
}

export function excerpt(event, n = 90) {
  const t = (event?.content || '').replace(/https?:\/\/\S+/g, 'link').replace(/nostr:\S+/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
