# Changelog

## 0.4.2

- Show pending questions, choices, descriptions, and multiple-selection guidance directly in session details and hover cards. Preserve structured question inputs from Claude transcripts and clear the pending state when their tool result arrives.
- Show ordinary session hover previews without raw terminal screens. For waiting or approval prompts without structured data, keep the current terminal output as a bounded, wrapped fallback.
- Keep hover cards inside the viewport when asynchronous content changes their height.

## 0.4.1

- Keep an open session conversation mounted when background metadata changes, preserving scroll position, text selection, and expanded tool groups.
- Load conversations immediately after mounting and retain the last successful content during temporary empty reads.
- Update changed chat reply text without resetting the session view, including changes with unchanged timestamps.

## 0.4.0

- Restrict embedded Claude Control to the same three worker-validated session tools as Codex. Remove permission bypass, shell hooks, file tools, and direct Claude chat messaging.
- **Changed:** embedded Control can send to supported agent terminals; chat sessions are read-only. Open a chat in Orca to continue. Claude Code 2.1.325 or later is required.
- Authenticate the local Claude MCP connection, validate exact current targets and tool inputs, reuse duplicate request results, and invalidate pending work when Control stops or changes provider.
- Remove unused plugin permissions and obsolete direct session-input APIs.
- Document permissions, provider data flows, native agent access, and screenshot privacy in English. Public screenshots continue to use fictional data.
- Add reproducible development dependencies, clean type checks, security tests, and CI bundle checks.
