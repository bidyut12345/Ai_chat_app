# Project memory — read this before every task

This file is the user's persistent instruction log for **RiSriGPT**
(`C:\D_Drive\Ai_chat_app`). It is loaded automatically at the start of every
session. Read it in full before changing code, and **append every new user
request to the log below** (verbatim when possible, with the date and status)
before starting work.

Rules for maintaining this file:

1. Never delete or rewrite old entries. Add new ones at the bottom of the log.
2. Keep the status current: `done`, `in progress`, `waiting`, `reverted`.
3. When the user reverses an earlier request, mark the old entry `superseded`
   and add the new one — do not silently drop history.
4. Standing rules apply to every task even if the user does not repeat them.

---

## Standing rules (always apply)

- **Do not commit** unless the user explicitly asks. Leave work uncommitted.
- Preserve the existing stack: Node/Express + vanilla JS + SQLite, single-page
  app in `public/`, server in `server/`. No framework rewrites.
- Preserve the security model: per-chat tool policy, approvals, admin gates,
  auth. Do not weaken it for convenience.
- Treat unfamiliar files or uncommitted changes as the user's work. Investigate
  before deleting or overwriting anything.
- The user reports bugs tersely. Act on the report; ask only when genuinely
  ambiguous (e.g. the UTC-vs-local timestamp question).
- Verify with real runs: `node --check`, the four suites, and screenshots for
  UI work. Report what was verified and what was not.
- Only the user's port-3000 instance should keep running. Kill review servers
  and delete throwaway databases when done.
- After a server-side change, tell the user the port-3000 instance must be
  **restarted**; static-only changes need just a page reload.

## Project facts

- App: RiSriGPT — local chat UI for any OpenAI-compatible server.
- Run: `PORT=3000 node server/index.js`; data in local SQLite.
- Tests (against a running instance): `APP_URL=http://127.0.0.1:3101 node
  test/e2e.mjs`, `test/builtin-tools.mjs`, `test/auth.mjs`,
  `test/context-compress.mjs`.
- Mock upstream for tests: `node test/mock-openai-server.js 8899`.
- Review recipe: `PORT=31xx DB_PATH=<temp> AUTH_DISABLED=1
  OPENAI_BASE_URL=http://127.0.0.1:889x/v1 OPENAI_MODEL=<mock>
  node server/index.js`.
- Timestamps are stored UTC and displayed in local time, with the exact UTC
  value in the hover tooltip.
- `messages.error` stores why a reply stopped (model/upstream failure) so the
  reason survives reload; user aborts ("Stopped.") are not persisted.

---

## Input log

### 2026-10-29 — new-chat blank area must show the "+" menu
> "previously i told to add all UI element of (+) button popup dialogs in new
> chat main balnk area . it added it but now it is not there."

Status: **done**. The `#plus-menu` DOM node is moved into the blank-chat empty
state and shown inline as cards (MCP tools + server lists, attachments, working
folder, files, approval, file/shell tools, persona, thinking). The `+` button
is hidden while the panel is inline; the same node returns to the composer as a
popup once the chat has messages. Keep this working — do not replace it with a
copy or a second set of controls.

### 2026-10-29 — persistent memory file
> "CREATE a file that remembers all my inputs and tell ai to look into it every
> time."

Status: **done**. This file (`AGENTS.md`) is that memory; it is auto-loaded and
must be appended to on every new request.

### 2026-10-29 — persist the reason a model error stopped the reply
> "on server ai model error, it stops but it does tell the reason of stopping."

Status: **done**. Failures now save an assistant row with `error` set, render
in `.error-box` in the transcript, survive reload, and are excluded from the
prompt sent back to the model. Manual Stop is not persisted.

### 2026-10-29 — empty expanded thinking box
> "sometimes thinking was done and say x number of character, but when expanded
> is empty."

Status: **done**. `sealThinking()` paints the final reasoning synchronously
before folding, so a burst cannot leave the summary counting characters over an
empty body.

### 2026-10-29 — "continue"
Status: **done**. Verification sweep for the thinking fix (light, dark, 390px,
replayed and persisted) plus the full test suite.

### 2026-10-29 — new-chat setup as touch-friendly tabs
> "make new chat main screen ui button like tab buttons touch friendly"

