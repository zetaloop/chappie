# Tools

| Tool | Purpose |
|---|---|
| `init` | Select this ChatGPT conversation's default Pi session and read its environment. |
| `history` | Read the current Pi branch with timestamps and entry IDs. |
| `sessions` | List connected Pi sessions and the current default. |
| `tools` | Read full definitions of active Pi tools for `call`. |
| `chat` | Send an assistant message to Pi. |
| `ask` | Create a persistent question in ChatGPT. |
| `ask_assert` | Confirm that an `ask` widget loaded. |
| `call` | Run one or more Pi tools as one native batch. |
| `read` | Read local text or images. |
| `bash` | Run a shell command. |
| `edit` | Apply text replacements. |
| `write` | Write text to a file. |
| `transfer` | Move files between ChatGPT and Pi, copy between Pi sessions, or export a Pi image. |

## Sessions

Call `init` at the start of local work. Without `sessionId`, it reuses the conversation's saved default or selects an online Pi session with no saved ChatGPT binding. Pass a Pi session ID to resume a specific task, including from another ChatGPT conversation or branch. Read recent `history` to recover progress before continuing the current task.

Follow the participation guidance in `initialization.instructions`.

`sessions` lists connected sessions with their ID, device, working directory, name, execution status, and binding count. The first execution tool call establishes the default using its `sessionId` or an online session with no saved bindings. Once a default exists, another tool's `sessionId` selects only that operation's target; `init({ sessionId })` changes the default.

Several ChatGPT conversations can use the same Pi session. One conversation can also operate on several Pi sessions explicitly. Requests already assigned to a session continue there even if the conversation later changes its default.

Remote Pi sessions appear in the same list when they connect to a broker exposed through `listen` and `connect`. Their tools, global `AGENTS.md`, files, images, and Pi interfaces come from the remote device.

## History

`history` reads the current branch of a Pi session. It uses the saved default or an explicit `sessionId`, independently of default-session selection.

```json
{ "sessionId": "<session-id>", "limit": 20, "before": "<entry-id>" }
```

Omit `before` for the latest entries. Use `after` to read forward from an entry. Both fields can delimit a range, with the named entries outside the returned range. The default limit is 20 readable entries. Results follow branch order and contain each entry's original ID and timestamp. `hasMore` indicates additional entries in the requested direction.

To follow progress, pass `after` with `wait: true`. Available entries return immediately; at the end of the branch, the request waits up to 30 seconds for new readable entries. A timeout returns an empty page. Reads with `before` return immediately. Cancellation, disconnection, or an invalidated branch cursor ends the request. Waiting for history leaves the session available for other requests.

Set `observer: true` to read as an observer. Ordinary reads leave a notice in Pi; observer reads omit that notice. History-reading notices are excluded from returned pages and their counts. New messages and work activity wake waiting readers; idle status alone does not indicate task completion.

Messages, tool calls and results, summaries, images, file links, and Chappie activity records use their saved contents, including Pi's existing truncation notices and full-output paths. Assistant messages carry their originating `chatId` and optional full `requestId` in `message.chappie`. Tool results inherit the source of their `toolCallId`, including when the call falls outside the requested page. Activity records carry the same source fields. Request-specific notices display a compact label such as `ChatGPT Zxbs(fd44) joined`; the workflow suffix is for log correlation and can be shared by parallel executions. The returned history remains separate from new input and pending result delivery.

Pi user input, webpage answers, connection status, and deferred delivery target sessions or conversations. A deferred result's `requestId` identifies the original operation; the result can reach another execution in that conversation.

## Participation

Initialization opens a 10-second window for its ChatGPT conversation and Pi session. Repeated initializations within that window return observer guidance alongside the normal environment and input. They leave the window's expiration unchanged. The broker stores these times in memory.

The first widget loading report also opens a window for the question's conversation and session. Resource reads open a window when requested and renew it after a successful read. Exported resource links carry the receiving conversation ID so these reads address the corresponding window independently of the current binding.

The executing assistant uses `chat` to share progress and completion in Pi. An observer follows that work through `history` with `observer: true` and `wait: true`, thinks independently, and explains the recorded results in ChatGPT when the task is complete. Participation guidance applies to the current task. Tool execution and message delivery use their normal session and conversation routes.

## Pi tools

`read`, `bash`, `edit`, `write`, and `transfer` are available directly. `init` includes a short catalog of the active Pi tools; use `tools` for their complete definitions and `call` to invoke extension tools.

For example:

```json
{ "names": ["ask_user", "ctx_search"] }
```

