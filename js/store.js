// Encrypted on-device vault.
// All data lives in one AES-GCM encrypted blob in IndexedDB. A random data key encrypts it.
// The data key is itself wrapped (encrypted) by: (a) a key derived from the recovery passphrase,
// and optionally (b) a key derived from a Face ID / Touch ID passkey via the WebAuthn PRF extension.
// Nothing here talks to a server.

const DB_NAME = 'ledger-app-vault'; // unique: other apps on the same github.io origin share IndexedDB
const STORE = 'kv';
const PBKDF2_ITER = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();

// Chunked: spreading a large array into String.fromCharCode overflows Safari's argument limit (~65k)
const b64 = (buf) => { const u = new Uint8Array(buf); let str = ''; for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(str); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(key) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(STORE).objectStore(STORE).get(key); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
}
async function kvSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function kvClear() {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

async function passKek(pass, salt, iter = PBKDF2_ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function prfKek(prfBytes) {
  const base = await crypto.subtle.importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('ledger-passkey-v1'), info: enc.encode('wrap') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function wrap(kek, rawKey) { const iv = rand(12); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, rawKey); return { iv: b64(iv), ct: b64(ct) }; }
async function unwrap(kek, w) { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, kek, unb64(w.ct))); }
const importData = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function sealJSON(key, obj) { const iv = rand(12); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))); return { iv: b64(iv), ct: b64(ct) }; }
async function openJSON(key, box) { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct)))); }

// ---------- Passkey (Face ID) ----------
export async function passkeySupport() {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) return { ok: false, why: 'This browser has no passkey support.' };
  try {
    if (PublicKeyCredential.getClientCapabilities) {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps['extension:prf'] === false) return { ok: false, why: 'This device cannot use Face ID to unlock web app data. Update iOS (18 or later) or use the passphrase.' };
    }
    const uv = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!uv) return { ok: false, why: 'Face ID or Touch ID is not set up on this device.' };
  } catch (e) { /* fall through and try */ }
  return { ok: true };
}

async function passkeyPrf(credId, prfSalt) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: rand(32), userVerification: 'required', timeout: 60000,
      allowCredentials: [{ type: 'public-key', id: unb64(credId) }],
      extensions: { prf: { eval: { first: unb64(prfSalt) } } },
    },
  });
  const r = cred.getClientExtensionResults()?.prf?.results?.first;
  if (!r) throw new Error('Face ID worked, but this device did not return an unlock key. Use the passphrase instead.');
  return new Uint8Array(r);
}

// ---------- Vault ----------
export class Vault {
  constructor() { this.key = null; this.raw = null; this.meta = null; this.data = null; this._t = null; this.onSaved = null; }

  async exists() { this.meta = await kvGet('meta'); return !!this.meta; }
  get hasPasskey() { return !!this.meta?.passkey; }

  async create(passphrase, initialData) {
    const raw = rand(32);
    const salt = rand(16);
    const kek = await passKek(passphrase, salt);
    this.meta = { v: 1, createdAt: new Date().toISOString(), pass: { salt: b64(salt), iter: PBKDF2_ITER, ...(await wrap(kek, raw)) } };
    this.raw = raw; this.key = await importData(raw);
    this.data = initialData;
    await kvSet('meta', this.meta);
    await this.saveNow();
  }

  async unlockWithPassphrase(passphrase) {
    const p = this.meta.pass;
    const kek = await passKek(passphrase, unb64(p.salt), p.iter);
    let raw;
    try { raw = await unwrap(kek, p); } catch { throw new Error('Wrong passphrase.'); }
    await this._open(raw);
  }

  async unlockWithPasskey() {
    const pk = this.meta.passkey;
    const prf = await passkeyPrf(pk.credId, pk.prfSalt);
    const raw = await unwrap(await prfKek(prf), pk);
    await this._open(raw);
  }

  async _open(raw) {
    this.raw = raw; this.key = await importData(raw);
    const box = await kvGet('data');
    this.data = await openJSON(this.key, box);
  }

  async enablePasskey(userLabel = 'Ledger') {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: rand(32),
        rp: { name: 'Ledger' },
        user: { id: rand(16), name: userLabel, displayName: userLabel },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        timeout: 60000,
        extensions: { prf: {} },
      },
    });
    const ext = credential.getClientExtensionResults();
    if (ext?.prf && ext.prf.enabled === false) throw new Error('This device does not support Face ID unlock for web apps. Keep using the passphrase.');
    const credId = b64(credential.rawId);
    const prfSalt = b64(rand(32));
    const prf = await passkeyPrf(credId, prfSalt); // a second prompt: iOS only returns the PRF value on sign-in
    this.meta.passkey = { credId, prfSalt, ...(await wrap(await prfKek(prf), this.raw)) };
    await kvSet('meta', this.meta);
  }

  async disablePasskey() { delete this.meta.passkey; await kvSet('meta', this.meta); }

  // App lock off: the data key is wrapped by a device key that can never leave this browser's storage
  // (non-extractable), so Ledger opens without Face ID or the passphrase. Data stays encrypted at rest.
  get lockOff() { return !!this.meta?.device; }
  async setLockOff() {
    const dk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const w = await wrap(dk, this.raw);
    await kvSet('deviceKey', dk);
    this.meta.device = w;
    await kvSet('meta', this.meta);
  }
  async setLockOn() { delete this.meta.device; await kvSet('meta', this.meta); await kvSet('deviceKey', null); }
  async unlockWithDevice() {
    const dk = await kvGet('deviceKey');
    if (!dk || !this.meta.device) throw new Error('No device key');
    await this._open(await unwrap(dk, this.meta.device));
  }

  async changePassphrase(oldPass, newPass) {
    const p = this.meta.pass;
    try { await unwrap(await passKek(oldPass, unb64(p.salt), p.iter), p); } catch { throw new Error('Current passphrase is wrong.'); }
    const salt = rand(16);
    this.meta.pass = { salt: b64(salt), iter: PBKDF2_ITER, ...(await wrap(await passKek(newPass, salt), this.raw)) };
    await kvSet('meta', this.meta);
  }

  lock() { clearTimeout(this._t); this.key = null; this.raw = null; this.data = null; }

  save() { clearTimeout(this._t); this._t = setTimeout(() => this.saveNow().catch((e) => this.onError?.(e)), 300); }
  async saveNow() {
    clearTimeout(this._t);
    if (!this.key || !this.data) return;
    this.data.savedAt = new Date().toISOString();
    await kvSet('data', await sealJSON(this.key, this.data));
    this.onSaved?.();
  }

  // Backup file: encrypted data plus the passphrase-wrapped key. Restoring needs the recovery passphrase.
  async exportBackup() {
    await this.saveNow();
    return { format: 'ledger-backup', v: 1, exportedAt: new Date().toISOString(), pass: this.meta.pass, data: await kvGet('data') };
  }

  static async restoreBackup(file, passphrase) {
    if (file?.format !== 'ledger-backup') throw new Error('This is not a Ledger backup file.');
    const p = file.pass;
    let raw;
    try { raw = await unwrap(await passKek(passphrase, unb64(p.salt), p.iter), p); } catch { throw new Error('Wrong passphrase for this backup.'); }
    const data = await openJSON(await importData(raw), file.data); // proves it decrypts before we overwrite anything
    await kvClear();
    await kvSet('meta', { v: 1, createdAt: new Date().toISOString(), restoredAt: new Date().toISOString(), pass: p });
    await kvSet('data', file.data);
    return data;
  }

  static async erase() { await kvClear(); }
}

export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}
