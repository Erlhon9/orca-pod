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

- Displaying Pod reads local workspace/agent metadata, terminal output, and local Claude transcripts. Control can pass session names, paths in context, recent requests/replies, selected terminal output, messages, and attached images to the selected provider. AI topic suggestions pass workspace metadata to Claude Code.
- Selecting a different Control agent shares recent visible conversation text with that provider on the next request. Image originals are not included in the handoff summary.
- Pod saves preferences, session identifiers, recent Control conversation, and handoff text in its own Orca storage. Agent CLIs may also retain their own local conversation history.
- Native terminal agents read a local session map. Control settings and that map live under the operating-system temporary directory in `pod-control`; temporary attachment files live in `pod-attachments`. Attachment cleanup is attempted on plugin activation for files older than two days, not on a guaranteed timer. The operating system may remove temporary files earlier.
- Embedded images are sent as image content; native terminal Control receives local image paths. Do not attach secrets unless you intend the selected agent/provider to process them.

Remove the local plugin registration and its storage through Orca to stop using Pod; manage provider history using each CLI's own controls. Revoked bridge credentials left in a temporary config cannot authorize a listener that has closed.

## Verification and public assets

Automated security tests cover transport authentication, Host/Origin checks, restricted tool exposure, exact-target validation, duplicate requests, uncertain failures, cancellation, private file permissions, and payload limits. Tests use mock targets and do not instruct live sessions. Run the full Orca plugin tests and type checks locally in addition to CI's security tests and bundle checks.

Public screenshots use fictional fixtures rather than live workspace data. The release process verifies recorded screenshot hashes and scans published text for private project details. These checks complement visual review and are not a guarantee that arbitrary content is safe to publish.

## Reporting

Do not put credentials, private transcripts, or exploitable details in public issues. Open a minimal issue at the [Pod repository](https://github.com/Erlhon9/orca-pod/issues) asking for a private reporting channel before sharing sensitive evidence.
