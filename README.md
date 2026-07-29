# Claude Code Routines Manager

A small Electron app for managing Claude Code automation in both places it lives:

- **Local scheduled tasks** — run by the Claude desktop app on this machine.
  Registry: `%APPDATA%\Claude\claude-code-sessions\<account>\<org>\scheduled-tasks.json`;
  prompts: `~\.claude\scheduled-tasks\<id>\SKILL.md`.
- **Cloud routines** — CCR triggers run in Anthropic's cloud
  (`https://api.anthropic.com/v1/code/triggers`, shown at <https://claude.ai/code/routines>).

Two panes, enable/disable toggles, in-place editing (prompt / cron / name / model / cwd),
orphaned-prompt import, cloud "Run now", and **Move** in either direction
(move = create on the target side, then disable the source — cloud routines cannot be
deleted via the API, only disabled).

## Run

```bash
npm install
npm start
```

Tests (pure Node, no Electron):

```bash
npm test
```

## How it works / sharp edges

- **Local writes are gated.** The Claude desktop app loads the registry only at startup
  and rewrites it wholesale, so this app refuses registry writes while the desktop app is
  running (path-based process check — CLI sessions named `claude.exe` do not trip it).
  Even after a successful write, **changes take effect only after Claude Desktop restarts**.
  Prompt (SKILL.md) edits are not gated; the desktop reads those at fire time.
- Before the first registry mutation of a session, a timestamped `.bak-…` copy is made
  next to the registry. All writes are atomic (temp file + rename).
- **Cloud auth** reuses the Claude Code CLI's OAuth tokens from
  `~\.claude\.credentials.json`, refreshing (and atomically writing back the rotated
  tokens) when expired. If refresh fails, run any `claude` command to log in again.
- **Cron timezones**: local task crons are machine-local time; cloud crons are UTC with a
  1-hour minimum interval. Move dialogs shift the hours automatically where that is
  well-defined and show the next three occurrences on both sides so you can eyeball it;
  otherwise they ask for a manually entered target cron. The shift uses today's UTC
  offset — a fixed UTC cron inherently drifts one wall-clock hour across DST transitions.
- MCP connections and notification settings on cloud routines are **not** carried over by
  a move; the result dialog and warnings say so.

## Manual end-to-end verification

Run with Claude Desktop **closed** unless a step says otherwise.

1. `npm test` green; `npm start` shows the app.
2. **Read-only**: the local pane lists the registry tasks with correct enabled states and
   the orphaned prompts; the cloud pane count matches <https://claude.ai/code/routines>;
   opening drawers shows prompts matching SKILL.md / claude.ai; next-run times look sane.
3. **Auth rotation**: with an expired access token, the first cloud load refreshes it.
   Afterwards run `claude -p "hi"` in a terminal — the CLI must still work (proves the
   write-back preserved `mcpOAuth` and stored valid rotated tokens).
4. **Gate**: launch Claude Desktop → header chip flips to "running" (open CLI sessions
   alone must NOT trip it); a local toggle is blocked with the amber banner and the
   registry file's mtime is unchanged. Close Desktop → Re-check → toggle a task off and
   on; an external diff shows only `enabled` changed and a `.bak-*` file exists. Relaunch
   Desktop → all tasks still listed (our write format was accepted).
5. **Round trip**: register an orphan as a disabled local task (cron `0 7 * * 1-5`).
   Move it to Cloud disabled (expect `0 12 * * 1-5` UTC during CDT; verify at claude.ai,
   prompt intact). Move it back to Local → id gets a `-2` suffix, cron restored, SKILL.md
   body identical, per-step results accurate.
6. **One-shot probe**: register a disabled one-shot (`fireAt` tomorrow), restart Claude
   Desktop, confirm the task survives in its UI (validates the ISO `fireAt` format; if it
   is dropped, switch `registryEntry` to epoch ms and re-run).
7. **Failure paths**: refresh while offline → NETWORK banner/toast; a failed cloud toggle
   leaves the switch state unchanged.
8. **Cleanup**: delete test routines at <https://claude.ai/code/routines> (there is no
   DELETE API); remove test registry entries by hand with Desktop closed.
