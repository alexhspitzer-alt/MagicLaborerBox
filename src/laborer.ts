import { QueueClient, type Job } from './queue-client';
import { element } from './ui';
const SETTINGS = 'magic-laborer.settings.v1', OUTBOX = 'magic-laborer.outbox.v1';
type Result = { jobId: string; lease: string; status: string; result: string; model: string; finishReason: string; error: string; endpoint: string; worker: string };
type Host = { available: () => boolean; generate: (job: Job, onText: (text: string) => void) => Promise<{ finishReason: string | null; model: string }>; lock: (locked: boolean) => void };
export function installLaborer(host: Host) {
  let client: QueueClient | undefined, active = false, pauseRequested = false, wake: WakeLockSentinel | undefined;
  let endpoint = '', worker = '', connected = false;
  let singleTabLock: (() => void) | undefined;
  const status = (text: string) => { element('queue-status').textContent = text; };
  const controls = () => {
    element<HTMLButtonElement>('queue-connect').disabled = active;
    element<HTMLButtonElement>('queue-start').disabled = active || !connected;
    element<HTMLButtonElement>('queue-pause').disabled = !active;
    for (const id of ['queue-url', 'queue-key', 'queue-worker']) element<HTMLInputElement>(id).disabled = active;
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS) || '{}');
    element<HTMLInputElement>('queue-url').value = saved.endpoint || 'https://script.google.com/macros/s/AKfycbx93cQePRgC3-isSxCseAazz0Q2shopdXaEzGQs5uFyvsLaPGxPrtSzHRr0L42uVKOf/exec';
    element<HTMLInputElement>('queue-worker').value = saved.worker || `box_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    if (localStorage.getItem(OUTBOX)) status('A saved result is waiting. Connect to its queue, then start to retry the upload.');
  } catch { status('Saved queue settings could not be read.'); }
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
      localStorage.setItem(SETTINGS, JSON.stringify({ endpoint, worker }));
      if (info.spreadsheetUrl && /^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(info.spreadsheetUrl)) {
        const link = element<HTMLAnchorElement>('queue-sheet'); link.href = info.spreadsheetUrl; link.hidden = false;
      }
      connected = true; status(`Connected. ${info.ready ?? 0} jobs ready. Load a text model, then start.`);
    } catch (error) { client?.close(); client = undefined; status(String(error)); }
    controls();
  });
  const upload = async () => {
    const saved = localStorage.getItem(OUTBOX); if (!saved) return;
    const result: Result = JSON.parse(saved);
    if (result.endpoint !== endpoint || result.worker !== worker) throw new Error('Saved result belongs to another queue or worker ID. Restore its connection before starting.');
    const response = await client!.request('complete', result);
    if (response.stale) throw new Error('This result’s lease was reassigned. Download the saved result for review; it will not overwrite another worker.');
    if (!response.ok) throw new Error('Google did not acknowledge the result.');
    localStorage.removeItem(OUTBOX);
  };
  element('queue-download').addEventListener('click', () => {
    const result = localStorage.getItem(OUTBOX);
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
    singleTabLock = acquire;
    active = true; pauseRequested = false; host.lock(true); controls();
    try {
      try { wake = await navigator.wakeLock?.request('screen'); } catch { /* Background work is still possible, but not guaranteed. */ }
      await upload();
      while (!pauseRequested) {
        if (!navigator.onLine) { status('Offline. Waiting to reach Google…'); await delay(5000); continue; }
        status('Checking for a job…');
        const reply = await client.request('claim');
        const job = reply.job;
        if (!job) { status('Queue empty. Checking again in 15 seconds.'); await delay(15000); continue; }
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
          const result = await host.generate(job, text => { output += text; element('queue-output').textContent = output; });
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
        status(`${job.id}: ${resultStatus}. ${error}`);
        if (resultStatus === 'Error') break;
      }
    } catch (error) { status(`Worker paused: ${String(error)} Pending results are retained on this device.`); }
    finally { active = false; await wake?.release().catch(() => {}); wake = undefined; host.lock(false); singleTabLock?.(); singleTabLock = undefined; controls(); }
  });
}
const delay = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
