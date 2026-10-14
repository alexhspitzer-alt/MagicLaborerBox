const HEADERS = ['Job ID', 'Status', 'Instructions', 'Input', 'Output format', 'Max output tokens', 'Result', 'Worker', 'Lease until', 'Lease token', 'Attempts', 'Model', 'Finish reason', 'Updated', 'Error', 'Review'];
const LEASE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// Run once from the editor while signed in as the spreadsheet owner.
function setupQueue_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!sheet) throw new Error('Use a script bound to the queue spreadsheet.');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', sheet.getId());
  props.setProperty('ALLOWED_ORIGIN', 'https://alexhspitzer-alt.github.io');
  if (!props.getProperty('WORKER_TOKEN')) props.setProperty('WORKER_TOKEN', Utilities.getUuid() + Utilities.getUuid());
  let jobs = sheet.getSheetByName('Jobs');
  if (!jobs) jobs = sheet.insertSheet('Jobs');
  if (!jobs.getLastRow()) jobs.appendRow(HEADERS);
  validateHeaders_(jobs);
  jobs.setFrozenRows(1);
  jobs.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Laborer box').addItem('Show worker connection', 'showConnection_').addToUi();
}
function showConnection_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('WORKER_TOKEN');
  if (!token) throw new Error('Run setupQueue first.');
  SpreadsheetApp.getUi().alert('Worker connection', 'Web app URL: ' + (ScriptApp.getService().getUrl() || 'Deploy the web app first.') + '\n\nWorker key: ' + token, SpreadsheetApp.getUi().ButtonSet.OK);
}
function doGet(e) {
  const origin = PropertiesService.getScriptProperties().getProperty('ALLOWED_ORIGIN');
  if (!origin || e.parameter.origin !== origin || !/^[a-f0-9-]{36}$/.test(e.parameter.channel || '')) {
    return HtmlService.createHtmlOutput('Open this bridge through Magic Laborer Box.');
  }
  const page = HtmlService.createTemplateFromFile('Bridge');
  page.config = JSON.stringify({ origin: origin, channel: e.parameter.channel });
  return page.evaluate().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function validateHeaders_(sheet) {
  const actual = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (actual.some((v, i) => v !== HEADERS[i])) throw new Error('Jobs headers changed. Restore the documented column order.');
}
function safeText_(value) {
  const text = String(value == null ? '' : value);
  if (text.length > 45000) throw new Error('Result exceeds the 45,000 character cell limit. Split the job.');
  return /^[=+@-]/.test(text) ? "'" + text : text;
}
function queueRequest(request) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('WORKER_TOKEN');
  if (!expected || !request || request.token !== expected) throw new Error('Invalid worker key.');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(request.worker || '')) throw new Error('Invalid worker ID.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
    const sheet = ss.getSheetByName('Jobs');
    validateHeaders_(sheet);
    const rows = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
    const ids = rows.filter(r => r[0]).map(r => String(r[0]));
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate Job IDs. Give every row a unique ID.');
    const now = Date.now();
    if (request.action === 'ping') return { ok: true, spreadsheetUrl: ss.getUrl(), ready: rows.filter(r => r[1] === 'Ready').length };
    if (request.action === 'claim') {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row[0]) continue;
        const expired = row[1] === 'Working' && Date.parse(String(row[8])) <= now;
        if (row[1] !== 'Ready' && !expired) continue;
        const attempts = Number(row[10]) || 0;
        if (attempts >= MAX_ATTEMPTS || !String(row[2]).trim()) {
          sheet.getRange(i + 2, 2).setValue('Needs review');
          sheet.getRange(i + 2, 15).setValue(attempts >= MAX_ATTEMPTS ? 'Attempt limit reached.' : 'Instructions missing.');
          continue;
        }
        const lease = Utilities.getUuid();
        const until = new Date(now + LEASE_MS).toISOString();
        sheet.getRange(i + 2, 2).setValue('Working');
        sheet.getRange(i + 2, 8, 1, 4).setValues([[request.worker, until, lease, attempts + 1]]);
        sheet.getRange(i + 2, 14).setValue(new Date(now).toISOString());
        SpreadsheetApp.flush();
        return { job: { id: String(row[0]), instructions: String(row[2]), input: String(row[3]), format: String(row[4] || 'text'), maxTokens: Number(row[5]) || 512, lease: lease, leaseUntil: until } };
      }
      return { job: null };
    }
    const index = rows.findIndex(r => String(r[0]) === request.jobId);
    if (index < 0) throw new Error('Job no longer exists.');
    const row = rows[index], n = index + 2;
    // Keep the lease token after completion so an upload retry is idempotent.
    if (row[7] !== request.worker || row[9] !== request.lease) return { stale: true };
    if (request.action === 'complete' && ['Done', 'Needs review', 'Error'].indexOf(row[1]) >= 0) return { ok: true };
    if (row[1] !== 'Working') return { stale: true };
    if (request.action === 'heartbeat') {
      sheet.getRange(n, 9).setValue(new Date(now + LEASE_MS).toISOString());
    } else if (request.action === 'complete') {
      const status = ['Done', 'Needs review', 'Error'].indexOf(request.status) >= 0 ? request.status : 'Needs review';
      sheet.getRange(n, 7).setValue(safeText_(request.result));
      sheet.getRange(n, 12, 1, 5).setValues([[safeText_(request.model), safeText_(request.finishReason), new Date(now).toISOString(), safeText_(request.error), '']]);
      sheet.getRange(n, 2).setValue(status);
    } else throw new Error('Unknown action.');
    SpreadsheetApp.flush();
    return { ok: true };
  } finally { lock.releaseLock(); }
}
