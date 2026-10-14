export type Job = { id: string; instructions: string; input: string; format: string; maxTokens: number; lease: string; leaseUntil: string };
export type Reply = { ok?: boolean; stale?: boolean; job?: Job | null; ready?: number; spreadsheetUrl?: string };
export class QueueClient {
  private frame = document.createElement('iframe');
  private channel = crypto.randomUUID();
  private peer?: Window;
  private origin = '';
  private pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: number }>();
  private listener: (event: MessageEvent) => void;
  private ready: Promise<void>;
  private readyTimer: number;
  private rejectReady!: (error: Error) => void;
  constructor(url: string, private token: string, private worker: string) {
    const endpoint = new URL(url);
    if (endpoint.origin !== 'https://script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(endpoint.pathname)) throw new Error('Use the deployed Apps Script URL ending in /exec.');
    endpoint.search = new URLSearchParams({ origin: location.origin, channel: this.channel }).toString();
    let resolveReady!: () => void;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; this.rejectReady = reject; });
    this.readyTimer = window.setTimeout(() => this.rejectReady(new Error('Google bridge did not connect. Check deployment access and allowed origin.')), 30000);
    this.listener = event => {
      const data = event.data;
      const googleOrigin = /^https:\/\/([\w-]+\.)?script\.googleusercontent\.com$/.test(event.origin);
      if (!googleOrigin || !data || data.channel !== this.channel || !event.source) return;
      if (data.type === 'queue-ready' && !this.peer) {
        this.peer = event.source as Window; this.origin = event.origin; clearTimeout(this.readyTimer); resolveReady(); return;
      }
      if (event.source !== this.peer || event.origin !== this.origin || data.type !== 'queue-response') return;
      const request = this.pending.get(data.id); if (!request) return;
      clearTimeout(request.timer); this.pending.delete(data.id);
      if (data.error) request.reject(new Error(String(data.error))); else request.resolve(data.result);
    };
    window.addEventListener('message', this.listener);
    this.frame.hidden = true; this.frame.title = 'Google queue bridge'; this.frame.src = endpoint.href; document.body.append(this.frame);
  }
  async request(action: string, fields: Record<string, unknown> = {}): Promise<Reply> {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error('Google request timed out. Results stay saved for retry.')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.peer!.postMessage({ type: 'queue-request', channel: this.channel, id, request: { ...fields, action, token: this.token, worker: this.worker } }, this.origin);
    });
  }
  close() {
    clearTimeout(this.readyTimer); this.rejectReady(new Error('Disconnected.'));
    window.removeEventListener('message', this.listener); this.frame.remove();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Disconnected.')); }
    this.pending.clear();
  }
}
