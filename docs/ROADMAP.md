# RiSriGPT — feature roadmap

A prioritized list of features that fit the current architecture (Node/Express +
vanilla JS + SQLite, one server, LAN clients). Each item says **why**, **where it
plugs in**, and a rough size (S ≈ half a day, M ≈ 1–2 days, L ≈ 3+ days).

Nothing here is implemented yet — this is the menu to pick from.

> **Update:** the quick-wins bundle is now implemented: **#3 export**
> (Markdown/JSON), **#4 light/system theme**, **#5 command palette** and
> **#6 continue reply**.

---

## Tier 1 — quick wins

### 1. Full-text search across messages · S/M
Today the sidebar search only matches conversation titles. Add an SQLite **FTS5**
virtual table over `messages.content` (kept in sync with triggers), `GET
/api/search?q=` returning conversation + message hits, and a results panel that
jumps to the message (scroll + highlight). Fits: `server/db.js`,
`server/routes/conversations.js`, `public/app.js`.

### 2. Pin / archive / folders for chats · S/M
Three small columns (`pinned`, `archived`, `folder`) plus sidebar sections and
drag-free "move to folder" menu. Keeps the list usable once someone has 200
chats. Fits: `conversations` table + `renderConvList()`.

### 3. Export & share · S
`GET /api/conversations/:id/export?format=md|json` streams a download; the UI
adds "Export" to the chat menu. Optional read-only share link: a random token
row that serves a static transcript page without a session. Fits: new route +
a tiny public template.

### 4. Light / system theme · S
The CSS is already fully variable-driven (`:root` in `styles.css`), so a
`[data-theme="light"]` block + a three-way toggle (light/dark/system) stored in
`localStorage` is mostly CSS. Also sets `color-scheme` for form controls.

### 5. Command palette + shortcuts · M
`Ctrl/Cmd+K` opens a fuzzy palette: switch chat, new chat, open settings,
personas, MCP, toggle sidebar, pick model. Extend the existing `Ctrl+N` handler.
Fits: `public/app.js`, one dialog in `index.html`.

### 6. Continue a stopped reply · S
When a turn ends with `Stopped.` (or a length cut-off), show **Continue**; it
sends a hidden "continue exactly where you left off" turn reusing the stored
history. Reuses `POST /api/chat` + `truncate-after` semantics.

