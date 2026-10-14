# Magic Laborer Box: first version

1. Copy MagicTalkingBox into its own MagicLaborerBox repository, keeping the working model loaders and offline cache.
2. Use a private Google Sheet as the assignment and results inbox. The cloud supervisor writes small jobs and later reviews results through connected Google Sheets tools.
3. Deploy a bound Google Apps Script bridge. It authenticates workers, claims jobs under a lock, renews leases and accepts results idempotently.
4. Add a worker panel to the static app: connect, start, pause after the current job, inspect output and recover a saved answer.
5. Verify the production build and the queue's essential claim, lease and retry behavior. No live model downloads or inference benchmarks.

The app does not automatically call a cloud model. Supervision initially happens in this conversation. The queue persists independently; the browser worker runs while its tab remains open. Browsers may suspend hidden tabs. It polls an empty queue every 15 seconds; Apps Script usage limits still apply.
