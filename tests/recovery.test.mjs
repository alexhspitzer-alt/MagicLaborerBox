import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const CLAIM = 'magic-laborer.claim.v1', OUTBOX = 'magic-laborer.outbox.v1';
const endpoint = 'https://script.google.com/macros/s/test/exec', worker = 'box_test';
async function workerHarness(handle, initial = {}) {
  const storage = new Map(Object.entries(initial)), elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', addEventListener(event, fn) { this[event] = fn; } });
    return elements.get(id);
  };
  const context = vm.createContext({ console, crypto, URL, location: { protocol: 'https:' },
    document: { cookie: '', baseURI: 'https://example.test/' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    navigator: { onLine: true, locks: { request: async (name, options, fn) => fn({}) } },
    window: { setTimeout: fn => { queueMicrotask(fn); return 1; }, setInterval: () => 1 }, clearInterval() {},
    element,
    QueueClient: class { close() {} async request(action, fields = {}) {
      calls.push({ action, ...fields });
      if (action === 'ping') return { recoveryVersion: 1, ready: 1 };
      return handle(action, fields, { storage, elements });
    } }
  });
  let source = readFileSync(new URL('../src/laborer.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
  vm.runInContext(stripTypeScriptTypes(source), context);
  context.installLaborer({ available: () => true, lock() {}, generate: async () => { throw Error('unexpected generation'); } });
  element('queue-url').value = endpoint; element('queue-worker').value = worker; element('queue-key').value = 'key';
  await element('queue-connect').click();
  await element('queue-start').click();
  return { storage, calls, status: element('queue-status').textContent };
}
test('three lost claim replies release the same ID before any fresh claim', async () => {
  const h = await workerHarness((action, fields, { elements }) => {
    if (action === 'claim') throw Error('Google request timed out');
    if (action === 'releaseClaim') { elements.get('queue-pause').click(); return { ok: true }; }
    throw Error(action);
  });
  const claims = h.calls.filter(c => c.action === 'claim');
  assert.equal(claims.length, 3); assert.equal(new Set(claims.map(c => c.claimId)).size, 1);
  assert.equal(h.calls.at(-1).claimId, claims[0].claimId); assert.equal(h.storage.has(CLAIM), false);
});
test('failed release retains intent and reload retries release without claiming', async () => {
  const saved = JSON.stringify({ endpoint, worker, claimId: crypto.randomUUID(), releasing: true });
  const failed = await workerHarness(() => { throw Error('Lock timeout'); }, { [CLAIM]: saved });
  assert.equal(failed.calls.filter(c => c.action === 'claim').length, 0);
  assert.equal(failed.calls.filter(c => c.action === 'releaseClaim').length, 3);
  assert.equal(JSON.parse(failed.storage.get(CLAIM)).releasing, true);
  const resumed = await workerHarness((action, fields, { elements }) => {
    assert.equal(action, 'releaseClaim'); elements.get('queue-pause').click(); return { ok: true };
  }, { [CLAIM]: failed.storage.get(CLAIM) });
  assert.equal(resumed.storage.has(CLAIM), false);
});
test('exhausted result uploads retain a backup and release before further work', async () => {
  const result = { endpoint, worker, jobId: 'job-1', lease: crypto.randomUUID(), result: 'important output', status: 'Done' };
  const h = await workerHarness((action, fields, { elements, storage }) => {
    if (action === 'complete') throw Error('Google request timed out');
    assert.equal(action, 'releaseClaim');
    assert.equal(JSON.parse(storage.get(`magic-laborer.retained.${result.lease}`)).result, result.result);
    elements.get('queue-pause').click(); return { ok: true };
  }, { [OUTBOX]: JSON.stringify(result) });
  assert.equal(h.calls.filter(c => c.action === 'complete').length, 8);
  assert.equal(h.storage.has(OUTBOX), false);
  assert.equal(h.calls.filter(c => c.action === 'claim').length, 0);
});
