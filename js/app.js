// easynostr: views, actions and keyboard shortcuts. Hash routes keep the Back button working.
import { Pool, decode, verifyEvent, npubEncode, noteEncode, nsecEncode, isHex64, generateSecretKey, getPublicKey } from './nostr.js';
import { settings, saveSettings, resetRelays, DEFAULT_RELAYS, accountHolder, me, canSign, sign, signInWithKey,
  signInReadOnly, signInExtension, logOut, profiles, rememberProfile } from './store.js';
import { h, icon, announce, w, plural, displayName, handleOf, profileHref, noteHref, avatar, timeEl, formatContent,
  mentionedPubkeys, excerpt, shortNpub } from './ui.js';

const pool = new Pool();
const relays = () => settings.relays;
const main = document.getElementById('main');
const PAGE = 20;
const events = new Map();      // id -> event (for action handlers)
const counts = new Map();      // id -> {likes, reposts, replies, myLike}
let routeToken = 0;
let firstRender = true;
let myContacts = null;         // { event, follows:Set, fetchedAt }

// ---------- appearance ----------
export function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.size = settings.textSize;
  root.dataset.motion = settings.reduceMotion ? 'reduce' : 'auto';
}

// ---------- data ----------
async function verified(list) {
  const ok = await Promise.all(list.map((e) => verifyEvent(e)));
  return list.filter((_, i) => ok[i]);
}

async function fetchProfiles(pubkeys, { force = false, timeout = 3500 } = {}) {
  const want = [...new Set(pubkeys)].filter((pk) => isHex64(pk) && (force || !profiles.has(pk)));
  if (!want.length) return;
  const filters = [];
  for (let i = 0; i < want.length; i += 150) filters.push({ kinds: [0], authors: want.slice(i, i + 150) });
  const list = await verified(await pool.query(relays(), filters, { timeout }));
  const newest = new Map();
  for (const e of list) if (!newest.has(e.pubkey) || newest.get(e.pubkey).created_at < e.created_at) newest.set(e.pubkey, e);
  for (const [pk, e] of newest) {
    try { const p = JSON.parse(e.content); if (p && typeof p === 'object') rememberProfile(pk, { ...p, _at: e.created_at }); } catch {}
  }
}

async function getContacts(pubkey, timeout = 5000) {
  const list = await verified(await pool.query(relays(), [{ kinds: [3], authors: [pubkey], limit: 1 }], { timeout }));
  const ev = list.sort((a, b) => b.created_at - a.created_at)[0] || null;
  const follows = new Set((ev?.tags || []).filter((t) => t[0] === 'p' && isHex64(t[1])).map((t) => t[1]));
  return { event: ev, follows, fetchedAt: Date.now() };
}
async function myFollows(fresh = false) {
  if (!me()) return null;
  if (fresh || !myContacts || Date.now() - myContacts.fetchedAt > 120000) myContacts = await getContacts(me());
  return myContacts;
}

