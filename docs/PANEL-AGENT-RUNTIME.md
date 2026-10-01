# Panel Agent runtime - 2.6.0-cloudssh.57

This iteration starts from `.55`. It does not restore the large `.56` conversation-management toolbar or change the human terminal, login system, Docker data mounts, or root keys.

## Everyday use

Open a saved SSH host, select it in the existing Agent context selector, and chat as before. The model selector, input box, new-chat/history/settings buttons retain the existing layout. One small **Agent task options** (`...`) button opens secondary controls. Tool results are folded by default; expand a result to inspect its command, status, exit code and output. Log pages are loaded only on request.

The Agent no longer types generated commands into the human terminal. It uses a dedicated non-PTY SSH `exec` connection with explicit `cwd`, stdout, stderr and a real exit status. A `running` job is not a successful command. The model can poll a background job using `read_job_output`, or request cancellation using `cancel_job`. Each job starts in the remote login directory unless `cwd` is specified; `cd` and `export` do not persist across jobs. Interactive editors, password prompts and shell-only network appliances may not work with non-interactive exec. Unsupported authentication or a missing verified host key fails explicitly; the runtime does not bypass verification.

Unknown or mutating commands require approval in a temporary in-chat card. This is a conservative convenience policy, not a shell sandbox or a guarantee that every apparently read-only command is harmless. The card shows the target, command and working directory. Rejecting a command does not execute it. Historical messages and model text are never interpreted as executable commands.

## Execution and recovery

The backend owns the model/tool loop. Closing the Agent panel, refreshing the page or losing a browser connection only detaches the view. The browser reconnects to the existing run using an acknowledgement ID and incremental status polling. New chat does not automatically cancel the previous run; active-task navigation asks for confirmation. The existing history button can reopen backend records.

User messages and tool intents are saved before a model/tool phase. Stable request IDs handle lost HTTP acknowledgements without creating duplicate tasks. Tool intents use runtime-generated IDs rather than trusting reused provider IDs. Log reads and task mutation APIs check ownership; host execution and log reads also recheck current host access. Background work is tied to the original authenticated login session and pauses on session expiry, revocation or disabled Agent settings.

A backend restart is different from a browser refresh. In-flight jobs are marked interrupted and unknown outcomes are recorded; they are not silently re-executed. Resume is explicit. Stopping sends a termination request and closes only Agent-owned resources. Some SSH servers ignore process signals, and detached remote descendants may continue. Cancellation cannot undo mutations or prove that an unknown command never ran. Inspect remote state before repeating such operations.

Restarting the remote server, SSH/network services, or the CloudSSH deployment itself can still disconnect a human terminal. Independent execution prevents raw tool output and shell input from being injected into xterm; it cannot make those external operations non-disruptive.

## Context instead of a fixed tool-round cap

The model transport uses the official OpenAI Node SDK with the standard Chat Completions function-tool schema. Existing compatible endpoint, key, model and reasoning settings are reused. There is no separate MCP protocol or proprietary model API. Backend task persistence, authorization and SSH execution remain application responsibilities.

There is **no fixed total tool-round limit** in the new loop. The legacy `toolRoundLimit` setting does not stop runtime-backed tasks. A watchdog pauses repeated identical command/results or short repeating cycles with no new evidence. Polling an actually running job does not trip that detector. Model calls are paced to avoid a tight request loop. Users can stop or explicitly continue a paused task.

Old complete message/tool exchanges are summarized automatically before the model input budget is exhausted. The current user task, host identities and recent job states are retained separately. A summary must be nonempty, bounded and based on a monotonically advancing history range before it is committed. Original messages remain in storage. Summary calls have no execution tools. Summaries can omit details or be inaccurate and consume model usage; they are not a replacement for original logs and current observation.

Set **Agent model context window (tokens)** in the existing administrator model settings to the actual limit exposed by the provider. The conservative default is 32768, not a claim that every model supports exactly that window. For per-model limits, set `PANEL_AGENT_MODEL_CONTEXT_WINDOWS` to a JSON object mapping exact model IDs to token limits. Known compatible OpenAI token families use `js-tiktoken`; unknown/custom model IDs use a conservative byte-based estimate. Image costs are estimated. Providers can count input differently; context-length rejection causes a smaller budget and compaction, not dropped tools or silent execution fallback.

Model evidence is budgeted separately from raw tool output. The runtime reserves space for system instructions, summary, recent messages and the answer; stdout/stderr excerpts use the remaining budget. Responses retain job IDs and paging information where space allows. Log paging is not a total log-size limit.

## Physical resource protection

No finite server can accept unlimited output. Raw stdout/stderr are streamed into separate files with backpressure, not accumulated in React or an unbounded memory string. Defaults:

| Setting | Default | Purpose |
| --- | --- | --- |
| `PANEL_AGENT_CONCURRENT_RUNS` | 8 | Concurrent backend execution capacity, not total conversation rounds |
| `PANEL_AGENT_COMMAND_TIMEOUT_MS` | 600000 | Default job deadline; a requested per-job deadline can be up to 24 hours |
| `PANEL_AGENT_OUTPUT_DIR` | under the existing application data directory | Raw job logs |

The implementation also stops output capture at its per-job/global disk safety budgets (512 MiB / 4 GiB defaults), bounds pending output writes and pauses runs under high heap pressure. These are operational safety measures, not model context limits and not automatic chat eviction. A stopped output capture or unknown exit status is reported explicitly. Large deployments should monitor disk, memory and backup size rather than raising these safeguards blindly.

## Data and migration

New runtime threads, messages and job metadata use the existing application SQLite database and its existing save/encryption mechanism. Raw output files are private filesystem files (directory mode 0700, files 0600), **not encrypted by the SQLite encryption feature**. They can contain sensitive terminal output. Back up and protect both the existing database/root keys and the runtime output directory. Do not replace or remove existing mounts during upgrade.

Legacy browser records remain untouched. They appear inside the existing history panel. Selecting one previews it; continuing requires explicit confirmation before storing a textual historical copy under the currently authenticated account. Imported tools are reference text, never pending executable calls. Content already trimmed or lost by older browser-only versions cannot be reconstructed.

Deleting a finished thread removes its database records and associated output files; existing offline backups are not erased. An active run must be stopped before deletion. Account deletion cascades database ownership records; orphaned private output files may require administrator cleanup. Filesystem output is not an immutable audit trail. Process crashes between command execution and persistence still require uncertainty-aware recovery.

## Validation boundaries

Tests cover acknowledgement replay, owner/host/session checks, explicit approvals, cancellation races, more than 20 progressing tool calls, repeating-cycle detection, non-destructive compaction, dynamic evidence budgets, independent SSH stdout/stderr, larger-than-2-MiB output paging, and browser detachment. SSH execution tests use controlled local fakes, not the user's production hosts.

The repository has pre-existing full frontend TypeScript diagnostics. The runtime pipeline runs the real backend type check and a baseline comparison for the full frontend, rejecting new diagnostics and any diagnostics in Agent integration files. This is not a claim that all old frontend type errors are fixed. Production build and the entire test suite remain required before promotion.