Status: **superseded** by the flat panel below. Tabs were built (four
`role="tab"` buttons, `.setup-hide` filtering, 44 px targets) but the user
rejected the tab UX. Code removed; do not bring tabs back.

### 2026-10-29 — flat, one-click new-chat setup
> "the new chat empty screen, i did not like the UX. Fix the UX so that i not
> need to change tab or select dropdown. everything is right on face and one
> click."

Status: **done**. No tabs and no dropdowns on the blank-chat screen:
- Every setting is on screen at once: `chat-options` (folder, files, approval,
  file tools, shell tools, persona, thinking) plus the MCP toggle and the two
  MCP server cards, in a two-column card grid (`.empty-setup-body` in
  `public/styles.css`), collapsing to one column ≤720 px.
- The two `<select>` rows (persona `#sel-prompt`, thinking `#sel-effort`) are
  mirrored as one-click chips by `choiceChips()` / `renderInlineChoices()`;
  clicking a chip sets the select and fires `change`, so the existing handlers
  still do the work. The selects stay in the DOM (hidden only while inline) as
  the source of truth. Chips are repainted from `renderChatOptions()` and
  `loadPrompts()`.
- The big welcome block (emoji + title) is dropped in this state; one hint line
  stays above the panel.

### 2026-10-29 — keep the "+" button, drop attachments from the blank screen
> "keep (+) button as it is in new chat. Remove the attach images and add
> document part from the new chat main screen."

Status: **done**. `attachInlinePlus()` now moves only `chat-options`,
`pm-mcp-tools`, `pm-mcp-builtin` and `pm-mcp-custom` into the blank area
(`SETUP_INLINE_SECTIONS`). `pm-attach` and `image-url-row` stay in `#plus-menu`
in the composer, and the `+` button is visible and behaves exactly as before —
in a blank chat its popup shows just "Add photos & files" / "Attach image by
URL". `detachInlinePlus()` puts the four sections back in their original order
(`SETUP_MENU_ORDER`) and strips the chips when the chat gets its first message.
Still a single copy of every control: no duplicated markup, no state to sync.

Verified: + visible with the popup above the composer in a blank chat; inline
panel holds exactly the four sections and no attach card; chips switch persona
and thinking effort and the values persist; file/shell toggles persist; after
sending, the full menu is restored in original order with the dropdowns back;
dark, light, 1400 px, 1024 px and 390 px. e2e all checks passed, builtin 56,
auth 38, context 34.

### 2026-10-29 — per-server MCP switches

> "under MCP tools toggle, list each mcp tools group and allow to enable and
> disable individually."

Status: **done**.
- The list already existed under the MCP tools toggle (`#pm-mcp-builtin` =
  files / shell, `#pm-mcp-custom` = servers added in Settings). Every row is now
  a `<label>` with its own switch, so tapping anywhere on the row flips it.
- Built-in sets use the existing per-chat columns (`files_enabled`,
  `shell_enabled`); custom servers use a new per-chat column
  `conversations.mcp_disabled` holding a JSON array of server names
  (`server/db.js`). `normalizePolicy()` exposes it as `disabledServers`
  (`server/services/builtin/policy.js`).
- `PATCH /api/conversations/:id` accepts `mcp_disabled` as an array (or a JSON
  string, or `null`/`[]` to clear it), trims and dedupes the names, rejects
  unknown server names with 400, and stores `JSON.stringify(names)`.
  `POLICY_COLUMNS` now includes it, so create + patch share the same validation.
- `mcpManager.allTools()` skips a switched-off server, so its tools are never
  advertised upstream; `callTool()` refuses a disabled server's tool even if the
  model echoes a name from an earlier turn (`serverEnabled()`).
- Client: `chatOffServers()`, `serverOffForChat()`, `setServerEnabled()` and the
  switches in `renderPlusMcp()`; `updateToolsHint()` / `updateChatSub()` count
  only the servers this chat has on, and `setChatOption()` keeps the chat-option
  switches and the MCP rows in sync. A server switched off in Settings shows a
  disabled switch ("… is switched off in Settings").
- Rows are 44 px in the blank-chat panel and compact (~33 px) in the `+` popup;
  with the MCP tools toggle off the two server lists dim to 50 % but stay
  editable so a chat can be set up before the first send.