function eTags(ev) { return (ev.tags || []).filter((t) => t[0] === 'e' && isHex64(t[1])); }
function parentOf(ev) {
  const e = eTags(ev).filter((t) => t[3] !== 'mention');
  return (e.find((t) => t[3] === 'reply') || (e.some((t) => t[3]) ? e.find((t) => t[3] === 'root') : e[e.length - 1]))?.[1] || null;
}
function rootOf(ev) {
  const e = eTags(ev).filter((t) => t[3] !== 'mention');
  return (e.find((t) => t[3] === 'root') || (e.some((t) => t[3]) ? null : e[0]))?.[1] || parentOf(ev);
}
const isReply = (ev) => ev.kind === 1 && !!parentOf(ev);
// Global is noisy. Skip link dumps and walls of hashtags.
const looksSpammy = (ev) => ev.kind === 1 && (((ev.content || '').match(/https?:\/\//g) || []).length > 4 || ((ev.content || '').match(/#\w/g) || []).length > 8);
const target = (ev) => ev._inner || ev;

async function unwrapReposts(list) {
  for (const ev of list) {
    if (ev.kind !== 6) continue;
    try {
      const inner = JSON.parse(ev.content);
      if (inner && inner.kind === 1 && (await verifyEvent(inner))) ev._inner = inner;
    } catch {}
  }
  const missing = list.filter((e) => e.kind === 6 && !e._inner).map((e) => eTags(e)[0]?.[1]).filter(Boolean);
  if (missing.length) {
    const got = new Map((await verified(await pool.query(relays(), [{ ids: missing }], { timeout: 3500 }))).map((e) => [e.id, e]));
    for (const ev of list) if (ev.kind === 6 && !ev._inner) ev._inner = got.get(eTags(ev)[0]?.[1]);
  }
  return list.filter((e) => e.kind !== 6 || e._inner);
}

function peopleIn(list) {
  const out = [];
  for (const ev of list) {
    out.push(ev.pubkey);
    const t = target(ev);
    out.push(t.pubkey, ...mentionedPubkeys(t));
    const p = (t.tags || []).find((x) => x[0] === 'p' && x[1] !== t.pubkey);
    if (p) out.push(p[1]);
  }
  return out;
}

// ---------- counts (likes, reposts, replies) ----------
async function loadCounts(list) {
  const ids = [...new Set(list.map((e) => target(e).id))];
  if (!ids.length) return;
  const got = await pool.query(relays(), [{ kinds: [1, 6, 7], '#e': ids, limit: 1000 }], { timeout: 4000 });
  const set = new Set(ids);
  for (const id of ids) if (!counts.has(id)) counts.set(id, { likes: 0, reposts: 0, replies: 0, myLike: null, seen: new Set() });
  for (const e of got) {
    let tid;
    if (e.kind === 7) tid = eTags(e).pop()?.[1];
    else if (e.kind === 6) tid = eTags(e)[0]?.[1];
    else tid = parentOf(e);
    if (!set.has(tid)) continue;
    const c = counts.get(tid);
    if (c.seen.has(e.id)) continue;
    c.seen.add(e.id);
    if (e.kind === 7 && e.content !== '-') { c.likes++; if (e.pubkey === me()) c.myLike = e.id; }
    if (e.kind === 6) c.reposts++;
    if (e.kind === 1) c.replies++;
  }
  for (const id of ids) updateActionLabels(id);
}

function updateActionLabels(id) {
  const c = counts.get(id) || { likes: 0, reposts: 0, replies: 0 };
  for (const art of document.querySelectorAll(`article[data-id="${id}"]`)) {
    const name = art.dataset.name;
    const r = art.querySelector('.act-reply'), rp = art.querySelector('.act-repost'), l = art.querySelector('.act-like');
    const sr = art.querySelector('.st-reply'), sl = art.querySelector('.st-like');
    if (sr) { sr.querySelector('.n').textContent = c.replies || ''; sr.querySelector('.srn').textContent = c.replies ? plural(c.replies, 'reply', 'replies') : ''; }
    if (sl) { sl.querySelector('.n').textContent = c.likes || ''; sl.querySelector('.srn').textContent = c.likes ? plural(c.likes, 'like', 'likes') : ''; }
    if (r) { r.setAttribute('aria-label', `Reply to ${name}` + (c.replies ? `, ${plural(c.replies, 'reply', 'replies')}` : '')); r.querySelector('.n').textContent = c.replies || ''; }
    if (rp) { rp.setAttribute('aria-label', `${w('Repost')}` + (c.reposts ? `, ${plural(c.reposts, w('repost'), w('reposts'))}` : '')); rp.querySelector('.n').textContent = c.reposts || ''; }
    if (l) {
      l.setAttribute('aria-label', `Like, ${plural(c.likes, 'like', 'likes')}`);
      l.setAttribute('aria-pressed', c.myLike ? 'true' : 'false');
      l.querySelector('.n').textContent = c.likes || '';
    }
  }
}

// ---------- rendering a note ----------
let uid = 0;
function renderNote(ev, { headingLevel = 2, highlight = false, headingText } = {}) {
  const t = target(ev);
  events.set(t.id, t);
  const name = displayName(t.pubkey);
  const hid = 'n' + (++uid);
  const H = 'h' + headingLevel;
  const heading = h(H + '.note-head', { id: hid },
    h('a.author', { href: profileHref(t.pubkey) }, headingText || name),
    ev._inner ? h('span.repost-by', {}, `, ${w('reposted')} by ${displayName(ev.pubkey)}`) : null,
    highlight ? h('span.sr-only', {}, ', the note you opened') : null);
  const handle = handleOf(t.pubkey);
  const meta = h('p.meta', {},
    handle ? h('span.handle', {}, handle) : null, handle ? h('span.dot', { 'aria-hidden': 'true' }, ' · ') : null,
    h('a.time', { href: noteHref(t.id) }, timeEl(t.created_at)));
  const parent = isReply(t) ? (t.tags.find((x) => x[0] === 'p' && x[1] !== t.pubkey) || t.tags.find((x) => x[0] === 'p')) : null;
  const ctx = parent ? h('p.context', {}, 'Replying to ', h('a', { href: profileHref(parent[1]) }, displayName(parent[1]))) : null;
  const { body, media } = formatContent(t);
  const cw = (t.tags || []).find((x) => x[0] === 'content-warning');
  let content = h('div.note-body', {}, body, ...media);
  if (cw) content = h('details.cw', {}, h('summary', {}, 'Content warning: ' + (cw[1] || 'sensitive')), content);

  const art = h('article.note' + (highlight ? '.highlight' : '') + (ev._inner ? '.is-repost' : ''),
    { 'data-id': t.id, 'data-name': name, 'aria-labelledby': hid, tabindex: '-1' },
    h('div.note-top', {}, avatar(t.pubkey), h('div.note-who', {}, heading, meta)),
    ctx, content, actionsFor(t, name));
  return art;
}

function actionsFor(t, name) {
  const bar = h('div.actions');
  if (canSign()) {
    bar.append(
      h('button.act.act-reply', { type: 'button', 'aria-label': `Reply to ${name}`, onclick: (e) => openReply(t, e.currentTarget) }, icon('reply'), h('span.lbl', {}, 'Reply'), h('span.n', { 'aria-hidden': 'true' })),
      h('button.act.act-repost', { type: 'button', 'aria-label': w('Repost'), onclick: (e) => doRepost(t, e.currentTarget) }, icon('repost'), h('span.lbl', {}, w('Repost')), h('span.n', { 'aria-hidden': 'true' })),
      h('button.act.act-like', { type: 'button', 'aria-label': 'Like, 0 likes', 'aria-pressed': 'false', onclick: (e) => doLike(t, e.currentTarget) }, icon('like'), h('span.lbl', {}, 'Like'), h('span.n', { 'aria-hidden': 'true' })),
    );
  } else {
    bar.append(
      h('span.act.static.st-reply', {}, icon('reply'), h('span.n', { 'aria-hidden': 'true' }), h('span.sr-only.srn')),
      h('span.act.static.st-like', {}, icon('like'), h('span.n', { 'aria-hidden': 'true' }), h('span.sr-only.srn')),
    );
  }
  bar.append(h('a.act.act-thread', { href: noteHref(t.id) }, icon('thread'), h('span.lbl', {}, 'Thread')));
  if (t.pubkey === me() && canSign()) {
    bar.append(h('button.act.act-delete', { type: 'button', 'aria-label': `Delete this ${w('note')}`, onclick: (e) => doDelete(t, e.currentTarget) }, icon('trash'), h('span.lbl', {}, 'Delete')));
  }
  return bar;
}

// ---------- composing ----------
function composeForm({ label, button, onSend, autofocus = false, id = 'c' + (++uid), onCancel }) {
  const ta = h('textarea', { id: id + '-t', rows: '4', 'aria-describedby': id + '-n' });
  const counter = h('p.counter', { id: id + '-n' }, '0 characters');
  let timer, lastSaid = -1;
  ta.addEventListener('input', () => {
    const n = [...ta.value].length;
    counter.textContent = plural(n, 'character', 'characters');
    clearTimeout(timer);
    if (settings.announceCount) timer = setTimeout(() => { if (n !== lastSaid && document.activeElement === ta) { lastSaid = n; announce(plural(n, 'character', 'characters')); } }, 1400);
  });
  const send = h('button.btn.primary', { type: 'submit' }, button);
  const form = h('form.compose', { onsubmit: async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) { announce(`Type something first.`); ta.focus(); return; }
    send.disabled = true; send.textContent = 'Sending…';
    try {
      const ok = await onSend(text);
      if (ok) { ta.value = ''; counter.textContent = '0 characters'; lastSaid = -1; }
    } catch (err) { announce('Could not send: ' + (err?.message || err)); }
    send.disabled = false; send.textContent = button;
  } },
  h('label', { for: id + '-t' }, label), ta,
  h('div.compose-row', {}, counter, h('div.btns', {}, onCancel ? h('button.btn', { type: 'button', onclick: onCancel }, 'Cancel') : null, send)));
  if (autofocus) setTimeout(() => ta.focus(), 0);
  return form;
}

async function publish(ev) {
  const res = await pool.publish(relays(), ev);
  const ok = res.filter((r) => r.ok).length;
  return { ok, total: res.length, res };
}

async function postNote(text, tags = []) {
  const ev = await sign({ kind: 1, content: text, tags });
  const r = await publish(ev);
  if (!r.ok) { announce(`Could not post. None of your ${w('relays')} accepted it.`); return null; }
  events.set(ev.id, ev);
  return { ev, ...r };
}

function openReply(t, btn) {
  const art = btn.closest('article');
  const old = art.querySelector('form.compose');
  if (old) { old.querySelector('textarea').focus(); return; }
  const name = displayName(t.pubkey);
  const close = () => { form.remove(); btn.focus(); };
  const form = composeForm({
    label: `Reply to ${name}`, button: 'Send reply', onCancel: close,
    onSend: async (text) => {
      const root = rootOf(t) || t.id;
      const tags = root === t.id ? [['e', t.id, '', 'root']] : [['e', root, '', 'root'], ['e', t.id, '', 'reply']];
      const ps = new Set([t.pubkey, ...(t.tags || []).filter((x) => x[0] === 'p' && isHex64(x[1])).map((x) => x[1])]);
      ps.delete(me());
      for (const p of ps) tags.push(['p', p]);
      const r = await postNote(text, tags);
      if (!r) return false;
      announce(`Reply sent to ${r.ok} of ${r.total} ${w('relays')}.`);
      const c = counts.get(t.id); if (c) { c.replies++; updateActionLabels(t.id); }
      close();
      return true;
    },
  });
  art.append(form);
  form.querySelector('textarea').focus();
}

async function doLike(t, btn) {
  const c = counts.get(t.id) || { likes: 0, reposts: 0, replies: 0, myLike: null, seen: new Set() };
  counts.set(t.id, c);
  btn.disabled = true;
  try {
    if (c.myLike) {
      const del = await sign({ kind: 5, content: '', tags: [['e', c.myLike], ['k', '7']] });
      await publish(del);
      c.myLike = null; c.likes = Math.max(0, c.likes - 1);
      announce('Like removed.');
    } else {
      const ev = await sign({ kind: 7, content: '+', tags: [['e', t.id], ['p', t.pubkey], ['k', String(t.kind)]] });
      const r = await publish(ev);
      if (!r.ok) throw new Error(`no ${w('relay')} accepted it`);
      c.myLike = ev.id; c.likes++;
      announce('Liked.');
    }
  } catch (err) { announce('Could not like: ' + (err?.message || err)); }
  btn.disabled = false;
  updateActionLabels(t.id);
  btn.focus();
}

async function doRepost(t, btn) {
  if (settings.confirmRepost && !confirm(`${w('Repost')} this ${w('note')} by ${displayName(t.pubkey)} to your followers?`)) { btn.focus(); return; }
  try {
    const ev = await sign({ kind: 6, content: JSON.stringify(t), tags: [['e', t.id, relays()[0] || ''], ['p', t.pubkey]] });
    const r = await publish(ev);
    if (!r.ok) throw new Error(`no ${w('relay')} accepted it`);
    const c = counts.get(t.id); if (c) { c.reposts++; updateActionLabels(t.id); }
    announce(`${w('reposted')[0].toUpperCase() + w('reposted').slice(1)}.`);
  } catch (err) { announce(`Could not ${w('repost')}: ` + (err?.message || err)); }
  btn.focus();
}

async function doDelete(t, btn) {
  if (!confirm(`Delete this ${w('note')}? ${w('Relays')} that honor deletions will remove it.`)) { btn.focus(); return; }
  try {
    const ev = await sign({ kind: 5, content: 'deleted', tags: [['e', t.id], ['k', String(t.kind)]] });
    const r = await publish(ev);
    const art = btn.closest('article');
    const next = art.nextElementSibling?.matches('article') ? art.nextElementSibling : art.previousElementSibling;
    art.remove();
    announce(`Deleted. ${r.ok} of ${r.total} ${w('relays')} accepted the deletion.`);
    (next?.matches?.('article') ? next : document.querySelector('h1')).focus();
  } catch (err) { announce('Could not delete: ' + (err?.message || err)); btn.focus(); }
}

async function toggleFollow(pk, btn) {
  btn.disabled = true;
  try {
    const c = await myFollows(true);
    if (!c.event && !confirm('No follow list was found on your relays. Following will start a new list. If you follow people in another app, that list could be replaced. Continue?')) { btn.disabled = false; return; }
    const following = c.follows.has(pk);
    const tags = (c.event?.tags || []).filter((t) => !(t[0] === 'p' && t[1] === pk));
    if (!following) tags.push(['p', pk]);
    const ev = await sign({ kind: 3, content: c.event?.content || '', tags });
    const r = await publish(ev);
    if (!r.ok) throw new Error(`no ${w('relay')} accepted it`);
    myContacts = { event: ev, follows: new Set(tags.filter((t) => t[0] === 'p').map((t) => t[1])), fetchedAt: Date.now() };
    setFollowButton(btn, pk, !following);
    announce(following ? `Unfollowed ${displayName(pk)}.` : `Following ${displayName(pk)}.`);
  } catch (err) { announce('Could not change follow: ' + (err?.message || err)); }
  btn.disabled = false;
  btn.focus();
}
function setFollowButton(btn, pk, following) {
  btn.textContent = following ? 'Unfollow' : 'Follow';
  btn.setAttribute('aria-label', (following ? 'Unfollow ' : 'Follow ') + displayName(pk));
  btn.classList.toggle('primary', !following);
}

// ---------- page frame ----------
function startView(title, { lead } = {}) {
  const tok = ++routeToken;
  document.title = `${title} · easynostr`;
  const h1 = h('h1', { tabindex: '-1' }, title);
  main.replaceChildren(h1);
  if (lead) main.append(h('p.lead', {}, lead));
  if (!firstRender) h1.focus({ preventScroll: true });
  firstRender = false;
  window.scrollTo(0, 0);
  return tok;
}
const stale = (tok) => tok !== routeToken;
function loadingLine(text) { return h('p.loading', {}, h('span.spinner', { 'aria-hidden': 'true' }), text); }

// ---------- feeds ----------
function makeFeed(tok, filtersFor, { filter = () => true, empty = 'Nothing here yet.', unit = w('notes'), render = (e) => renderNote(e), prepare, keep } = {}) {
  const list = h('div.feed');
  const more = h('button.btn.more', { type: 'button' }, `Load ${PAGE} more`);
  const status = loadingLine(`Loading ${unit}…`);
  main.append(list, status);
  const shown = new Set();
  let until;
  async function page(userAsked) {
    more.disabled = true;
    if (userAsked) announce(`Loading ${PAGE} more ${unit}…`);
    const raw = await pool.query(relays(), filtersFor(until), { timeout: 6000 });
    if (stale(tok)) return;
    let got = (await verified(raw)).filter((e) => !shown.has(e.id)).filter(filter).sort((a, b) => b.created_at - a.created_at);
    got = await unwrapReposts(got);
    if (keep) got = got.slice(0, PAGE * 2); else got = got.slice(0, PAGE);
    await Promise.all([fetchProfiles(peopleIn(got)), prepare?.(got)]);
    if (stale(tok)) return;
    if (keep && got.length) {
      const oldest = got[got.length - 1].created_at;
      got = got.filter(keep).slice(0, PAGE);
      if (!got.length) { until = oldest; return page(userAsked); }
    }
    status.remove();
    if (!got.length) {
      if (!shown.size) list.append(h('p.empty', {}, empty));
      more.remove();
      announce(shown.size ? `No more ${unit} found.` : empty);
      return;
    }
    let first;
    for (const e of got) { shown.add(e.id); const art = render(e); first ||= art; list.append(art); }
    until = got[got.length - 1].created_at;
    if (!more.isConnected) main.append(more);
    more.disabled = false;
    if (userAsked) { first.focus(); announce(`Loaded ${plural(got.length, w('note'), unit)}.`); }
    else announce(`${plural(got.length, w('note'), unit)} loaded.`);
    loadCounts(got.filter((e) => e.kind === 1 || e.kind === 6));
  }
  more.addEventListener('click', () => page(true));
  page(false);
}

function feedTools(onRefresh) {
  return h('div.toolbar', {}, h('button.btn.small', { type: 'button', onclick: onRefresh }, 'Refresh'));
}

async function viewGlobal() {
  const tok = startView(w('Global feed'), { lead: `Recent public ${w('notes')} from your ${w('relays')}. Replies are hidden here.` });
  if (!me()) main.append(welcomeCard());
  main.append(feedTools(() => route(true)));
  makeFeed(tok, (until) => [{ kinds: [1, 6], limit: PAGE * 2, ...(until ? { until } : {}) }],
    { filter: (e) => (e.kind === 6 || (e.content || '').trim().length > 0) && !isReply(e) && !looksSpammy(e),
      keep: (() => { const per = new Map(); return (e) => {
        // only people with a profile (reposters too), at most 2 per author per page, so one bot can't fill the feed
        const pk = target(e).pubkey; const n = (per.get(pk) || 0) + 1; per.set(pk, n);
        return profiles.has(pk) && n <= 2 && (e.kind !== 6 || profiles.has(e.pubkey));
      }; })() });
}

async function viewHome() {
  if (!me()) { location.hash = '#/global'; return; }
  const tok = startView('Home');
  if (canSign()) main.append(composeForm({ label: `What's on your mind? New ${w('note')}`, button: `Post ${w('note')}`, onSend: async (text) => {
    const r = await postNote(text); if (!r) return false;
    announce(`Posted to ${r.ok} of ${r.total} ${w('relays')}.`);
    const list = main.querySelector('.feed'); list?.prepend(renderNote(r.ev));
    return true;
  } }));
  main.append(feedTools(() => route(true)));
  const st = loadingLine('Finding who you follow…'); main.append(st);
  const c = await myFollows();
  if (stale(tok)) return;
  st.remove();
  const authors = [...c.follows, me()];
  if (c.follows.size === 0) {
    main.append(h('p.empty', {}, 'You don’t follow anyone yet. Try the ', h('a', { href: '#/global' }, w('Global feed')), ' and follow people from their profile.'));
    return;
  }
  makeFeed(tok, (until) => {
    const fs = [];
    for (let i = 0; i < authors.length; i += 300) fs.push({ kinds: [1, 6], authors: authors.slice(i, i + 300), limit: PAGE, ...(until ? { until } : {}) });
    return fs;
  });
}

async function viewNotifications() {
  if (!me()) { needSignIn('Notifications'); return; }
  const tok = startView('Notifications', { lead: `Replies, mentions, likes and ${w('reposts')} of your ${w('notes')}.` });
  const targets = new Map();
  makeFeed(tok, (until) => [{ kinds: [1, 6, 7], '#p': [me()], limit: PAGE, ...(until ? { until } : {}) }], {
    filter: (e) => e.pubkey !== me(),
    unit: 'notifications',
    empty: 'No notifications yet.',
    prepare: async (got) => {
      const ids = got.filter((e) => e.kind === 7).map((e) => eTags(e).pop()?.[1]).filter((id) => id && !targets.has(id));
      if (!ids.length) return;
      for (const t of await verified(await pool.query(relays(), [{ ids: [...new Set(ids)] }], { timeout: 3500 }))) targets.set(t.id, t);
    },
    render: (e) => {
      if (e.kind === 1) {
        const kindWord = parentOf(e) ? 'replied' : 'mentioned you';
        return renderNote(e, { headingText: `${displayName(e.pubkey)} ${kindWord}` });
      }
      const t = e._inner || targets.get(eTags(e).pop()?.[1]);
      const verb = e.kind === 6 ? `${w('reposted')} your ${w('note')}` : (e.content === '+' || e.content === '' ? `liked your ${w('note')}` : `reacted ${e.content.slice(0, 8)} to your ${w('note')}`);
      const hid = 'n' + (++uid);
      const tid = t?.id || eTags(e).pop()?.[1];
      return h('article.note.compact', { 'aria-labelledby': hid, tabindex: '-1' },
        h('div.note-top', {}, avatar(e.pubkey, 'sm'), h('div.note-who', {},
          h('h2.note-head', { id: hid }, h('a.author', { href: profileHref(e.pubkey) }, displayName(e.pubkey)), ' ' + verb),
          h('p.meta', {}, timeEl(e.created_at)))),
        t ? h('p.quote', {}, '“' + excerpt(t) + '”') : null,
        tid ? h('div.actions', {}, h('a.act.act-thread', { href: noteHref(tid) }, icon('thread'), h('span.lbl', {}, `Open your ${w('note')}`))) : null);
    },
  });
}

function needSignIn(title) {
  startView(title);
  main.append(h('p', {}, 'Sign in or paste your public ID to see this. ', h('a', { href: '#/login' }, 'Go to sign in')));
}

// ---------- profile ----------
async function viewProfile(param) {
  let pk;
  try {
    if (isHex64(param)) pk = param;
    else { const d = decode(param); pk = d.type === 'npub' ? d.data : d.type === 'nprofile' ? d.data.pubkey : null; }
  } catch {}
  if (!pk) { startView('Profile not found'); main.append(h('p', {}, 'That profile link doesn’t look right.')); return; }
  const tok = startView(displayName(pk));
  const st = loadingLine('Loading profile…'); main.append(st);
  const [, theirs] = await Promise.all([fetchProfiles([pk], { force: true }), getContacts(pk, 4000)]);
  if (stale(tok)) return;
  st.remove();
  const p = profiles.get(pk) || {};
  main.querySelector('h1').textContent = displayName(pk);
  document.title = `${displayName(pk)} · easynostr`;
  const card = h('section.profile', { 'aria-label': 'About ' + displayName(pk) });
  if (settings.showImages && /^https:\/\//.test(p.banner || '')) card.append(h('div.banner', { style: `background-image:url("${encodeURI(p.banner)}")`, 'aria-hidden': 'true' }));
  card.append(h('div.profile-top', {}, avatar(pk, 'lg'), h('div', {},
    handleOf(pk) ? h('p.handle', {}, handleOf(pk)) : null,
    h('p.stats', {}, `Follows ${plural(theirs.follows.size, 'person', 'people')}`))));
  if (p.about) { const { body } = formatContent({ content: String(p.about).slice(0, 1200), tags: [] }); card.append(body); }
  if (typeof p.website === 'string' && /^https?:\/\//.test(p.website)) card.append(h('p', {}, 'Website: ', h('a.ext', { href: p.website, target: '_blank', rel: 'noopener noreferrer nofollow' }, p.website.replace(/^https?:\/\//, ''), h('span.sr-only', {}, ' (opens in a new tab)'))));
  const row = h('div.btns');
  if (canSign() && pk !== me()) {
    const fb = h('button.btn', { type: 'button', onclick: () => toggleFollow(pk, fb) }, 'Follow');
    row.append(fb);
    myFollows().then((c) => { if (!stale(tok)) setFollowButton(fb, pk, c.follows.has(pk)); });
    setFollowButton(fb, pk, !!myContacts?.follows.has(pk));
  }
  const npub = npubEncode(pk);
  row.append(h('button.btn', { type: 'button', onclick: () => copy(npub, `${w('npub')} copied.`) }, `Copy ${w('npub')}`));
  card.append(row);
  if (!settings.plain) card.append(h('p.mono', {}, npub));
  main.append(card, h('p.section-label', { 'aria-hidden': 'true' }, w('Notes')));
  makeFeed(tok, (until) => [{ kinds: [1, 6], authors: [pk], limit: PAGE, ...(until ? { until } : {}) }], { empty: `No ${w('notes')} found on your ${w('relays')}.` });
}

// ---------- thread ----------
async function viewThread(param) {
  let id, hints = [];
  try {
    if (isHex64(param)) id = param;
    else { const d = decode(param); if (d.type === 'note') id = d.data; else if (d.type === 'nevent') { id = d.data.id; hints = d.data.relays; } }
  } catch {}
  const tok = startView('Thread');
  if (!id) { main.append(h('p', {}, 'That link doesn’t look right.')); return; }
  const st = loadingLine('Loading thread…'); main.append(st);
  const rl = [...new Set([...relays(), ...hints.filter((r) => /^wss:\/\//.test(r)).slice(0, 2)])];
  let ev = events.get(id);
  if (!ev) ev = (await verified(await pool.query(rl, [{ ids: [id] }], { timeout: 5000 })))[0];
  if (stale(tok)) return;
  if (!ev) { st.remove(); main.append(h('p.empty', {}, `Couldn’t find that ${w('note')} on your ${w('relays')}.`)); announce(`${w('Note')} not found.`); return; }
  const root = rootOf(ev) || ev.id;
  const parent = parentOf(ev);
  const raw = await pool.query(rl, [{ ids: [...new Set([root, parent].filter(Boolean))] }, { kinds: [1], '#e': [root, ev.id], limit: 300 }], { timeout: 5000 });
  if (stale(tok)) return;
  const all = new Map((await verified(raw)).filter((e) => e.kind === 1).map((e) => [e.id, e]));
  all.set(ev.id, ev);
  const list = [...all.values()].sort((a, b) => a.created_at - b.created_at);
  // the root first, then everything in time order
  list.sort((a, b) => (a.id === root ? -1 : b.id === root ? 1 : a.created_at - b.created_at));
  await fetchProfiles(peopleIn(list));
  if (stale(tok)) return;
  st.remove();
  const feed = h('div.feed.thread');
  for (const e of list) feed.append(renderNote(e, { highlight: e.id === ev.id }));
  main.append(h('p.lead', {}, `${plural(list.length, w('note'), w('notes'))} in this thread, oldest first.`), feed);
  if (!all.has(root)) feed.prepend(h('p.empty', {}, `The first ${w('note')} of this thread wasn’t found.`));
  announce(`Thread loaded, ${plural(list.length, w('note'), w('notes'))}.`);
  loadCounts(list);
}

async function viewCompose() {
  if (!canSign()) { needSignIn(`New ${w('note')}`); return; }
  startView(`New ${w('note')}`);
  const out = h('p.after');
  main.append(composeForm({ label: `Your ${w('note')}`, button: `Post ${w('note')}`, autofocus: true, onSend: async (text) => {
    const r = await postNote(text); if (!r) return false;
    announce(`Posted to ${r.ok} of ${r.total} ${w('relays')}.`);
    out.replaceChildren('Posted. ', h('a', { href: noteHref(r.ev.id) }, `View your ${w('note')}`));
    return true;
  } }), out);
}

// ---------- sign in ----------
function welcomeCard() {
  return h('section.welcome', { 'aria-labelledby': 'welcome-h' },
    h('h2', { id: 'welcome-h' }, 'Welcome to easynostr'),
    h('p', {}, 'A simple, screen reader friendly way to use Nostr. Read freely, or sign in to post.'),
    h('p', {}, h('a.btn.primary', { href: '#/login' }, 'Sign in or make an account')));
}

function viewLogin() {
  startView(me() ? 'Your account' : 'Sign in');
  const a = accountHolder.value;
  if (a) {
    const modeText = a.mode === 'nip07' ? 'with your browser extension' : a.mode === 'key' ? `with a ${w('nsec')} saved in this browser` : 'in read-only mode';
    main.append(h('section.card', { 'aria-labelledby': 'acct-h' },
      h('h2', { id: 'acct-h' }, 'Signed in'),
      h('p', {}, `You are signed in as `, h('a', { href: profileHref(a.pubkey) }, displayName(a.pubkey)), ` ${modeText}.`),
      a.mode === 'key' ? h('p.warn', {}, `Your ${w('nsec')} is stored only in this browser. Logging out deletes it from here, so make sure you saved a copy.`) : null,
      h('div.btns', {},
        a.mode === 'key' ? h('button.btn', { type: 'button', onclick: (e) => {
          const box = main.querySelector('.reveal');
          if (box) { box.remove(); e.currentTarget.textContent = 'Show my secret key'; return; }
          e.currentTarget.textContent = 'Hide my secret key';
          e.currentTarget.after(h('p.reveal.mono', {}, nsecEncode(hexBytes(a.sk))));
        } }, 'Show my secret key') : null,
        h('button.btn.danger', { type: 'button', onclick: () => {
          if (!confirm(a.mode === 'key' ? 'Log out and delete your secret key from this browser? You can only get back in if you saved it.' : 'Log out?')) return;
          logOut(); myContacts = null; updateNav(); announce('Logged out. Your key was removed from this browser.'); location.hash = '#/global';
        } }, a.mode === 'key' ? 'Log out and forget key' : 'Log out'))));
    return;
  }
  const ext = h('section.card', { 'aria-labelledby': 'ext-h' }, h('h2', { id: 'ext-h' }, 'Use a browser extension'));
  const extBody = () => {
    ext.querySelectorAll('p,button').forEach((n) => n.remove());
    if (window.nostr) {
      ext.append(h('p', {}, 'We found a Nostr extension. It keeps your key and signs for you. This is the safest choice.'),
        h('button.btn.primary', { type: 'button', onclick: async () => {
          try { const pk = await window.nostr.getPublicKey(); if (!isHex64(pk)) throw new Error('no key'); signInExtension(pk); done('Signed in with your extension.'); }
          catch (err) { announce('The extension did not share a key: ' + (err?.message || err)); }
        } }, 'Sign in with extension'));
    } else ext.append(h('p', {}, 'No Nostr extension found in this browser. On a computer, extensions like Alby or nos2x keep your key safe. On a phone, use one of the options below.'));
  };
  extBody(); setTimeout(extBody, 1200);

  const roId = 'ro-in';
  const ro = h('section.card', { 'aria-labelledby': 'ro-h' }, h('h2', { id: 'ro-h' }, 'Just look around (read-only)'),
    h('form', { onsubmit: (e) => {
      e.preventDefault();
      const v = e.target.querySelector('input').value.trim();
      try { const d = decode(v); const pk = d.type === 'npub' ? d.data : d.type === 'nprofile' ? d.data.pubkey : null; if (!pk) throw new Error(`That isn’t a ${w('npub')}.`); signInReadOnly(pk); done('Read-only mode is on. You can read your home feed and notifications.'); }
      catch (err) { announce(err.message || 'That code didn’t work.'); }
    } }, h('label', { for: roId }, `Paste a ${w('npub')} (starts with npub1)`), h('input', { id: roId, type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }),
    h('button.btn', { type: 'submit' }, 'Read only')));

  const nsId = 'nsec-in';
  const ns = h('section.card', { 'aria-labelledby': 'ns-h' }, h('h2', { id: 'ns-h' }, `Sign in with your ${w('nsec')}`),
    h('p.warn', {}, `Your ${w('nsec')} is like a password you can never change. easynostr keeps it only in this browser (localStorage) and never sends it anywhere. Only use this on your own device.`),
    h('form', { onsubmit: (e) => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      try { const d = decode(input.value); if (d.type !== 'nsec') throw new Error(`That isn’t an nsec. It should start with nsec1.`); input.value = ''; signInWithKey(d.data); done('Signed in. Your key is saved in this browser only.'); }
      catch (err) { announce(err.message || 'That key didn’t work.'); }
    } }, h('label', { for: nsId }, 'Secret key (starts with nsec1)'), h('input', { id: nsId, type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }),
    h('button.btn', { type: 'submit' }, 'Sign in')));

  const nameId = 'new-name';
  const gen = h('section.card', { 'aria-labelledby': 'gen-h' }, h('h2', { id: 'gen-h' }, 'Make a new account'),
    h('p', {}, 'This makes a brand new key in your browser. If you pick a name, it is shared on Nostr as your profile.'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const name = e.target.querySelector('input').value.trim();
      const sk = generateSecretKey();
      const nsec = nsecEncode(sk);
      signInWithKey(sk);
      updateNav();
      startView('Save your secret key');
      main.append(h('section.card', {},
        h('p.warn', {}, 'Copy this secret key and keep it somewhere safe, like a password manager. Anyone with it can post as you, and nobody can get it back for you if it’s lost.'),
        h('p.reveal.mono', {}, nsec),
        h('div.btns', {}, h('button.btn.primary', { type: 'button', onclick: () => copy(nsec, 'Secret key copied.') }, 'Copy secret key'),
          h('a.btn', { href: '#/home' }, 'I saved it, go to Home'))));
      if (name) {
        try { const ev = await sign({ kind: 0, content: JSON.stringify({ name }) }); await publish(ev); rememberProfile(getPublicKey(sk), { name }); announce(`Account made. Your name is set to ${name}. Now save your secret key.`); }
        catch { announce('Account made. Now save your secret key.'); }
      } else announce('Account made. Now save your secret key.');
    } }, h('label', { for: nameId }, 'Your display name (optional)'), h('input', { id: nameId, type: 'text', autocomplete: 'nickname' }),
    h('button.btn', { type: 'submit' }, 'Make my account')));

  main.append(ext, ro, ns, gen);
  function done(msg) { myContacts = null; updateNav(); announce(msg); location.hash = '#/home'; }
}
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); announce(msg); }
  catch { prompt('Copy this:', text); }
}

// ---------- settings ----------
function viewSettings() {
  startView('Settings', { lead: 'Changes save right away, in this browser only.' });
  const radios = (legend, key, options, onChange) => h('fieldset', {}, h('legend', {}, legend),
    ...options.map(([val, label]) => {
      const id = `${key}-${val}`;
      return h('div.choice', {}, h('input', { type: 'radio', id, name: key, value: val, checked: settings[key] === val, onchange: () => { settings[key] = val; saveSettings(); applySettings(); onChange?.(); announce(`${legend}: ${label}. Saved.`); } }), h('label', { for: id }, label));
    }));
  const check = (key, label, hint) => {
    const id = 'set-' + key;
    return h('div.choice', {}, h('input', { type: 'checkbox', id, checked: !!settings[key], 'aria-describedby': hint ? id + '-hint' : null,
      onchange: (e) => { settings[key] = e.target.checked; saveSettings(); applySettings(); announce(`${label} ${e.target.checked ? 'on' : 'off'}. Saved.`); } }),
    h('label', { for: id }, label), hint ? h('p.hint', { id: id + '-hint' }, hint) : null);
  };
  main.append(
    radios('Theme', 'theme', [['auto', 'Match my device'], ['dark', 'Dark'], ['light', 'Light']]),
    radios('Text size', 'textSize', [['normal', 'Normal'], ['large', 'Large'], ['xlarge', 'Extra large']]),
    h('fieldset', {}, h('legend', {}, 'Reading and posting'),
      check('showImages', 'Show images and profile pictures', 'When off, images become links named by their description.'),
      check('plain', 'Plain-language mode', 'Uses everyday words, like “post” instead of “note” and “server” instead of “relay”, and hides long codes.'),
      check('announceCount', 'Say the character count when I pause typing'),
      check('confirmRepost', `Ask before I ${w('repost')}`),
      check('reduceMotion', 'Reduce motion', 'Motion is already reduced if your device asks for it.')),
    h('fieldset', {}, h('legend', {}, 'Keyboard shortcuts'),
      check('shortcuts', 'Turn on single-key shortcuts', 'Off by default so they never clash with your screen reader. With a screen reader, you may need focus or forms mode for them to work.'),
      h('p', {}, h('a', { href: '#/help' }, 'See the list of shortcuts'))),
    relaysEditor());
}

function relaysEditor() {
  const list = h('ul.relay-list');
  const draw = () => {
    list.replaceChildren(...settings.relays.map((r) => h('li', {}, h('span.mono', {}, r),
      h('span.relay-state', { 'data-relay': r }),
      h('button.btn.small', { type: 'button', 'aria-label': `Remove ${r}`, onclick: () => {
        if (settings.relays.length <= 1) { announce(`Keep at least one ${w('relay')}.`); return; }
        settings.relays = settings.relays.filter((x) => x !== r); saveSettings(); draw(); announce(`Removed ${r}.`); list.querySelector('button')?.focus();
      } }, 'Remove'))));
  };
  draw();
  const inId = 'relay-in';
  return h('fieldset', {}, h('legend', {}, w('Relays')),
    h('p.hint', {}, `${w('Relays')} are the servers that carry Nostr ${w('notes')}. easynostr reads from and posts to all of these.`),
    list,
    h('form.inline', { onsubmit: (e) => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      let v = input.value.trim(); if (!v) return;
      if (!/^wss?:\/\//.test(v)) v = 'wss://' + v;
      try { new URL(v); } catch { announce('That address doesn’t look right.'); return; }
      if (!settings.relays.includes(v)) { settings.relays.push(v); saveSettings(); draw(); }
      input.value = ''; announce(`Added ${v}.`);
    } }, h('label', { for: inId }, `Add a ${w('relay')} (wss://…)`), h('input', { id: inId, type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }), h('button.btn', { type: 'submit' }, 'Add')),
    h('div.btns', {},
      h('button.btn', { type: 'button', onclick: async () => {
        announce(`Testing ${w('relays')}…`);
        const res = await Promise.all(settings.relays.map(async (r) => [r, !!(await pool.connect(r))]));
        for (const [r, ok] of res) { const el = list.querySelector(`[data-relay="${CSS.escape(r)}"]`); if (el) el.textContent = ok ? 'connected' : 'no answer'; }
        announce(`${res.filter((x) => x[1]).length} of ${res.length} ${w('relays')} connected.`);
      } }, `Test ${w('relays')}`),
      h('button.btn', { type: 'button', onclick: () => { resetRelays(); draw(); announce(`${w('Relays')} reset to the defaults: ${DEFAULT_RELAYS.length}.`); } }, 'Reset to defaults')));
}

// ---------- help ----------
const SHORTCUTS = [
  ['j', `Next ${w('note')}`], ['k', `Previous ${w('note')}`], ['r', `Reply to the current ${w('note')}`],
  ['l', `Like the current ${w('note')}`], ['s', `${w('Repost')} the current ${w('note')}`], ['o', 'Open the thread'],
  ['p', 'Open the author’s profile'], ['n', `New ${w('note')}`], ['?', 'This help page'],
];
function viewHelp() {
  startView('Help and shortcuts');
  main.append(
    h('section.card', { 'aria-labelledby': 'how-h' }, h('h2', { id: 'how-h' }, 'Getting around'),
      h('p', {}, `Every ${w('note')} starts with a heading: the author’s name. With VoiceOver or TalkBack, move by headings to jump from ${w('note')} to ${w('note')}.`),
      h('p', {}, `Under each ${w('note')} are buttons to reply, ${w('repost')}, like, and open the thread. Nothing loads by itself or moves your focus. Use “Load more” at the bottom for more.`),
      h('p', {}, 'Status messages like “Posted” are spoken politely, without interrupting you.')),
    h('section.card', { 'aria-labelledby': 'keys-h' }, h('h2', { id: 'keys-h' }, 'Keyboard shortcuts'),
      h('p', {}, settings.shortcuts ? 'Shortcuts are on.' : 'Shortcuts are off. ', settings.shortcuts ? null : h('a', { href: '#/settings' }, 'Turn them on in Settings.')),
      h('table', {}, h('caption', { class: 'sr-only' }, 'Keyboard shortcuts'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Key'), h('th', { scope: 'col' }, 'Does'))),
        h('tbody', {}, ...SHORTCUTS.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))))),
    h('section.card', { 'aria-labelledby': 'priv-h' }, h('h2', { id: 'priv-h' }, 'Privacy'),
      h('p', {}, 'easynostr is just a web page. There is no easynostr server. Your settings and any key you paste stay in this browser. Notes go straight to the relays you choose.')),
    h('section.card', { 'aria-labelledby': 'about-h' }, h('h2', { id: 'about-h' }, 'About'),
      h('p', {}, 'easynostr is a free, open source Nostr client made for screen reader users, inspired by the idea of Easy Chirp, the accessible Twitter web app. ',
        h('a', { href: 'https://github.com/2three1y/easynostr' }, 'Source code on GitHub'), '.')));
}

