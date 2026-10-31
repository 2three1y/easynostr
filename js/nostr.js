// easynostr: Nostr protocol helpers (NIP-01, NIP-19). Written from scratch for easynostr.
// Cryptography comes from the vendored noble-secp256k1 (MIT, Paul Miller). See CREDITS.md.
import { schnorr, utils } from './vendor/noble-secp256k1.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('Not valid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};
export const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

// ---------- bech32 (BIP-173), used by NIP-19 ----------
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('Bad padding');
  return out;
}
export function bech32Encode(hrp, bytes) {
  const data = convertBits(bytes, 8, 5, true);
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((d) => CHARSET[d]).join('');
}
export function bech32Decode(str) {
  const s = str.trim().toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new Error('Not a valid Nostr code');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const i = CHARSET.indexOf(c); if (i < 0) throw new Error('Not a valid Nostr code'); return i;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('That code has a typo (checksum failed)');
  return { prefix: hrp, bytes: new Uint8Array(convertBits(data.slice(0, -6), 5, 8, false)) };
}

// ---------- NIP-19 ----------
export const npubEncode = (hex) => bech32Encode('npub', fromHex(hex));
export const nsecEncode = (bytes) => bech32Encode('nsec', bytes);
export const noteEncode = (hex) => bech32Encode('note', fromHex(hex));
export function neventEncode(id, relays = [], author) {
  const parts = [[0, fromHex(id)]];
  for (const r of relays.slice(0, 2)) parts.push([1, enc.encode(r)]);
  if (author) parts.push([2, fromHex(author)]);
  const tlv = [];
  for (const [t, v] of parts) tlv.push(t, v.length, ...v);
  return bech32Encode('nevent', new Uint8Array(tlv));
}
function parseTLV(bytes) {
  const out = {};
  let i = 0;
  while (i + 1 < bytes.length) {
    const t = bytes[i], l = bytes[i + 1];
    const v = bytes.slice(i + 2, i + 2 + l);
    (out[t] ||= []).push(v);
    i += 2 + l;
  }
  return out;
}
// Decode npub, nsec, note, nprofile, nevent. Returns { type, data }.
export function decode(code) {
  let c = code.trim();
  if (c.startsWith('nostr:')) c = c.slice(6);
  const { prefix, bytes } = bech32Decode(c);
  if (prefix === 'npub' || prefix === 'note') {
    if (bytes.length !== 32) throw new Error('Wrong length');
    return { type: prefix, data: toHex(bytes) };
  }
  if (prefix === 'nsec') {
    if (bytes.length !== 32) throw new Error('Wrong length');
    return { type: 'nsec', data: bytes };
  }
  if (prefix === 'nprofile' || prefix === 'nevent') {
    const tlv = parseTLV(bytes);
    if (!tlv[0] || tlv[0][0].length !== 32) throw new Error('Missing id');
    const data = { id: toHex(tlv[0][0]), relays: (tlv[1] || []).map((r) => dec.decode(r)) };
    if (tlv[2] && tlv[2][0].length === 32) data.author = toHex(tlv[2][0]);
    if (prefix === 'nprofile') return { type: 'nprofile', data: { pubkey: data.id, relays: data.relays } };
    return { type: 'nevent', data };
  }
  throw new Error('Unsupported code type: ' + prefix);
}

// ---------- keys & events (NIP-01) ----------
export const generateSecretKey = () => utils.randomSecretKey();
export const getPublicKey = (sk) => toHex(schnorr.getPublicKey(sk));

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
export const serializeEvent = (e) => JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
export async function getEventHash(e) {
  return toHex(await sha256(enc.encode(serializeEvent(e))));
}
export async function signWithKey(template, sk) {
  const e = { ...template, pubkey: getPublicKey(sk) };
  e.id = await getEventHash(e);
  e.sig = toHex(await schnorr.signAsync(fromHex(e.id), sk));
  return e;
}
export async function verifyEvent(e) {
  try {
    if (!isHex64(e.id) || !isHex64(e.pubkey) || typeof e.sig !== 'string') return false;
    if ((await getEventHash(e)) !== e.id) return false;
    return await schnorr.verifyAsync(fromHex(e.sig), fromHex(e.id), fromHex(e.pubkey));
  } catch { return false; }
}