Verified with a real custom MCP server (`test/mock-mcp-server.js`) plus the two
built-ins: demo off → `demo__*` absent from the request sent to the mock
upstream, files + shell still there; shell off → `shell__*` gone, files and demo
kept; both off → only `files__*`; MCP toggle off → no tools at all; values
survive a reload; unknown / non-array values rejected with 400. Screenshots at
1400 px dark + light, 1024 px and 390 px (scrolled to the MCP cards) and the `+`
popup in a chat with messages. e2e all checks passed, builtin 56, auth 38,
context 34.

### 2026-10-29 — Windows, Chrome and Edge automation tools

> "add windows , edge and chrome automation tools"

Status: **done**. Three new built-in MCP servers, ordinary in-process servers
like `files` / `shell`, so they appear in the MCP list, are namespaced
(`windows__list_windows`, `chrome__navigate`, …) and are switchable per chat
(`windows` / `chrome` / `edge` go through `mcp_disabled`; `files` / `shell` keep
their own columns). 11 tools each, 50 tools total from 5 built-in servers.

- `server/services/builtin/windowsServer.js` + `win32.js`: `system_info`,
  `list_windows`, `focus_window`, `window_action` (minimize / maximize /
  restore / close / move / resize), `launch_app`, `screenshot`, `send_keys`,
  `type_text`, `mouse_click`, `clipboard_get`, `clipboard_set`.
  - Scripts run through `powershell.exe -EncodedCommand` (base64 UTF-16LE).
    Model text is passed in `RI_*` environment variables, never spliced into
    the script; `stdin` mode silently dropped multi-line scripts — do not go
    back to it.
  - Windows are enumerated with `EnumWindows` (visible, titled, non-tool
    windows), **not** `Get-Process.MainWindowHandle`, which drops windows for
    store apps and reports 0 as soon as one stops being the "main" window.
  - `launch_app` returns the new window handle (falls back to a new window whose
    title mentions the program, for console windows owned by conhost).
  - `type_text` / `send_keys` focus the target and **verify it is really in
    front**; if it cannot be, they throw and send nothing. This is deliberate:
    SendKeys goes to whatever has focus, so without the check a stale handle
    types into the user's other windows. The message names the foreground
    window, or says the desktop looks locked (`GetForegroundWindow() == 0`).
  - Screenshots save a PNG in the chat folder via `resolvePath` and return the
    path; the model never receives pixels.
- `server/services/builtin/browserServer.js` + `cdp.js`: `chrome` and `edge`
  share one raw-CDP driver (no puppeteer): `open`, `list_pages`, `navigate`,
  `page_text`, `evaluate_js`, `click`, `fill`, `press_key`,
  `wait_for_selector`, `screenshot`, `close_page`.
  - Each browser is started with `--remote-debugging-port` (chrome 9222, edge
    9223) and its **own** profile under
    `%LOCALAPPDATA%\RiSriGPT\browser\<kind>-<port>`, so the user's browsing
    profile is never touched (and never locked by a second instance).
    Overrides: `RISPRIGPT_CHROME_PATH` / `RISPRIGPT_EDGE_PATH`.
  - `CDP /json/new` needs `PUT` (GET fallback); tabs are picked by
    `page_id`, defaulting to the current non-devtools page.
- `describeCall()` has approval summaries for every new tool; read-only tools
  (`list_windows`, `screenshot`, `clipboard_get`, `page_text`, `list_pages`,
  `wait_for_selector`) are annotated `readOnlyHint` so *Ask me first* does not
  prompt for them; everything that changes state prompts.
- `stopAllBuiltin()` also closes the automation browsers on shutdown.
- Settings copy (`public/index.html`) now describes all five built-in servers.
- `public/styles.css`: `#mcp-list` rows are real cards and the tool tags wrap
  (they used to run off the dialog once a server had 11 tools).

Verified: new `test/automation.mjs` (own app + temp DB on scratch ports, 50
passed / 1 skipped — the screen screenshot skips when the desktop is locked);
e2e all passed, builtin 56, auth 38, context 34. Real runs: all five built-ins
connect (11/11/11/6/11 tools); Chrome and Edge headless open → text → click →
fill → eval → key → wait → screenshot → navigate → close; Windows: system info,
window list, clipboard round-trip, launch/focus/minimize/restore/close of our own
window, window + screen screenshots, mouse click; typing proven with a console
command that wrote a file, and `^a^c` + `clipboard_get` read it back. Screenshots
of the blank-chat panel (1400 dark/light, 390 mobile) show the five built-in
servers with per-chat switches, and clicking the `chrome` switch drops the header
to "39 tools from 4 MCP servers · chrome off for this chat" and stores
`["chrome"]`.

