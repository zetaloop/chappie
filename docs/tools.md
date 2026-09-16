# Tools

| Tool | Purpose |
|---|---|
| `init` | Connect to a Pi session and read its environment, tool catalog, skills, global `AGENTS.md`, and pending input. |
| `sessions` | List connected Pi sessions and the chat's default session. |
| `tools` | Read complete definitions for selected active tools. |
| `chat` | Display Markdown as an assistant message in Pi. |
| `ask` | Display a persistent question in ChatGPT while work continues. |
| `ask_assert` | Assert that an `ask` widget becomes available in the ChatGPT UI. |
| `call` | Run one or more tools as a Pi batch. |
| `read` | Read local text or images. |
| `bash` | Execute a shell command. |
| `edit` | Apply text replacements. |
| `write` | Write text to a file. |
| `transfer` | Copy files between ChatGPT and Pi, or export a Pi image as a file. |

## Model environment

The active model is the current ChatGPT conversation. A Pi tool that starts another `chappie/chatgpt` agent cannot create a new browser conversation, so that child waits without a model response. Subagents configured with another provider use that provider normally.

Use ChatGPT's web search, connectors, and cloud tools for remote research and cloud-side work. Chappie tools operate on local files, processes, Pi extensions, and Pi user interfaces. Pi project-memory tools access their local stores; Pi context-reduction tools do not alter the current ChatGPT conversation.

With the Chappie provider selected, its context hook supplies an empty message list for model-input conversion. Pi's transcript and session tree retain the original messages for display, branching, and input delivery. Chappie collects newly appended entries incrementally; switching providers uses Pi's normal history.

Use `chat` for progress or results that should appear in Pi. When a Pi user decision is needed, load the installed interactive tool definition with `tools` and invoke it through `call`.

## Sessions

For a new task without a specific target, call `init` with `{}` to reuse this chat's default or allocate the first online, unbound Pi session. Sessions register while `chappie/chatgpt` is selected. They can be blank or already contain a task; a remote operation starts a turn when Pi is idle.

`sessions` lists session IDs, working directories, names, status, and `bindingCount`, the number of saved chat defaults pointing to each session. Zero means the session can be allocated automatically. The count includes closed chats; execution status describes Pi activity: `ready` accepts provider output, `executing` handles an operation, and `idle` starts a turn on the next operation.

`init.selection` reports how the target was chosen: `existing` reuses this chat's default, `explicit` uses the supplied session ID, and `automatic` allocates the first online session with no saved bindings. Explicit selection also accepts sessions already used by other chats.

To continue existing work in a new chat or branch, pass the Pi session ID associated with that task in the inherited context:

```json
{ "sessionId": "<session-id>" }
```

This establishes the new chat's default, even when another chat already uses the same Pi session. For a requested project or session without a known ID, select it from `sessions` by working directory or name. When the target is absent or ambiguous, clarify the intended session before running tools. A session being the only one online does not establish that it is the requested target.

The optional `sessionId` on other tools selects a session for that operation. For example, `read` can inspect another project:

```json
{ "path": "package.json", "sessionId": "<session-id>" }
```

`sessions({ sessionId })` filters the online list and retrieves available input when that session is connected. The call returns immediately when the selected or bound session is offline; the saved binding is still shown, and deferred results remain available.

Several chats can select the same Pi session, and one chat can address several sessions. Defaults are saved in `chappie.state.json` under Pi's agent directory. An existing binding waits for its Pi session to reconnect; `init` with another ID selects a different target.

Pi displays Chappie activity as individual session entries in arrival order. Each `init` reports that the chat joined; selecting another session reports that it left the previous one. Chat labels use the last four characters of the connector's identifier. Connection changes, cancelled calls with their tool names and reasons, webpage questions and answers, and stored deferred results appear in the same history. Entries use Pi's theme colors, survive reopening the session, and remain separate from model messages.

## Tool calls

`read`, `bash`, `edit`, and `write` accept Pi's tool parameters plus `sessionId`. Their descriptions provide the current schemas. The catalog in `init.tools` lists Pi's native and extension tools available through `call`. Chappie's `init`, `sessions`, `tools`, and `chat` are separate top-level MCP tools. Load complete definitions for installed extension tools before calling them:

```json
{ "names": ["ask_user", "ctx_search"] }
```

Omit `names` to return every active definition. Definitions already present in the current ChatGPT context can be reused without another query.

A single extension tool uses a one-item `calls` array. To request a batch:

```json
{
  "calls": [
    { "name": "read", "arguments": { "path": "package.json" } },
    { "name": "read", "arguments": { "path": "src/index.ts" } }
  ]
}
```

Each batch returns its results together. Pi determines how its tools run within the batch. Separate calls run in order within one Pi session; different sessions can work independently.

Extension tools execute through Pi, including their interactive prompts. Each batch starts with its executing `sessionId` and Pi `cwd`, followed by each tool's name, call ID, error status, and original text or image content. The directory is captured when the batch starts; a shell `cd` changes that command's working directory, while the operation stays in the same Pi session.

Tool results include `structuredContent.text` with complete text in result order, including Pi input, submitted webpage answers, deferred results, and image references. The same text remains in `content` alongside native images and resource links. Question tools also return the structured question for their widget.

ChatGPT file inputs use the direct `transfer` tool. Its top-level `files` parameter lets the host prepare the files before sending them to Pi.

