import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiCache } from './apiCache.js';

/**
 * A minimal `indexedDB.open` stand-in: hands the caller the request object
 * so the test can fire whichever event it wants to simulate.
 */
function installFakeIndexedDb(onOpen) {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = {
    open() {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      queueMicrotask(() => onOpen(req));
      return req;
    },
  };
  return () => {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  };
}

/** A database object with just enough of the IndexedDB surface for `get`. */
function fakeDb(value) {
  return {
    transaction() {
      return {
        objectStore() {
          return {
            get() {
              const req = { result: value ? { value } : undefined, onsuccess: null, onerror: null };
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
          };
        },
      };
    },
  };
}

test('an open blocked by another tab misses instead of hanging the caller', async () => {
  const restore = installFakeIndexedDb((req) => req.onblocked?.());
  try {
    const cache = new ApiCache();
    assert.equal(await cache.get('mapContourLines', 'k'), undefined);
  } finally {
    restore();
  }
});

test('a failed open is not memoized — a later call opens the database again', async () => {
  let attempts = 0;
  const restore = installFakeIndexedDb((req) => {
    attempts += 1;
    if (attempts === 1) { req.onblocked?.(); return; }
    req.result = fakeDb('cached-value');
    req.onsuccess?.();
  });
  try {
    const cache = new ApiCache();
    assert.equal(await cache.get('mapContourLines', 'k'), undefined);
    assert.equal(await cache.get('mapContourLines', 'k'), 'cached-value');
    assert.equal(attempts, 2);
  } finally {
    restore();
  }
});

test('a successful open is reused rather than reopened per call', async () => {
  let attempts = 0;
  const restore = installFakeIndexedDb((req) => {
    attempts += 1;
    req.result = fakeDb('cached-value');
    req.onsuccess?.();
  });
  try {
    const cache = new ApiCache();
    await cache.get('mapContourLines', 'a');
    await cache.get('mapContourLines', 'b');
    assert.equal(attempts, 1);
  } finally {
    restore();
  }
});

test('an open that never fires any event still resolves the read, as a miss', async () => {
  const restore = installFakeIndexedDb(() => { /* silence — the pathological case */ });
  try {
    const cache = new ApiCache();
    const started = Date.now();
    assert.equal(await cache.get('mapContourLines', 'k'), undefined);
    assert.ok(Date.now() - started < 10000, 'the read must give up, not wait indefinitely');
  } finally {
    restore();
  }
});