### 2026-10-31 — Resume button after a server error

> "show a resume button when generating fails due to server error."

Status: **done**. A failed turn that is the last message in the chat now shows
a **▶ Resume** button inside its `.error-box`; clicking it continues the reply
from where it stopped.

- `renderMessage()` (`public/app.js`) builds the error box as
  `.error-text` + `.error-actions` and appends the button only when
  `m.role === 'assistant' && isLast && !state.streaming`. The old text
  `continue` link in `.msg-actions` is suppressed on error rows (`&& !m.error`)
  so the two never appear together.
- The button calls `continueReply()`, which now returns `true`/`false` instead
  of `undefined`, so the click handler can disable itself, show "Resuming…",
  and re-enable + restore the label when nothing was sent (e.g. the run could
  not start). This is the same request the Continue action always sent:
  `POST /api/chat { continue: true }` — no new endpoint, no new column.
- The server already kept the partial text of a failed reply and includes it in
  the prompt (`context.js` / `chatService.js` skip only *empty* error rows), so
  resuming genuinely continues the answer instead of starting over.
- Resuming appends a new assistant row, exactly like the existing Continue; the
  failed row stays visible above it as history and loses its button because it
  is no longer last.
- `public/styles.css`: `.error-text` wraps long upstream messages,
  `.error-actions` lays the button out, `.error-resume` is a normal
  `btn btn-primary sm` (not red) with a 32 px min height.

Verified with a mock upstream that dies mid-stream once per conversation and
then answers: API run showed the error row persisting `"Here is a partial
answer. "` and the resume request carrying it back in the prompt
(`system -> user -> assistant`). UI run in headless Chrome: 13 checks passed —
the button appears only on the last failed row, the header `continue` link is
gone, the button disables itself, the reply completes ("…resumed cleanly."),
the stale error row loses its button, and it still fits at 390 px. Screenshots:
dark 1400, light 1400, light 390, plus a plain reload showing the button
survives a refresh. e2e all checks passed, builtin 56, auth 38, context 34.

### 2026-10-31 — message actions, per-message file changes, file explorer, zip tools

> "do not show regenerate and delete button in Assitant message. These buttons
> is only applicable for User messages.
>
> For every user meesage, keep a track of edited code and txt files and allow to
> view comparison and if not satisfied show a revert button for each file.
>
> Show a file exploerer for each chat for the workspace folder with basic file
> view for code , images , md and html files. show preview of md and html files
> along with code view (switchable)
>
> In inbuilt file tools add zip and unzip options.
>
> And if asked to assistant to share the workspace, then it will compress and
> allow the zip file to be downloadable."

Status: **done**.
- **Message actions**: Regenerate and delete buttons are strictly restricted to user messages (`m.role === 'user'`). Assistant messages only show Copy and Continue/Resume.
- **Per-message file tracking & comparison/revert**:
  - Added `file_changes` table in SQLite recording `conversation_id`, `message_id`, `path`, `rel_path`, `before_exists`, `before_text`, `after_exists`, `after_text`, and `reverted_at`.
  - `fileChanges.js` tracks file states using `AsyncLocalStorage` across tool calls during the turn.
  - User messages render an expandable `file-changes` section listing each modified file with line diff stats (`+N −M`), a **Compare** button opening a line-by-line diff modal (`#dlg-diff`), and a **Revert** button (with two-step confirmation) calling `POST /api/conversations/:id/fs/changes/:changeId/revert` to restore or remove the file.
- **Chat Workspace File Explorer**:
  - Added a direct **Files** button (`#btn-header-files`) in `#chat-header` alongside AI and Export, and kept the item in the `+` popup.
  - Modal explorer (`#dlg-files`) allows browsing the chat's workspace folder, navigating directories, creating folders, uploading files, renaming, deleting, and downloading.
  - Built-in previewer supports code/text files, images (inline display), and switchable Preview vs Code tabs for Markdown (rendered via `renderMarkdown`) and HTML (rendered in a sandboxed iframe).
