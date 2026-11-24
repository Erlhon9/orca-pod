# Security and data handling

## Execution boundary

Pod is an Orca **trusted-worker** plugin. Its Node worker runs with the operating-system user's access, reads local session transcripts, starts installed agent CLIs, and invokes Orca commands. Manifest capabilities describe the Orca APIs it uses; they do not sandbox Node, the filesystem, or child processes. Only install Pod from a source you trust.

The panel requests workspace and topic changes, session launches, terminal reads, and other actions through that worker. AI tool restrictions described below apply to embedded Control, not to every action available in Pod.

## Embedded Control

Both embedded adapters give the model these worker-owned tools:

| Tool | Data or action |
| --- | --- |
| `pod_sessions` | Current supported agent sessions, exact keys, state, and recent reply excerpts |
| `pod_read_session` | One terminal screen, or a chat's latest request and reply |
| `pod_send_session` | One message to one supported agent terminal |

The worker rejects unknown fields, unknown or duplicate session keys, completed sessions, shell targets, malformed terminal handles, and empty or oversized messages. It resolves the target against a fresh Orca snapshot before executing a CLI argument array, without a shell. Chat sessions are read-only for embedded Control; use their native Orca chat to continue.

- **Claude Code:** version 2.1.325 or later is required. Pod uses restricted mode, `dontAsk`, an empty built-in tool list, disabled slash commands, strict MCP configuration, and empty user/project/local setting sources. It explicitly disables bypass permission mode. It does not install a command hook or grant Bash, file tools, or Claude messaging tools. Managed policies still apply.
- **Codex:** Pod disables shell, execution, editing, subagents, web search, apps, plugins, and configured external MCP servers for its Control thread. The thread uses a read-only sandbox, never requests approval escalation, and exposes the three dynamic tools above.
- Both adapters start in Pod's private temporary Control directory instead of a repository. Provider switching carries recent visible conversation context, without requesting a response from the previous provider. Old Claude sessions from a repository are replaced with a new restricted session while preserving visible context.

Claude connects to a short-lived worker-owned MCP HTTP listener bound to `127.0.0.1` on a random port. It requires a random bearer token, the expected Host, and a negotiated session ID; requests containing Origin are rejected. Configuration files are atomically replaced with user-only permissions (directory 0700, files 0600), and directory symlinks are rejected. There is no browser CORS access, remote bind, arbitrary command endpoint, or system service installation. Payload and response sizes and the number of sessions/requests are bounded.

Repeated tool requests with the same JSON-RPC ID and parameters within one MCP session reuse the first result, including failures. Changing the parameters for a used ID is rejected. This is not an exactly-once delivery guarantee across new IDs, processes, or sessions. Stopping Control revokes its sessions; switching providers or unloading closes the listener. Pending operations recheck their active lifetime after asynchronous target lookup. An Orca command that was already submitted cannot be recalled.

## Other Control agents and receiving sessions

Other catalog agents run in a native Orca terminal with their existing installation, login, and permission settings. Pod supplies a coordination prompt and session map and does not add permission-bypass flags. **That prompt is guidance, not an enforced sandbox.** Those agents may have their normal filesystem, command, network, and messaging access. Review approvals in Orca.

A receiving agent acts with **its own session permissions**. Restricting the Control agent does not restrict what a recipient can do. Session titles, prompts, replies, and tool results may contain untrusted instructions; the embedded prompt tells Control to treat them as data, but prompt injection remains a risk when coordinating agents. Check the selected targets and message before sending. An accepted or queued receipt is not evidence that a task finished. Uncertain deliveries are not automatically retried by Pod.

## Data flows and retention

Pod has no separate telemetry service or hosted AI backend. AI requests use your installed CLI and provider account, subject to that provider's processing and retention policies.

