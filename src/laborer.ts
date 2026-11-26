import { QueueClient, type Job } from './queue-client';
import { element } from './ui';
const SETTINGS = 'magic-laborer.settings.v1', OUTBOX = 'magic-laborer.outbox.v1';
const RETAINED = 'magic-laborer.retained-result.v1';
const CLAIM = 'magic-laborer.claim.v1';
const KEY_COOKIE = 'magic-laborer.worker-key.v1';
const TEMPERATURE = 'magic-laborer.temperature.v1';
type Result = { jobId: string; lease: string; status: string; result: string; model: string; finishReason: string; error: string; endpoint: string; worker: string };
type Host = {
  available: () => boolean;
  generate: (job: Job, onText: (text: string) => void, temperatureOverride?: number) => Promise<{ finishReason: string | null; model: string }>;
  lock: (locked: boolean) => void;
};
export function installLaborer(host: Host) {
  let client: QueueClient | undefined, active = false, pauseRequested = false, wake: WakeLockSentinel | undefined;
  let endpoint = '', worker = '', connected = false;
  let singleTabLock: (() => void) | undefined;
  const status = (text: string) => { element('queue-status').textContent = text; };
  const temperature = element<HTMLInputElement>('queue-temperature');
  const controls = () => {
    element<HTMLButtonElement>('queue-connect').disabled = active;
    element<HTMLButtonElement>('queue-start').disabled = active || !connected;
    element<HTMLButtonElement>('queue-pause').disabled = !active;
    for (const id of ['queue-url', 'queue-key', 'queue-worker']) element<HTMLInputElement>(id).disabled = active;
    temperature.disabled = active;
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS) || '{}');
    element<HTMLInputElement>('queue-url').value = saved.endpoint || 'https://script.google.com/macros/s/AKfycbx93cQePRgC3-isSxCseAazz0Q2shopdXaEzGQs5uFyvsLaPGxPrtSzHRr0L42uVKOf/exec';
    element<HTMLInputElement>('queue-worker').value = saved.worker || `box_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    if (localStorage.getItem(OUTBOX)) status('A saved result is waiting. Connect to its queue, then start to retry the upload.');
  } catch { status('Saved queue settings could not be read.'); }
  try {
    const savedKey = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${KEY_COOKIE}=`));
    if (savedKey) element<HTMLInputElement>('queue-key').value = decodeURIComponent(savedKey.slice(KEY_COOKIE.length + 1));
  } catch { /* A blocked or malformed cookie must not prevent connecting. */ }
  try { temperature.value = localStorage.getItem(TEMPERATURE) ?? ''; }
  catch { /* The override also works without local storage. */ }
  temperature.addEventListener('input', () => {
    if (!temperature.validity.valid) return;
    try { localStorage.setItem(TEMPERATURE, temperature.value); }
    catch { /* Keep the override for this page if saving fails. */ }
  });
  controls();
  element('queue-connect').addEventListener('click', async () => {
    if (active) return;
    connected = false; client?.close(); client = undefined; controls();
    try {
      endpoint = element<HTMLInputElement>('queue-url').value.trim();
      worker = element<HTMLInputElement>('queue-worker').value.trim();
      const token = element<HTMLInputElement>('queue-key').value.trim();
      if (!token || !/^[a-zA-Z0-9_-]{1,100}$/.test(worker)) throw new Error('Enter a worker key and an ID using letters, numbers, underscores or hyphens.');
      client = new QueueClient(endpoint, token, worker); status('Connecting to Google…');
      const info = await client.request('ping');
      if (info.recoveryVersion !== 1) throw new Error('Update the Google queue bridge deployment before using this worker: claim recovery is not installed.');
      localStorage.setItem(SETTINGS, JSON.stringify({ endpoint, worker }));
      try {
        const path = new URL('.', document.baseURI).pathname;
        document.cookie = `${KEY_COOKIE}=${encodeURIComponent(token)}; Path=${path}; Max-Age=31536000; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
      } catch { /* Connecting still works when cookie storage is unavailable. */ }
      if (info.spreadsheetUrl && /^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(info.spreadsheetUrl)) {
        const link = element<HTMLAnchorElement>('queue-sheet'); link.href = info.spreadsheetUrl; link.hidden = false;
      }
      connected = true; status(`Connected. ${info.ready ?? 0} jobs ready. Load a text model, then start.`);
    } catch (error) { client?.close(); client = undefined; status(String(error)); }
    controls();
  });
  const releaseClaim = async (claimId: string) => {
    for (let attempt = 0; ; attempt++) {
      try { return await client!.request('releaseClaim', { claimId }); }
      catch (error) {
        if (!isTransient(error) || attempt === 2) throw error;
        status('Google has not acknowledged release yet. Retrying release…');
        await delay(10000);
        client?.close();
        client = new QueueClient(endpoint, element<HTMLInputElement>('queue-key').value.trim(), worker);
      }
    }
  };
  const upload = async () => {
    const saved = localStorage.getItem(OUTBOX); if (!saved) return;
    const result: Result = JSON.parse(saved);
    if (result.endpoint !== endpoint || result.worker !== worker) throw new Error('Saved result belongs to another queue or worker ID. Restore its connection before starting.');
    let response: Awaited<ReturnType<QueueClient['request']>> | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        response = await client!.request('complete', result);
        break;
      } catch (error) {
        if (!isTransient(error)) throw error;
        if (attempt === 7) break;
        status('Google is busy or disconnected. Saved result retained; retrying upload…');
        await delay(Math.min(30000, 2000 * 2 ** attempt));
        client?.close();
        client = new QueueClient(endpoint, element<HTMLInputElement>('queue-key').value.trim(), worker);
      }
    }
    if (!response || response.stale) {
      // Save a separate copy before releasing; late results may not overwrite a new owner.
      localStorage.setItem(`magic-laborer.retained.${result.lease}`, saved);
      localStorage.setItem(RETAINED, saved);
      status('Repeated upload errors. Result backed up; releasing the job for another attempt…');
      const released = await releaseClaim(result.lease);
      if (!released.ok) throw new Error('Release not acknowledged. Saved result and claim retained for retry.');
      localStorage.removeItem(OUTBOX);
      localStorage.removeItem(CLAIM);
      return;
    }
    if (!response.ok) throw new Error('Google did not acknowledge the result.');
    localStorage.removeItem(OUTBOX);
  };
  element('queue-download').addEventListener('click', () => {
    const result = localStorage.getItem(OUTBOX) || localStorage.getItem(RETAINED);
    if (!result) { status('No pending result to download.'); return; }
    const url = URL.createObjectURL(new Blob([result], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'laborer-pending-result.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  element('queue-discard').addEventListener('click', () => {
    if (active || !localStorage.getItem(OUTBOX)) return;
    if (confirm('Remove the saved result? Download it first if you need to keep it.')) { localStorage.removeItem(OUTBOX); status('Pending result removed.'); }
  });
  element('queue-pause').addEventListener('click', () => { pauseRequested = true; status('Pausing after the current job and upload…'); controls(); });
  element('queue-start').addEventListener('click', async () => {
    if (active || !client || !connected) return;
    if (!temperature.reportValidity()) { status('Enter a job temperature from 0 to 2 or leave it blank.'); return; }
    const temperatureOverride = temperature.value === '' ? undefined : temperature.valueAsNumber;
    if (!host.available()) { status('Load a text model before starting the worker.'); return; }
    let acquire: (() => void) | undefined;
    if (!navigator.locks) { status('This browser needs Web Locks to prevent duplicate workers. Use a current browser.'); return; }
    const lockReady = new Promise<boolean>(resolve => {
      void navigator.locks.request('magic-laborer-worker', { ifAvailable: true }, async lock => {
        if (!lock) { resolve(false); return; }
        resolve(true); await new Promise<void>(release => { acquire = release; });
      });
    });
    if (!await lockReady) { status('Another laborer tab is already running on this device.'); return; }
    if (!host.available()) { acquire?.(); status('Wait for the current operation to finish.'); return; }
    singleTabLock = acquire;
    active = true; pauseRequested = false; host.lock(true); controls();
    try {
      try { wake = await navigator.wakeLock?.request('screen'); } catch { /* Background work is still possible, but not guaranteed. */ }
      await upload();
      while (!pauseRequested) {
        if (!navigator.onLine) { status('Offline. Waiting to reach Google…'); await delay(5000); continue; }
        status('Checking for a job…');
        const previousClaim = localStorage.getItem(CLAIM);
        let claimId = crypto.randomUUID();
        let releasing = false;
        if (previousClaim) {
          const saved = JSON.parse(previousClaim);
          if (saved.endpoint !== endpoint || saved.worker !== worker) throw new Error('Unresolved claim belongs to another queue or worker.');
          claimId = saved.claimId;
          releasing = saved.releasing === true;
        }
        localStorage.setItem(CLAIM, JSON.stringify({ endpoint, worker, claimId, releasing }));
        let reply: Awaited<ReturnType<QueueClient['request']>> | undefined;
        for (let attempt = 0; !releasing && attempt < 3; attempt++) {
          try { reply = await client.request('claim', { claimId }); break; }
          catch (error) {
            if (!isTransient(error)) throw error;
            status('Queue request interrupted. Retrying the same claim…');
            await delay(10000);
            client.close();
            client = new QueueClient(endpoint, element<HTMLInputElement>('queue-key').value.trim(), worker);
          }
        }
        if (!reply) {
          status('Repeated queue errors. Releasing this claim before retrying…');
          // Keep release intent across reloads and lost acknowledgements.
          localStorage.setItem(CLAIM, JSON.stringify({ endpoint, worker, claimId, releasing: true }));
          const released = await releaseClaim(claimId);
          if (!released.ok) throw new Error('Claim release was not acknowledged.');
          localStorage.removeItem(CLAIM);
          await delay(10000);
          continue;
        }
        const job = reply.job;
        if (!job) { localStorage.removeItem(CLAIM); status('Queue empty. Checking again in 15 seconds.'); await delay(15000); continue; }
        element('queue-job').textContent = `${job.id}: ${job.instructions}`;
        element('queue-output').textContent = '';
        status(`Working on ${job.id} locally…`);
        let heartbeatBusy = false, lostLease = false;
        const heartbeat = window.setInterval(() => {
          if (heartbeatBusy) return; heartbeatBusy = true;
          void client!.request('heartbeat', { jobId: job.id, lease: job.lease }).then(r => { if (r.stale) lostLease = true; }).catch(() => { status('Connection interrupted. Working locally; result will be saved before upload.'); }).finally(() => { heartbeatBusy = false; });
        }, 60000);
        let output = '', error = '', finishReason = '', model = '', resultStatus = 'Done';
        try {
          const result = await host.generate(job, text => { output += text; element('queue-output').textContent = output; }, temperatureOverride);
          finishReason = result.finishReason || ''; model = result.model;
          if (!output.trim() || finishReason !== 'stop') { resultStatus = 'Needs review'; error = 'Empty, interrupted or truncated output.'; }
          if (job.format.toLowerCase() === 'json') {
            try { JSON.parse(output); } catch { resultStatus = 'Needs review'; error = 'Output is not valid JSON.'; }
          }
          if (lostLease) { resultStatus = 'Needs review'; error = 'The job lease was lost during generation.'; }
        } catch (failure) { resultStatus = 'Error'; error = String(failure); pauseRequested = true; }
        finally { clearInterval(heartbeat); }
        const result: Result = { jobId: job.id, lease: job.lease, status: resultStatus, result: output, model, finishReason, error, endpoint, worker };
        // Refuse to claim another job unless durable saving and upload both succeed.
        localStorage.setItem(OUTBOX, JSON.stringify(result));
        status(`Uploading ${job.id}…`); await upload();
        localStorage.removeItem(CLAIM);
        status(`${job.id}: ${resultStatus}. ${error}`);
        if (resultStatus === 'Error') break;
      }
    } catch (error) { status(`Worker paused: ${String(error)} Pending results are retained on this device.`); }
    finally { active = false; await wake?.release().catch(() => {}); wake = undefined; host.lock(false); singleTabLock?.(); singleTabLock = undefined; controls(); }
  });
  return {
    async recipeLog(action: 'recipeSave' | 'recipeFinish', fields: Record<string, unknown>) {
      if (!connected || !client) throw new Error('Connect the Google queue before running the recipe test.');
      return client.request(action, fields);
    },
    async checkRecipeLog() {
      if (!connected || !client) throw new Error('Connect the Google queue before running the recipe test.');
      const result = await client.request('recipeCheck');
      if (!result.ok) throw new Error('The Google queue bridge needs the recipe logging update.');
    },
  };
}
const delay = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

const isTransient = (error: unknown) => /timed out|lock timeout|holding the lock|did not connect|disconnected|network|failed to fetch/i.test(String(error));