- **Built-in ZIP and Unzip tools**:
  - `files__zip`: Compresses specified files or directories into a `.zip` archive (skipping `node_modules`, `.git`, etc.).
  - `files__unzip`: Safely extracts archives into target directories with path traversal protection.
  - Zero external dependencies: implemented in `server/services/builtin/zip.js` using standard `node:zlib`.
- **Share Workspace & Downloadable ZIP**:
  - `files__share_workspace`: Built-in tool compressing the entire workspace into `workspace.zip`.
  - Produces a downloadable file chip in the assistant turn with a direct download button.
  - `markdown.js` auto-routes markdown links pointing to workspace files (such as `[workspace.zip](workspace.zip)`) via `window.conversationFileUrl(..., true)` so clicking directly downloads the file.

Verified:
- `node --check` clean on all JS/MJS files.
- `test/builtin-tools.mjs`: 59 passed, 0 failed (testing all 14 files tools including zip, unzip, and share_workspace).
- `test/auth.mjs`: 38 passed, 0 failed.
- `test/context-compress.mjs`: 34 passed, 0 failed.
- `test/automation.mjs`: 50 passed, 0 failed, 1 skipped.
- `test/e2e.mjs`: All checks passed.
- Headless browser screenshot verified UI layout and buttons.

### Earlier requests (from the session summary; exact wording not retained)

- Full visual polish pass on the UI (theme tokens, sidebar, header, messages,
  composer, dialogs, mobile, empty state). **done**
- Align the AI / Export / model controls in the chat header. **done**
- Sidebar "generating" spinner after the conversation title. **done**
- Show timestamps in local time, exact UTC in the tooltip. **done**
- Elapsed timer must survive refresh / chat switch. **done**
- Token-speed estimate must not spike after a refresh (exclude replayed
  backlog; server `hello` event). **done**

---

## Open watch list

- The blank-chat setup panel must keep every control that the `+` menu has
  (except attachments). If a new control is added to `#plus-menu`, either list
  its section in `SETUP_INLINE_SECTIONS` or leave it in the popup — never
  duplicate markup.
- Attachments (`#pm-attach`, `#image-url-row`) stay in the `+` popup; the `+`
  button must remain visible and working on the blank-chat screen.
- Keep the error reason visible after reload (message row + `.error-box`).
- The Resume button in `.error-box` is only for the *last* assistant row and
  only when nothing is streaming; it must keep going through `continueReply()`
  (one request shape, no second code path), and `continueReply()` must keep
  returning a boolean so the button can recover from a failed attempt.
- Keep the thinking box's body and its "N characters" summary consistent.
- The persona / thinking chips are mirrors of the selects: always repaint them
  from the select value (`renderInlineChoices()`), and strip them when the
  sections go back into the popup.
- Per-chat MCP switching is three pieces and they must stay in step: the
  `mcp_disabled` JSON column + `disabledServers` in `normalizePolicy()`, the
  filter in `mcpManager.allTools()` (and `callTool()`), and the row switches in
  `renderPlusMcp()`. Built-in sets keep using `files_enabled` / `shell_enabled`;
  only custom servers go in `mcp_disabled`. Any new place that counts tools
  must go through `chatOffServers()` / `serverOffForChat()`.
- The automation servers are registered in `BUILTIN_SERVERS`; never add a
  second, parallel registry or a hard-coded tool list in the UI.
- `windows__type_text` / `send_keys` must keep verifying the foreground window
  before sending (`Focus-Target`). Without that check SendKeys types into
  whatever window happens to be in front — i.e. the user's own app.
- Windows are resolved by `EnumWindows` (`RWin::ListWindows`). Do not go back to
  `Get-Process.MainWindowHandle`: it returns 0 for store apps and for windows
  that stop being a process's "main" window, which broke handles mid-task.
- PowerShell for the `windows` server always goes through
  `-EncodedCommand`; stdin mode drops multi-line scripts. Errors come back as a
  single `__RI_ERROR__` line on stdout (stderr is wrapped CLIXML).
- The `chrome` / `edge` servers must keep using their own profile dirs and
  debug ports (9222 / 9223). Never point them at the user's real profile.
- `test/automation.mjs` must stay runnable on a locked desktop: the screen
  screenshot is skipped when the desktop has no foreground window, and the
  Chrome / Edge checks are skipped when a browser is not installed.