## Messages and interrupted calls

Call `chat` to display a reply in Pi:

```json
{ "text": "Updated the parser and its callers." }
```

Pi renders the supplied Markdown, including fenced code blocks, and appends the message to the session transcript. Each call completes one assistant message. Later operations start another turn when Pi is idle. The result returns the target `sessionId`, Pi `cwd`, and any new Pi input without repeating the message text.

User messages consumed by Pi accompany later Chappie replies, including images. Steering is delivered when Pi consumes it; follow-up uses Pi's normal follow-up timing.

Explicit cancellation removes a queued request or asks Pi to stop its active batch. Available results from that batch accompany a later reply to the originating chat, with the original session ID and working directory. `sessions` can retrieve them before another tool call. When ChatGPT stops without sending cancellation, local execution continues.

Host request deadlines include time spent in the queue. Use local facilities such as tmux for work intended to outlive one call.

## Webpage questions

`ask` creates a question in the ChatGPT page and returns immediately. The returned question contains the generated ID used to check whether its widget actually loaded:

```json
{
  "header": "Export format",
  "question": "Which export format should the command use?",
  "context": "Both formats preserve the required data. The shared export code can proceed independently of this choice.",
  "options": [
    { "title": "JSON", "description": "Convenient for downstream programs.", "recommended": true },
    { "title": "CSV", "description": "Convenient for spreadsheet software." }
  ]
}
```

Call `ask_assert` with `question.id` immediately after `ask` to confirm that the widget becomes available in the ChatGPT UI:

```json
{ "questionId": "7fb6b57e-..." }
```

`ask_assert` returns immediately when the widget already reported `loaded`; otherwise the call remains open until that report or the host ends the request. It asserts widget availability only and does not wait for the user's answer. A host cancellation or request deadline before the report means the assertion did not succeed during that call.

Use `header` for a short topic label when useful. Put the recommended option first with `recommended: true`; the widget displays a badge separately from its title. Omit `options` for a text-only question, or set `allowMultiple: true` for multiple selections. Custom input and skipping are supplied by the widget. The optional `sessionId` associates the question with a particular Pi session without changing the chat's default.

Submitting saves the answer directly in the broker, even while Pi is executing a tool. The next normal Chappie result carries a `webAnswer` with the question, selected options, free text, and original Pi session. A skipped question carries `skipped: true`; continue with the available information instead of asking the same question again. The assistant uses that result to continue the current response. The widget does not send a chat message, start another response, or poll for an answer.

Single-choice options submit on click. Custom input submits with Enter; Shift+Enter adds a line. Multiple selections use the submit button and can include free text. Number keys choose options while focus is inside the card, and arrow keys move between choices. Submitted and skipped questions show a compact summary with an action to answer again. The close control folds the card without submitting; reopening it restores the draft.

Questions and answers survive broker restarts in `chappie.state.json`. Reopening a widget reads its saved question once; drafts stay with that widget. An updated answer is delivered again, while repeated submission of an unchanged answer has no additional effect. The component-only `answer` tool handles state reads, loading reports, and answer submission. Its initial state read includes `loaded: true` after the question from `toolOutput` has rendered. These replies confirm the saved state without consuming delivery to the model.

Pi's installed interactive tools continue to use their own interface through `call`.

## Files

`transfer.paths` names files on the Pi machine. Relative paths resolve from the selected session's working directory. Absolute paths and `~/` work too, including Windows paths such as `C:/Tmp/report.zip`.

### ChatGPT to Pi

Supply matching `paths` and `files` arrays:

```json
{
  "paths": ["assets/reference.png"],
  "files": ["/mnt/data/reference.png"]
}
```

`files` contains actual cloud paths or attachment references available to ChatGPT. The host converts them into file objects with download URLs before Chappie receives the call.

Multiple files are matched by array position:

```json
{
  "paths": ["assets/reference.png", "data/input.csv"],
  "files": ["/mnt/data/reference.png", "/mnt/data/input.csv"]
}
```

Chappie creates parent directories and streams each file into its destination. Existing targets produce an error. To replace a file:

```json
{
  "paths": ["assets/reference.png"],
  "files": ["/mnt/data/reference.png"],
  "overwrite": true
}
```

Overwriting truncates the existing file. A failed or canceled download removes the incomplete target opened by that operation, including an overwritten target. Successful files in a batch remain in place; the result reports each file's byte count or error.

### Pi to ChatGPT

Omit `files` to export existing files:

```json
{ "paths": ["build/output.zip", "renders/preview.png"] }
```

The result contains resource links with file names, types, and sizes. ChatGPT retrieves the bytes and handles attachment creation and cloud-container access. This may prompt for confirmation.

Each resource refers to its original Pi session, even after the chat selects another default. Keep that Pi process and the source files available while ChatGPT reads them. Files are read when requested. After starting a new Pi process, export again to obtain a fresh reference.

For a directory, create an archive using a Pi tool and export that file.

### Images

`read` sends images directly to ChatGPT for viewing. Images from Pi tools and user messages also include a `piImage` field containing a `chappie://` reference.

To analyze one in ChatGPT's cloud container, pass the returned reference in `transfer.paths`. This exports the image bytes held by Pi as a file. Include the image's owning `sessionId` when another session is selected.

To transfer the original image file, use its local path. Pi may resize or convert images for viewing.
