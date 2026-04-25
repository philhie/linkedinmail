// Tiny in-memory chrome.* shim sufficient for unit-testing lib/state.js's
// loadSettings/saveSettings/loadRuntime/saveRuntime + migrateTokenStorageOnce.
//
// Importing this module installs the shim on globalThis. Each call to
// `resetChrome()` returns the underlying stores so tests can inspect/mutate
// them directly.

class StorageArea {
  constructor() {
    /** @type {Record<string, unknown>} */
    this._store = {};
  }
  async get(keysOrDefaults) {
    if (keysOrDefaults === null || keysOrDefaults === undefined) {
      return { ...this._store };
    }
    if (typeof keysOrDefaults === 'string') {
      const v = this._store[keysOrDefaults];
      return v === undefined ? {} : { [keysOrDefaults]: v };
    }
    if (Array.isArray(keysOrDefaults)) {
      const out = {};
      for (const k of keysOrDefaults) {
        if (k in this._store) out[k] = this._store[k];
      }
      return out;
    }
    if (typeof keysOrDefaults === 'object') {
      // {key: defaultValue} form
      const out = {};
      for (const [k, def] of Object.entries(keysOrDefaults)) {
        out[k] = (k in this._store) ? this._store[k] : def;
      }
      return out;
    }
    return {};
  }
  async set(patch) {
    Object.assign(this._store, patch);
  }
  async remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) delete this._store[k];
  }
  _dump() { return { ...this._store }; }
  _reset() { this._store = {}; }
}

const sync = new StorageArea();
const local = new StorageArea();

globalThis.chrome = {
  storage: { sync, local }
};

export function resetChrome() {
  sync._reset();
  local._reset();
  return { sync, local };
}

export function getStorage() {
  return { sync, local };
}