### 7. Edit & resend / retry with another model · S/M
`truncate-after` already exists. Add per-message actions: edit a user message
and resend, regenerate with a different model, or fork a new chat from that
point. The last one is the cheap version of branching (see #28).

### 8. Slash commands & prompt snippets · S/M
Type `/` in the composer to insert a saved snippet (built-ins like
`/summarize`, `/translate`, `/explain`, plus user-defined ones stored per user).
Fits: a small table + a composer popover; no model changes.

### 9. In-conversation search · S
`Ctrl+F` inside the transcript with match count and next/prev. Pure frontend.

### 10. Document attachments (PDF/DOCX/text) · M
Images are already sent as vision input. For non-vision models, extract text
from PDFs/DOCX on upload (`pdf-parse`, `mammoth`) and append it to the message
(or save it next to the chat and reference the path). Fits:
`POST /api/conversations/:id/fs/upload` + composer attach flow.

---

## Tier 2 — agent / workspace (the "opencode-like" part)

### 11. Projects · M
A project = a working folder + a name + defaults (model, policy, persona,
instructions). Chats belong to a project, the sidebar groups by it, and a
`AGENTS.md`-style file in the folder is injected into the system prompt. This is
the single biggest quality-of-life upgrade for coding use.

### 12. Git tools + diff viewer · M
Built-in `git_status`, `git_diff`, `git_log`, `git_commit` (with approval), and
a diff renderer for `write_file`/patch results. Read-only git tools run without
approval like other read-only tools.

### 13. `apply_patch` with diff approval · M
A patch tool that takes a unified diff, shows the resulting changes in the
approval card, and applies atomically. Pairs with #12 and makes multi-file edits
far more reliable than whole-file rewrites.

### 14. Plan / act mode + todo checklist · M/L
A per-chat mode: **plan** only reads and proposes steps, **act** executes. The
model maintains a todo list (`todo_write` tool) rendered as a sticky checklist
above the composer. Mirrors the opencode workflow.

### 15. Subagents / task delegation · L
Let the model spawn a child run ("investigate X and report back") with its own
context window, then continue with the summary. Server already has a run manager
and per-run events; this is mostly orchestration + a UI card.

### 16. Artifacts panel · M
Files the model writes that are previewable (HTML, SVG, Markdown, CSV, images)
open in a side panel with live preview and a download button. Reuses
`file_created` events and `/api/conversations/:id/fs/raw`.

### 17. Long-term memory · M
Per-user notes the model can add to and read from (`remember`, `recall`), plus
an editable Memory page. Injected as a compact system block each turn. Cheap
personalization that survives chats.

### 18. Folder RAG · L
Index a folder: chunk files, embed with a local embedding endpoint (or the chat
model's `/embeddings`), store vectors in SQLite, expose `search_docs`. Answers
"what does this repo do?" without stuffing whole files into context.

### 19. MCP prompts & resources · M
The MCP manager currently only lists tools. Add `listPrompts` (exposed as slash
commands) and `listResources` (attachable context), which many MCP servers
already provide.

### 20. MCP presets · M
One-click cards for common servers (filesystem, git, fetch, sqlite, memory)
that prefill the editor with the right command/args and env fields.

---

## Tier 3 — platform & admin

### 21. API tokens + OpenAI-compatible gateway · M/L
Personal tokens (`Authorization: Bearer`) for scripts, plus
`POST /v1/chat/completions` that proxies to the configured model server with a
token's quota. Turns the app into a gateway for other tools (and for opencode
itself).

### 22. Usage dashboard + budgets · M
Aggregate the `stats` already stored per message into tokens/day, per user, per
model, top chats; add soft/hard daily limits per account. Fits the existing
`prompt_tokens`/`completion_tokens` columns.

### 23. Audit log · M
Append-only table of tool calls, approvals, settings changes, logins and admin
actions, with an admin-only viewer and filters. Complements the per-user
approval work.

### 24. Scheduled prompts / background tasks · M
In-process cron ("every weekday 08:00, summarize the inbox folder") that starts
a run and leaves the result as a chat. Notification when it finishes.

### 25. PWA + notifications · S/M
Manifest + service worker for installability on phones, plus Web Push (or a
simple in-app badge) when a long turn or approval is waiting.

### 26. Sandboxed shell · L
Right now the shell tools run with the server's privileges. Options: Windows Job
Objects with memory/CPU/time limits, a restricted token, or an optional WSL /
container backend. Pair with per-tool allowlists and output caps.

### 27. Model fallback chain · S/M
If the primary model errors or times out, retry once with a configured fallback
model and tell the user. Small change in `services/openai.js` + a settings field.

### 28. Conversation branching · L
A tree instead of a list: editing any message creates a sibling branch; the UI
shows ‹ 2/3 › to switch. Big schema change (`parent_id`), but the payoff is real
for exploratory work.

### 29. Voice input & read-aloud · S/M
Web Speech API for dictation in the composer and TTS for the last reply. No
server work; graceful fallback where unsupported.

### 30. Model comparison · M
Send one prompt to N models and render the answers side-by-side with stats, then
"keep this one". Reuses the run manager with a synthetic conversation.

### 31. i18n · M
Extract UI strings, add a locale switch (EN/DE/…), keep dates/numbers localized.

---

## Suggested sequence

1. **Theme + command palette + continue** — visible polish, almost no risk.
2. **Search (FTS) + pin/archive + export** — the chat list stops being a
   bottleneck.
3. **Projects + git/diff + apply_patch** — the agent workflow.
4. **API tokens + usage dashboard** — makes the app useful beyond the browser.

## Notes

- Anything that runs commands or touches files stays behind the existing
  approval + per-chat policy layer; new tools should reuse
  `server/services/builtin/policy.js` rather than bypass it.
- Schema changes are cheap here (SQLite + `ALTER TABLE` in `db.js`), but keep
  migrations idempotent like the existing ones.
- Prefer extending existing routes over adding parallel APIs; the frontend is a
  single `app.js`, so new panels should reuse `el()` and the current modal
  helpers.