// ---------- shortcuts ----------
function currentArticle() { return document.activeElement?.closest?.('article.note') || null; }
document.addEventListener('keydown', (e) => {
  if (!settings.shortcuts || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
  const arts = [...main.querySelectorAll('article.note')];
  const cur = currentArticle();
  const go = (a) => { if (a) { a.focus({ preventScroll: true }); a.scrollIntoView({ block: 'nearest' }); } };
  switch (e.key) {
    case 'j': {
      const next = cur ? arts[arts.indexOf(cur) + 1] : arts[0];
      if (next) go(next); else announce(`That was the last ${w('note')}. Use Load more for more.`);
      break;
    }
    case 'k': go(cur ? arts[arts.indexOf(cur) - 1] : arts[0]); break;
    case 'r': cur?.querySelector('.act-reply')?.click(); break;
    case 'l': cur?.querySelector('.act-like')?.click(); break;
    case 's': cur?.querySelector('.act-repost')?.click(); break;
    case 'o': cur?.querySelector('.act-thread')?.click(); break;
    case 'p': cur?.querySelector('a.author')?.click(); break;
    case 'n': location.hash = '#/compose'; break;
    case '?': location.hash = '#/help'; break;
    default: return;
  }
  e.preventDefault();
});

// ---------- nav & router ----------
export function updateNav() {
  const signed = !!me();
  document.querySelectorAll('[data-needs-signin]').forEach((el) => { el.hidden = !signed; });
  document.querySelectorAll('[data-needs-signer]').forEach((el) => { el.hidden = !canSign(); });
  const acct = document.getElementById('nav-account');
  if (acct) acct.textContent = signed ? 'Account' : 'Sign in';
  const prof = document.getElementById('nav-profile');
  if (prof && signed) prof.href = profileHref(me());
  const g = document.getElementById('nav-global'); if (g) g.textContent = w('Global');
  const c = document.getElementById('nav-compose'); if (c) c.textContent = `New ${w('note')}`;
  const hash = location.hash || '#/';
  document.querySelectorAll('nav.site-nav a').forEach((a) => {
    const here = a.getAttribute('href') === hash || (hash === '#/' && a.dataset.home === (signed ? 'home' : 'global'));
    if (here) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

export function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, param] = [hash.split('/')[0], decodeURIComponent(hash.split('/').slice(1).join('/'))];
  updateNav();
  switch (name) {
    case '': return me() ? viewHome() : viewGlobal();
    case 'home': return viewHome();
    case 'global': return viewGlobal();
    case 'notifications': return viewNotifications();
    case 'p': return viewProfile(param);
    case 'n': return viewThread(param);
    case 'compose': return viewCompose();
    case 'login': return viewLogin();
    case 'settings': return viewSettings();
    case 'help': return viewHelp();
    default: startView('Page not found'); main.append(h('p', {}, h('a', { href: '#/' }, 'Go home')));
  }
}
