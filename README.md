# Magic Laborer Box

A separate copy of [MagicTalkingBox](https://github.com/alexhspitzer-alt/MagicTalkingBox), based on commit `d350801f202b7df363c85c1848fd09ff0814ff91`. It keeps local chat, image models and offline model caching, and adds a text worker for a Google Sheets job queue. The original app is unchanged.

## Quick plan

See [PLAN.md](PLAN.md). Cloud supervision happens through Google Sheets tools in a conversation; browser workers process small rows independently. This version has no cloud API billing or unattended supervisor.

## Google setup

1. Create a Google Apps Script project, either standalone or bound to the queue Sheet.
2. Paste `google/Code.gs` into `Code.gs`. Add an HTML file named `Bridge` with `google/Bridge.html`. Enable the manifest file in Project Settings and use `google/appsscript.json` to limit requested access to Google Sheets.
3. In **Project Settings → Script Properties**, set `SPREADSHEET_ID` to your private queue ID, `ALLOWED_ORIGIN` to `https://alexhspitzer-alt.github.io`, and `WORKER_TOKEN` to a long random private key. Keep the `Jobs` headers unchanged. Do not publish these private settings.
4. Deploy as a **Web app**, execute as **Me**, access **Anyone**. The bridge page is reachable anonymously, but every queue operation requires the private worker key. The Sheet itself stays private.
5. Enter the deployed web app URL and worker key in the app. Use a unique worker ID on each device. The app remembers its endpoint and ID. After a successful connection, it saves the worker key in an app-scoped cookie for one year and prefills it on future visits.
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
| S | Lease hours (optional) | Positive hours for this job; blank defaults to 24. Fractions allowed: `0.25` = 15 minutes. |

To add work, append rows with A–F filled and B = `Ready`. Worker prompts are exactly the instruction, a blank line, and the input. There is no system message or added section heading; the format column controls validation only. Model input includes only the current row's instruction and data; it never includes chat history or other jobs. Keep batches small. A conservative UTF-8 byte check protects context headroom; non-English data may require smaller chunks. Split a too-large job across rows.

Add a tag such as `[temperature=0.5]` at the start of the Instructions cell to set the job’s temperature. To override it, enter a value from 0 to 2 in **Job temperature override** before starting the worker. The browser remembers this field. Clear it to follow each job’s temperature. The setting applies to the Google queue only.

The model picker groups shorter-context and reduced-memory options under **Low memory**. Start with SmolLM2 360M on a device with GPU float16, or try TinyLlama 1.1B on a device without it. The model details show context and output limits.

A completed model response is `Done` only if nonempty and normally terminated; JSON jobs must also parse. This is a format check, not a correctness judgment. The cloud supervisor reviews outputs and may mark them `Accepted`, put notes in P, or set B back to `Ready` after revising instructions. Reset K deliberately if retrying past the three-attempt limit. Do not edit, sort, or reset active `Working` rows; pause workers first. Workers coordinate with each other using a script lock, but manual and connector edits do not use that lock.

## Recovery

Claims expire after 24 hours without a heartbeat by default. Optional column S, headed `Lease hours`, overrides this per job (for example `0.25`, `1`, or `6`). Each heartbeat renews the lease using that row’s current setting. Invalid values are flagged for review. After updating `google/Code.gs`, publish a new version of the existing Apps Script web app deployment for this duration to take effect. Another worker can then reclaim the job. The old claim cannot overwrite the new one. Completed answers are saved to browser storage before upload, and retried before claiming another job. Upload acknowledgement is idempotent, including when Google's first response was lost.

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

### Recovering interrupted Google requests

Leases still default to 24 hours and honor each row's **Lease hours** override.
The worker persists a unique claim ID before contacting Google. Three failed claim
requests trigger an explicit release; retrying the same claim cannot take another job.
Release is acknowledged and retried, and pending release intent survives reloads.
The bridge records cancellation so a delayed request cannot reclaim a released job.
Only the matching worker and lease can be released; completed or reassigned jobs stay intact.
Network recovery refunds the claim attempt rather than consuming the inference retry limit.

After eight failed result uploads, the worker saves a separate local backup and
releases the job for regeneration. Download pending result retrieves the pending
result or latest recovery backup. All recovery copies remain in local storage under
`magic-laborer.retained.<lease>`. If Google cannot acknowledge release, the worker
pauses with its pending state retained; Start retries it when Google is reachable.
A complete Google outage still requires connectivity before any server claim can be released.

Deploy the updated `google/Code.gs` to the existing Apps Script deployment **before**
refreshing the worker. The new worker checks recovery protocol version 1 during
connection and refuses an older bridge rather than silently leaving claims stranded.
