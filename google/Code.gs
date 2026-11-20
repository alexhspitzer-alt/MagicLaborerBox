const HEADERS = ['Job ID', 'Status', 'Instructions', 'Input', 'Output format', 'Max output tokens', 'Result', 'Worker', 'Lease until', 'Lease token', 'Attempts', 'Model', 'Finish reason', 'Updated', 'Error', 'Review'];
const LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
function leaseMs_(value) {
  if (value == null || String(value).trim() === '') return LEASE_MS;
  const ms = Number(value) * 60 * 60 * 1000;
  if (typeof value === 'boolean' || !Number.isFinite(ms) || ms < 1 || !Number.isFinite(new Date(Date.now() + ms).getTime())) return 0;
  return ms;
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
    if (request.action === 'recipeCheck') return { ok: true };
    if (request.action === 'recipeSave' || request.action === 'recipeFinish') return recipeLog_(ss, request);
    const sheet = ss.getSheetByName('Jobs');
    validateHeaders_(sheet);
    const leaseIndex = sheet.getRange(1, 19).getValues()[0][0] === 'Lease hours' ? 18 : -1;
    const rows = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(HEADERS.length, leaseIndex + 1)).getValues();
    const ids = rows.filter(r => r[0]).map(r => String(r[0]));
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate Job IDs. Give every row a unique ID.');
    const now = Date.now();
    if (request.action === 'ping') return { ok: true, recoveryVersion: 1, spreadsheetUrl: ss.getUrl(), ready: rows.filter(r => r[1] === 'Ready').length };
    // Persist cancellation before releasing: a delayed claim must never resurrect it.
    const claimKey = request.claimId ? 'claim-cancelled:' + request.worker + ':' + request.claimId : '';
    if (request.claimId && !/^[a-f0-9-]{36}$/.test(request.claimId)) throw new Error('Invalid claim ID.');
    if (request.action === 'releaseClaim') {
      if (!claimKey) throw new Error('Claim ID required.');
      props.setProperty(claimKey, String(now));
      const i = rows.findIndex(r => r[7] === request.worker && r[9] === request.claimId && r[1] === 'Working');
      if (i >= 0) {
        sheet.getRange(i + 2, 2).setValue('Ready');
        sheet.getRange(i + 2, 8, 1, 4).setValues([['', '', '', Math.max(0, (Number(rows[i][10]) || 1) - 1)]]);
        SpreadsheetApp.flush();
      }
      return { ok: true, completed: rows.some(r => r[7] === request.worker && r[9] === request.claimId && ['Done', 'Needs review', 'Error'].indexOf(r[1]) >= 0) };
    }
    if (request.action === 'claim') {
      if (claimKey && props.getProperty(claimKey)) return { job: null };
      // A retry of the same request returns its original claim, not another job.
      const existing = request.claimId && rows.find(r => r[7] === request.worker && r[9] === request.claimId);
      if (existing) return { job: existing[1] === 'Working' ? { id: String(existing[0]), instructions: String(existing[2]), input: String(existing[3]), format: String(existing[4] || 'text'), maxTokens: Number(existing[5]) || 512, lease: existing[9], leaseUntil: existing[8] } : null };

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
        const duration = leaseMs_(row[leaseIndex]);
        if (!duration) {
          sheet.getRange(i + 2, 2).setValue('Needs review');
          sheet.getRange(i + 2, 15).setValue('Invalid Lease hours: enter a positive number or leave blank for 24 hours.');
          continue;
        }
        const lease = request.claimId || Utilities.getUuid();
        const until = new Date(now + duration).toISOString();
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
      const duration = leaseMs_(row[leaseIndex]);
      if (!duration) throw new Error('Invalid Lease hours: enter a positive number or leave blank.');
      sheet.getRange(n, 9).setValue(new Date(now + duration).toISOString());
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

function recipeLog_(ss, request) {
  const headers = ['ID', 'Time', 'Search', 'Recipe', 'URL', 'Ingredients', 'Model', 'Explanation', 'Verdict', 'Raw verdict'];
  if (!/^[0-9a-f-]{36}$/i.test(request.id || '')) throw new Error('Invalid recipe log ID.');
  let sheet = ss.getSheetByName('Recipe Test');
  if (!sheet && request.action === 'recipeSave') {
    sheet = ss.insertSheet('Recipe Test');
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  if (!sheet || sheet.getRange(1, 1, 1, headers.length).getValues()[0].join('|') !== headers.join('|')) {
    throw new Error('Recipe Test log is missing or its headers have changed.');
  }
  const last = sheet.getLastRow();
  const existing = last > 1 && sheet.getRange(2, 1, last - 1, 1).createTextFinder(request.id).matchEntireCell(true).findNext();
  if (request.action === 'recipeSave') {
    const row = existing ? existing.getRow() : last + 1;
    if (!existing) {
      sheet.appendRow([request.id, new Date().toISOString(), ...[
        request.query, request.title, request.url, request.ingredients, request.model, request.explanation,
      ].map(safeText_)]);
      SpreadsheetApp.flush();
    }
    return { explanation: String(sheet.getRange(row, 8).getValue()) };
  }
  if (!existing || !['YES', 'NO', 'UNCERTAIN'].includes(request.verdict)) throw new Error('Invalid recipe verdict or missing log row.');
  sheet.getRange(existing.getRow(), 9, 1, 2).setValues([[request.verdict, safeText_(request.reply)]]);
  SpreadsheetApp.flush();
  return { ok: true };
}