// ---------- relay pool ----------
// A tiny pool: one WebSocket per relay, opened on demand, reconnected on demand.
export class Pool {
  constructor() { this.conns = new Map(); this.subId = 0; this.down = new Map(); }

  isDown(url) { return (this.down.get(url) || 0) > Date.now(); }

  connect(url) {
    let c = this.conns.get(url);
    if (c && (c.ws.readyState === 0 || c.ws.readyState === 1)) return c.ready;
    if (this.isDown(url)) return Promise.resolve(null);
    const fail = () => this.down.set(url, Date.now() + 60000); // skip a dead relay for a minute
    c = { url, subs: new Map(), oks: new Map() };
    c.ready = new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket(url); } catch { resolve(null); return; }
      c.ws = ws;
      let opened = false;
      const timer = setTimeout(() => { fail(); try { ws.close(); } catch {} resolve(null); }, 5000);
      ws.onopen = () => { opened = true; clearTimeout(timer); this.down.delete(url); resolve(c); };
      ws.onerror = () => { clearTimeout(timer); if (!opened) fail(); resolve(null); };
      ws.onclose = () => {
        clearTimeout(timer); resolve(null);
        for (const s of c.subs.values()) s.onEose?.();
        for (const o of c.oks.values()) o(false, 'connection closed');
        c.subs.clear(); c.oks.clear();
      };
      ws.onmessage = (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        const [type, a, b, d] = msg;
        if (type === 'EVENT') c.subs.get(a)?.onEvent?.(b, url);
        else if (type === 'EOSE') c.subs.get(a)?.onEose?.();
        else if (type === 'CLOSED') c.subs.get(a)?.onEose?.();
        else if (type === 'OK') { const f = c.oks.get(a); if (f) { c.oks.delete(a); f(!!b, d || ''); } }
      };
    });
    if (!c.ws) c.ws = { readyState: 0 };
    this.conns.set(url, c);
    return c.ready;
  }

  // Query relays and collect events until every relay says EOSE (or timeout).
  async query(relays, filters, { timeout = 7000, onEvent } = {}) {
    const seen = new Map();
    const id = 'en' + (++this.subId).toString(36);
    await Promise.all(relays.map(async (url) => {
      const c = await this.connect(url);
      if (!c) return;
      await new Promise((resolve) => {
        let finished = false;
        const done = () => {
          if (finished) return; finished = true;
          clearTimeout(t);
          c.subs.delete(id);
          if (c.ws.readyState === 1) c.ws.send(JSON.stringify(['CLOSE', id]));
          resolve();
        };
        const t = setTimeout(done, timeout);
        c.subs.set(id, {
          onEvent: (ev) => {
            if (!ev || typeof ev.id !== 'string') return;
            if (!seen.has(ev.id)) { seen.set(ev.id, ev); onEvent?.(ev, url); }
          },
          onEose: done,
        });
        if (c.ws.readyState === 1) c.ws.send(JSON.stringify(['REQ', id, ...filters])); else done();
      });
    }));
    return [...seen.values()];
  }

  // Publish to every relay; resolves with a list of {url, ok, message}.
  async publish(relays, event) {
    return Promise.all(relays.map(async (url) => {
      const c = await this.connect(url);
      if (!c) return { url, ok: false, message: 'could not connect' };
      return new Promise((resolve) => {
        const t = setTimeout(() => { c.oks.delete(event.id); resolve({ url, ok: false, message: 'no answer' }); }, 8000);
        c.oks.set(event.id, (ok, message) => { clearTimeout(t); resolve({ url, ok, message }); });
        if (c.ws.readyState === 1) c.ws.send(JSON.stringify(['EVENT', event]));
        else { clearTimeout(t); c.oks.delete(event.id); resolve({ url, ok: false, message: 'not connected' }); }
      });
    }));
  }

  closeAll() { for (const c of this.conns.values()) { try { c.ws.close(); } catch {} } this.conns.clear(); }
}
