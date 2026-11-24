# Changelog

## 0.5.0

Control is now the main place to understand, prioritize, and continue work across sessions. The map stays available for navigation, with dated work history stored independently of provider conversations.

### Control and continuity

- Select a workspace or session to prepare its context in Control. Preserve target-specific text and attachment drafts, request labels, and source navigation across selection changes.
- Add on-demand overviews, configurable periodic briefings, and important-change notices for embedded Claude and Codex. Choose all projects or the current scope. Skip unchanged input, defer while composing or busy, and back off failed requests.
- Store completed overviews and per-target briefings separately from provider history. Failed or interrupted requests retain the last good result; resetting or switching providers preserves Pod's records.
- Choose a fixed Bottom, Right, or Left Control position, or opt into Auto. Preserve placement through resizing, folding, and view changes; provide full reading and restore controls.
- Simplify header actions, move New conversation into the Control menu, and remove the how-to screen and instructional empty states.

### Priorities and work history

- Add P0/P1/P2 badges to workspace cards, board rows, and Control, with a shared priority filter and a visible reason.
- Persist user overrides and support returning to automatic classification. P0 is user-designated; automatic P1 reflects real questions, blocked sessions, or failed PR checks without an active session. Ordinary waiting is P2.
- Record observed replies, questions, notes, workspace states, and PR changes in dated history. Group the day by workspace, inspect evidence, classify records, and explicitly return to the current workspace to continue.
- Preserve historical names, topics, and session references. Mark pre-collection dates and collection gaps; disable current-work actions while browsing history.
- Store immutable history pages and publish their references with a committed collection cursor. Preserve the last good record state on failure and retain history independently of recent briefing/request limits.
- Give Control bounded, target-scoped recent history as source data. Keep agent claims, observed check results, user confirmations, and withdrawals distinct.

### Navigation and layout

- Browse by repository or complete topic path across repositories, and narrow by subtopic consistently in Graph, Board, and Agent views.
- Let the selected embedded Control agent propose a repository's topics and assignments. Review before applying; reject stale proposals and preserve completed work classifications.
- Keep Auto arrange visible and usable in current and historical views. Arrange history independently without overwriting current manual positions; separate topic branches using their actual bounds and preserve stable placement across metadata updates.
- Place date navigation above the map, separate from the docked Control panel.
- Keep cards readable in narrow panels with explicit overview and reading modes. Reveal collapsed groups when navigating to work needing attention.
- Use subtle topic zones and standard provider icons. Keep Context, source windows, zoom controls, and scrolling usable in constrained layouts.

### Reliability and compatibility

- Preserve explicit review checkpoints without treating timestamp-only updates as new work. Reviewing, approval, instruction delivery, and completion remain distinct.
- Track request identity and outcomes across providers; retain target references and drafts through asynchronous updates, failures, and cancellation.
- Preserve existing work notes, preferences, layouts, and provider selection. Older development history containing XP fields remains readable; experience counters, levels, and pixel session characters are not part of this release.
- Extend unit, worker, security, and fictional DOM flow coverage. No new plugin capabilities or background service are introduced.

### Current boundaries

Automatic briefings require activation and a visible Pod panel. History records observations since collection starts and uses bounded excerpts, not complete transcripts or exact historical replay. Structured promise tracking, complete automatic decision extraction, and bot integration remain future work. Native approvals and messages to read-only chat sessions continue in Orca.

## 0.4.9

- Add a persistent Add session button below session conversations and terminal views. Choose Claude, Codex, or a terminal without scrolling back to the tab bar.
- Label the tab-bar action Add session, and prevent duplicate session launches while creation is in progress.

## 0.4.8

- Follow confirmed `/clear` operations in local native Claude chats. Remove previous messages and tool groups from Pod, and show only the new provider conversation when it becomes available.
- Preserve the current view during temporary read failures without restoring pre-clear prompts or cached transcript files.

## 0.4.7

- Drag topic and status group labels to your preferred positions. Remember them across updates, collapsing and reopening groups, and reopening the panel, alongside manually placed workspace cards.
- Keep normal clicks for collapse/expand, suppress hover previews while dragging, and reset saved group positions with Auto layout. Manually placed cards retain their own positions when a group label moves.

## 0.4.6

- Hide hover previews when a graph-card drag starts and prevent pending timers or background updates from reopening them. Resume previews after the pointer moves and enters a card again, including after cancelled drags.

## 0.4.5

- Keep workspace cards where you drop them in the graph, including after background updates and reopening the panel. Remember positions separately for each repository view and topic/status grouping.
- Add Auto layout to restore automatic placement. Moving a card to another group now requires dropping directly on its label; dropping into free space only changes its position.

## 0.4.4

- Add an Answer in Orca button to pending questions in session details and hover previews, including unstructured prompts. Route approval prompts to Orca for review. Terminal sessions open their exact terminal; native chat sessions open their workspace with the currently available public API.

## 0.4.3

- Limit session hover previews to 560 pixels or the visible panel height, whichever is smaller. Scroll long questions inside the preview while keeping the session heading and actions visible.
- Recalculate hover bounds against the visible viewport when an embedded panel resizes.

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