A `call` array is one Pi tool batch:

```json
{
  "calls": [
    { "name": "read", "arguments": { "path": "package.json" } },
    { "name": "read", "arguments": { "path": "src/index.ts" } }
  ]
}
```

Pi controls execution inside that batch. Separate requests run in order within one Pi session, while different Pi sessions can work independently. Extension tools retain their native Pi behavior, including interactive interfaces.

`chat` creates a normal assistant message in Pi:

```json
{ "text": "Updated the parser and its callers." }
```

Pi user input consumed during the work accompanies later Chappie results, including images. Steering and follow-up follow Pi's own delivery timing.

If a request is explicitly cancelled after local work has produced results, those results can accompany a later response to the originating ChatGPT conversation. Long-running local work is better run through the environment's persistent process facilities instead of occupying one tool request.

The active model remains the current ChatGPT conversation. Starting another `chappie/chatgpt` agent inside Pi does not create another browser conversation; tools that need another model should use a separately configured provider.

## Webpage questions

When enabled, `ask` saves a question and requests a widget in ChatGPT, returning its ID immediately. Display depends on the host:

```json
{
  "header": "Export format",
  "question": "Which export format should the command use?",
  "context": "Both preserve the required data.",
  "options": [
    { "title": "JSON", "description": "Convenient for programs.", "recommended": true },
    { "title": "CSV", "description": "Convenient for spreadsheets." }
  ]
}
```

Call `ask_assert` with the returned ID to confirm that the widget loaded:

```json
{ "questionId": "<question-id>" }
```

If the widget has not loaded within 10 seconds, `ask_assert` fails and saves the unanswered question as skipped. Its loading state remains unchanged. Use a Pi interactive tool when an answer is needed. The user can still answer or edit the saved question when its widget is available.

Answers, revisions, and skips arrive later as `webAnswer` in normal Chappie results. `options` can be omitted for a text answer, and `allowMultiple: true` allows several choices. `sessionId` associates the question with a Pi session using the session selection rules above.

Questions remain available after the assistant response and across broker restarts. Pi's own interactive tools remain ordinary Pi tools and can be invoked through `call`.

## Files

`transfer.paths` always names paths or image references on the Pi side. Relative paths resolve from the selected Pi session's working directory; absolute paths and `~/` are accepted.

### ChatGPT to Pi

Pair Pi destinations with ChatGPT files:

```json
{
  "paths": ["assets/reference.png", "data/input.csv"],
  "files": ["/mnt/data/reference.png", "/mnt/data/input.csv"]
}
```

The ChatGPT host turns the cloud paths or attachment references into downloadable file objects before the call reaches Chappie. Chappie creates parent directories and writes each file directly to its destination.

Existing targets produce an error by default. Use `overwrite: true` when replacement is intended:

```json
{
  "paths": ["assets/reference.png"],
  "files": ["/mnt/data/reference.png"],
  "overwrite": true
}
```

A failed or cancelled transfer removes the incomplete destination opened by that operation. Successful members of a multi-file transfer remain in place.

### Pi to ChatGPT

Omit `files` to export existing Pi files:

```json
{ "paths": ["build/output.zip", "renders/preview.png"] }
```

Chappie returns MCP resource links. ChatGPT retrieves the bytes when it materializes those resources, which can require user confirmation. A resource remains associated with the Pi session that exported it, so that Pi process and source file need to remain available until the bytes are read.

For a directory, create an archive with a Pi tool and export the resulting file.

### Pi to Pi

Supply `to` to copy files to another connected Pi session:

```json
{
  "sessionId": "<source-session>",
  "paths": ["build/output.zip"],
  "to": {
    "sessionId": "<destination-session>",
    "paths": ["downloads/output.zip"]
  }
}
```

Source and destination paths correspond by position. Each session resolves its own relative paths, absolute paths, and `~/`. Image references can also be copied. `files` and `to` select different sources and are mutually exclusive.

File chunks travel through the broker over the existing connections. The destination writes each file to a temporary sibling directory, then places the completed file at its requested path. `overwrite: true` replaces an existing destination. Cancellation or failure discards the incomplete file; successfully copied files remain available.

### Images

`read` and Pi tool results send images directly to ChatGPT for visual inspection. Chappie also returns a `chappie://` image reference with Pi images. Pass that reference to `transfer.paths` when the same bytes are needed as a file in ChatGPT's cloud environment.

Use the original local path with `transfer` when the original image file is required; Pi can resize or convert images used only for display.
