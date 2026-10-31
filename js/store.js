// easynostr: settings, account and small caches, kept in this browser's localStorage only.
import { getPublicKey, fromHex, toHex, signWithKey } from './nostr.js';

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
];

const DEFAULT_SETTINGS = {
  theme: 'auto',          // auto | dark | light
  textSize: 'normal',     // normal | large | xlarge
  relays: DEFAULT_RELAYS,
  shortcuts: false,       // off by default so they never fight a screen reader
  showImages: true,
  plain: false,           // plain-language mode
  announceCount: true,    // say the character count when you pause typing
  confirmRepost: true,
  reduceMotion: false,
};

const KEY_SETTINGS = 'easynostr.settings';
const KEY_ACCOUNT = 'easynostr.account';

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}

export const settings = { ...DEFAULT_SETTINGS, ...readJSON(KEY_SETTINGS, {}) };
if (!Array.isArray(settings.relays) || !settings.relays.length) settings.relays = [...DEFAULT_RELAYS];

export function saveSettings() { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); }
export function resetRelays() { settings.relays = [...DEFAULT_RELAYS]; saveSettings(); }

// ---------- account ----------
// mode: 'nip07' (browser extension signs), 'key' (secret key kept in localStorage), 'readonly' (npub only)
export const accountHolder = { value: readJSON(KEY_ACCOUNT, null) };

export function setAccount(next) {
  accountHolder.value = next || null;
  if (next) localStorage.setItem(KEY_ACCOUNT, JSON.stringify(next));
  else localStorage.removeItem(KEY_ACCOUNT);
}
export const me = () => accountHolder.value?.pubkey || null;
export const canSign = () => ['nip07', 'key'].includes(accountHolder.value?.mode);

export function signInWithKey(skBytes) {
  const pubkey = getPublicKey(skBytes);
  setAccount({ mode: 'key', pubkey, sk: toHex(skBytes) });
  return pubkey;
}
export function signInReadOnly(pubkey) { setAccount({ mode: 'readonly', pubkey }); }
export function signInExtension(pubkey) { setAccount({ mode: 'nip07', pubkey }); }
export function logOut() {
  setAccount(null);
  localStorage.removeItem('easynostr.profiles');
}

export async function sign(template) {
  const a = accountHolder.value;
  const t = { created_at: Math.floor(Date.now() / 1000), tags: [], content: '', ...template };
  if (a?.mode === 'key') return signWithKey(t, fromHex(a.sk));
  if (a?.mode === 'nip07') {
    if (!window.nostr) throw new Error('Your Nostr browser extension is not available right now.');
    return window.nostr.signEvent(t);
  }
  throw new Error('Sign in with a key or extension to do that.');
}

// ---------- profile cache ----------
export const profiles = new Map(Object.entries(readJSON('easynostr.profiles', {})));
let saveTimer;
export function rememberProfile(pubkey, p) {
  profiles.set(pubkey, p);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries = [...profiles.entries()].slice(-400);
    try { localStorage.setItem('easynostr.profiles', JSON.stringify(Object.fromEntries(entries))); } catch {}
  }, 800);
}