- Displaying Pod reads local workspace/agent metadata, terminal output, and local Claude transcripts. Control can pass session names, paths in context, recent requests/replies, selected terminal output, messages, and attached images to the selected provider. Topic proposals pass repository workspace metadata and bounded session excerpts to the selected embedded Claude or Codex provider.
- For local native Claude chats, Pod also opens Orca's session journal in read-only mode to look up that session's current provider identifier and confirmed context-clear boundary. It does not change the journal or query its conversation bodies. This compatibility lookup depends on Orca's internal schema; when unavailable, it cannot confirm a new clear and retains the last known context.
- Selecting a different Control agent shares recent visible conversation text with that provider on the next request. Image originals are not included in the handoff summary.
- Dated work history uses `pod.progress.v1` and immutable page keys in Orca's own storage. It retains observed changes, up to 1,600 characters of recent reply/note evidence per event, historical workspace/topic/session references, user-confirmed progress classifications and withdrawals. The first snapshot is a baseline; this is not a complete transcript or an exact replay. Collection gaps are retained. There is no automatic history pruning; removing Pod storage through Orca removes these records too. Withdrawing progress affects classification, not erasure of the original evidence.
- Work priorities use `pod.work-priorities.v1` in own storage. The worker validates the exact current workspace and P0/P1/P2 value, serializes writes, and binds overrides to the workspace branch. P0 is user-designated; automatic labels are observation-based routing hints and grant no execution or approval authority. Historical browsing does not display or edit current priorities.
- Pages are stored before their root reference is committed. Failed root writes do not expose new records or collection cursors. Priority writes are validated against current workspace IDs and P0/P1/P2 values. Old XP fields remain readable for compatibility but are not returned or accumulated. User confirmation classifies the local record and does not change workspace status, approve a tool or send a session instruction. Historical browsing disables work actions until explicit return to current work.
- Control can receive up to eight recent recorded changes within its exact target workspace IDs and prompt budget. Agent claims, observed check results, user confirmations and withdrawals remain distinguishable. This history is untrusted data, not executable instructions. Existing global requests retain their global scope.
- Pod saves preferences, session identifiers, recent Control conversation, and handoff text in its own Orca storage. Agent CLIs may also retain their own local conversation history.
- Selecting a card or session does not invoke a model. Prepare briefing explicitly uses the selected embedded Claude or Codex provider to read available session records. During this request, the worker rejects the session-send tool. Native terminal providers do not offer this read-only action.
- Periodic/change briefings are initially off and can be enabled in Briefing settings. While the panel is visible, its existing polling loop checks the configured interval and substantive changes; it does not install an OS scheduler or run after the panel closes. Automatic requests defer while Control is busy or a draft is being composed. Brief me now also works with automatic checks off. These requests use the selected embedded provider, explicitly disable session sends, and restrict read tools to the server-validated repository/topic scope. Generic waiting alone is not a new question; approval states remain observed signals rather than verified business decisions. Failed attempts back off, unchanged input is skipped, and the last successful briefing is retained.
- `pod.control-watch.v1` stores settings, configuration time, up to 100 scope checkpoints, and the latest 12 completed overview briefings with source fingerprints, scope labels, and workspace IDs. Checkpoints advance to a completed briefing only after its storage succeeds. Incomplete/failed calls do not replace the last good result, and provider conversation reset does not erase these briefings. These overviews use available metadata, human notes and bounded recent excerpts; they do not implement a full structured decision or promise history.
- Organize topics also rejects session-send tools. Its JSON proposal is saved separately from provider history and cannot change topics by itself. Applying requires an explicit panel action, a fresh matching repository fingerprint, complete in-repository assignments, and a valid two-level tree. Completed and archived assignments are retained. Invalid or stale proposals are rejected before storage is changed.
- Pod stores request scope and display labels, the latest 80 Control request records, and the last completed briefing per target in its own storage. Scope is rebuilt from fresh workspace IDs before submission, and response items carry an immutable request ID. Briefings remain available when the provider conversation is reset or older request records are pruned. Failed or interrupted requests do not replace the last completed briefing. Failed initial scope persistence prevents the model request from starting.
- Previously entered work objectives, completion criteria, next moves, notes, and explicit review fingerprints remain in Pod storage. These are separate from generated briefings. Removing a provider conversation does not erase Pod's stored briefings; remove Pod's storage through Orca to remove this data. Review marks do not approve agent requests or change workspace status.
- Native terminal agents read a local session map. Control settings and that map live under the operating-system temporary directory in `pod-control`; temporary attachment files live in `pod-attachments`. Attachment cleanup is attempted on plugin activation for files older than two days, not on a guaranteed timer. The operating system may remove temporary files earlier.
- Embedded images are sent as image content; native terminal Control receives local image paths. Do not attach secrets unless you intend the selected agent/provider to process them.

Remove the local plugin registration and its storage through Orca to stop using Pod; manage provider history using each CLI's own controls. Revoked bridge credentials left in a temporary config cannot authorize a listener that has closed.

## Verification and public assets

Automated security tests cover transport authentication, Host/Origin checks, restricted tool exposure, exact-target validation, duplicate requests, uncertain failures, cancellation, private file permissions, and payload limits. Tests use mock targets and do not instruct live sessions. Run the full Orca plugin tests and type checks locally in addition to CI's security tests and bundle checks.

Public screenshots use fictional fixtures rather than live workspace data. The release process verifies recorded screenshot hashes and scans published text for private project details. These checks complement visual review and are not a guarantee that arbitrary content is safe to publish.

## Reporting

Do not put credentials, private transcripts, or exploitable details in public issues. Open a minimal issue at the [Pod repository](https://github.com/Erlhon9/orca-pod/issues) asking for a private reporting channel before sharing sensitive evidence.
