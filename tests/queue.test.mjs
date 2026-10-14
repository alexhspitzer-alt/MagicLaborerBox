import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const headers = ['Job ID', 'Status', 'Instructions', 'Input', 'Output format', 'Max output tokens', 'Result', 'Worker', 'Lease until', 'Lease token', 'Attempts', 'Model', 'Finish reason', 'Updated', 'Error', 'Review'];
function queue() {
  const data = [headers.slice(), ['job-1', 'Ready', 'Extract animals', 'A dog.', 'json', 128, '', '', '', '', 0, '', '', '', '', '']];
  const sheet = { getLastRow: () => data.length, getRange(row, col, height = 1, width = 1) {
    return { getValues: () => data.slice(row - 1, row - 1 + height).map(r => r.slice(col - 1, col - 1 + width)),
      setValue(value) { data[row - 1][col - 1] = value; },
      setValues(values) { values.forEach((r, y) => r.forEach((v, x) => { data[row - 1 + y][col - 1 + x] = v; })); } };
  } };
  const context = vm.createContext({ Date, Set, PropertiesService: { getScriptProperties: () => ({ getProperty: key => ({ WORKER_TOKEN: 'secret', SPREADSHEET_ID: 'queue' })[key] }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, Utilities: { getUuid: () => crypto.randomUUID() },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet, getUrl: () => 'https://docs.google.com/spreadsheets/d/queue/edit' }), flush() {} } });
  vm.runInContext(readFileSync(new URL('../google/Code.gs', import.meta.url), 'utf8'), context);
  return { data, request: (action, fields = {}) => context.queueRequest({ action, token: 'secret', worker: 'box_1', ...fields }) };
}
test('key authentication, unique claims, completion and idempotent retry', () => {
  const q = queue();
  assert.throws(() => q.request('claim', { token: 'wrong' }), /Invalid worker key/);
  const { job } = q.request('claim'); assert.equal(job.id, 'job-1'); assert.equal(q.data[1][1], 'Working');
  assert.equal(q.request('claim', { worker: 'box_2' }).job, null);
  const completion = { jobId: job.id, lease: job.lease, status: 'Done', result: '["dog"]', model: 'small', finishReason: 'stop', error: '' };
  assert.equal(q.request('complete', completion).ok, true); assert.equal(q.data[1][6], '["dog"]');
  assert.equal(q.request('complete', { ...completion, result: 'overwrite' }).ok, true); assert.equal(q.data[1][6], '["dog"]');
  assert.equal(q.request('complete', { ...completion, worker: 'box_2' }).stale, true);
});
test('expired jobs can be reclaimed; late workers cannot overwrite', () => {
  const q = queue(); const old = q.request('claim').job; q.data[1][8] = new Date(0).toISOString();
  const next = q.request('claim', { worker: 'box_2' }).job; assert.notEqual(old.lease, next.lease);
  assert.equal(q.request('complete', { jobId: old.id, lease: old.lease, result: 'late', status: 'Done' }).stale, true);
  assert.equal(q.request('heartbeat', { worker: 'box_2', jobId: next.id, lease: next.lease }).ok, true);
});
test('attempt limits, duplicate IDs and formula-like output are handled', () => {
  const q = queue(); q.data[1][10] = 3; assert.equal(q.request('claim').job, null); assert.equal(q.data[1][1], 'Needs review');
  q.data[1][10] = 0; q.data[1][1] = 'Ready'; const job = q.request('claim').job;
  q.request('complete', { jobId: job.id, lease: job.lease, result: '=IMPORTXML("example")', status: 'Done' });
  assert.equal(q.data[1][6], '\'=IMPORTXML("example")');
  q.data.push(q.data[1].slice()); assert.throws(() => q.request('claim'), /Duplicate Job IDs/);
});
