# Magic Laborer Box

A separate copy of [MagicTalkingBox](https://github.com/alexhspitzer-alt/MagicTalkingBox), based on commit `d350801f202b7df363c85c1848fd09ff0814ff91`. It keeps local chat, image models and offline model caching, and adds a text worker for a Google Sheets job queue. The original app is unchanged.

## Quick plan

See [PLAN.md](PLAN.md). Cloud supervision happens through Google Sheets tools in a conversation; browser workers process small rows independently. This version has no cloud API billing or unattended supervisor.

## Google setup

1. Create a Google Apps Script project, either standalone or bound to the queue Sheet.
2. Paste `google/Code.gs` into `Code.gs`. Add an HTML file named `Bridge` with `google/Bridge.html`. Enable the manifest file in Project Settings and use `google/appsscript.json` to limit requested access to Google Sheets.
3. In **Project Settings → Script Properties**, set `SPREADSHEET_ID` to your private queue ID, `ALLOWED_ORIGIN` to `https://alexhspitzer-alt.github.io`, and `WORKER_TOKEN` to a long random private key. Keep the `Jobs` headers unchanged. Do not publish these private settings.
4. Deploy as a **Web app**, execute as **Me**, access **Anyone**. The bridge page is reachable anonymously, but every queue operation requires the private worker key. The Sheet itself stays private.
5. Enter the deployed web app URL and worker key in the app. Use a unique worker ID on each device. The app remembers its endpoint and ID, but keeps the key only in memory.
6. Connect, select and load a text model, then **Start worker**. **Pause after job** finishes the current generation and uploads its answer before pausing.

If hosted somewhere other than `https://alexhspitzer-alt.github.io`, change `ALLOWED_ORIGIN` in Script Properties. Update the web app deployment after script code changes. Local development requires explicitly changing the allowed origin to the development server's origin.

The bridge uses a hidden HtmlService iframe and `google.script.run`, avoiding cross-origin fetch/CORS assumptions. Messages carry a random per-connection channel; both sides verify origins. Google authentication is used to deploy/authorize the script, not embedded in the static app. The worker key grants claim/heartbeat/completion access to this queue; it does not grant arbitrary spreadsheet editing.

## Queue columns

Keep the `Jobs` tab and these headers in their exact order:

| Column | Field | Purpose |
| --- | --- | --- |
| A | Job ID | Unique, stable, nonblank identifier |
| B | Status | `Ready`, `Working`, `Done`, `Needs review`, `Error`, or `Accepted` |
| C | Instructions | A narrow task the small model can follow |
| D | Input | Text data for this job |
| E | Output format | `json` for strict JSON parsing; otherwise text or a described format |
| F | Max output tokens | Integer 1–2048; also capped by the selected model |
| G | Result | Worker output |
| H | Worker | Claiming device ID |
| I | Lease until | ISO timestamp, renewed once a minute |
| J | Lease token | Random claim identity |
| K | Attempts | Claim count; limited to 3 |
| L | Model | Actual selected model ID |
| M | Finish reason | Model's generation finish reason |
| N | Updated | ISO timestamp |
| O | Error | Generation/format/context failure |
| P | Review | Supervisor notes |

To add work, append rows with A–F filled and B = `Ready`. Worker prompts are exactly the instruction, a blank line, and the input. There is no system message or added section heading; the format column controls validation only. Model input includes only the current row's instruction and data; it never includes chat history or other jobs. Keep batches small. A conservative UTF-8 byte check protects context headroom; non-English data may require smaller chunks. Split a too-large job across rows.

A completed model response is `Done` only if nonempty and normally terminated; JSON jobs must also parse. This is a format check, not a correctness judgment. The cloud supervisor reviews outputs and may mark them `Accepted`, put notes in P, or set B back to `Ready` after revising instructions. Reset K deliberately if retrying past the three-attempt limit. Do not edit, sort, or reset active `Working` rows; pause workers first. Workers coordinate with each other using a script lock, but manual and connector edits do not use that lock.

## Recovery

Claims expire after 15 minutes without a heartbeat. Another worker can then reclaim the job. The old claim cannot overwrite the new one. Completed answers are saved to browser storage before upload, and retried before claiming another job. Upload acknowledgement is idempotent, including when Google's first response was lost.

If a tab closes during generation, incomplete output is not checkpointed: the expired job restarts. If it closes after the answer was saved, reconnect to the same endpoint/worker ID and start to retry submission. A stale saved answer is retained for downloading and supervisor review. Use **Download pending result**, then **Remove pending result** to clear it when appropriate. Storage-full errors pause the worker; the visible output can be copied. Clearing browser data removes saved results and cached models.

Only one worker tab runs per browser origin through Web Locks. Separate devices can run concurrently. Keep the tab visible; background throttling, sleeping devices and browser eviction can interrupt work. Google connectivity is needed to claim and upload; inference itself remains local.

Worker input is untrusted data: the model has no browser tools, and its response is displayed as text and written as literal cell text. It cannot execute commands. Results beginning with formula characters are escaped before writing to Sheets.

## Build and deploy

```sh
npm ci
npm run test:queue
npm run build
```

The copied GitHub Actions workflow runs only the build and queue tests, then deploys to GitHub Pages when Pages is configured with **GitHub Actions** as its source. No models are downloaded for validation. The app cache name and chat/selection storage keys are separate from MagicTalkingBox; shared model caches remain reusable on the same browser origin.

Essential checks cover authentication, exclusive claims, lease recovery, stale-worker rejection, idempotent completion, attempt limits, duplicate IDs, and literal spreadsheet output. An actual deployed Google bridge handshake must be checked once after deployment; local mocks do not establish Google's iframe behavior.

## Queue connection

Connect your private queue through the app’s worker panel. No private spreadsheet IDs or worker keys are published in this repository.

Version 0.2 simplifies worker prompts and checks for app updates while preserving offline fallback and existing model caches.
