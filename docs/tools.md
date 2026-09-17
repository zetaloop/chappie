# Tools

| Tool | Purpose |
|---|---|
| `init` | Select this ChatGPT conversation's default Pi session and read its environment. |
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
| `transfer` | Move files between ChatGPT and Pi or export a Pi image. |

## Sessions

Call `init` at the start of local work. Without `sessionId`, it reuses the conversation's saved default or selects an online Pi session with no saved ChatGPT binding. Pass a Pi session ID to resume a specific task, including from another ChatGPT conversation or branch.

`sessions` lists connected sessions with their ID, device, working directory, name, execution status, and binding count. The first session tool call establishes the default using its `sessionId` or an online session with no saved bindings. Once a default exists, another tool's `sessionId` selects only that operation's target; `init({ sessionId })` changes the default.

Several ChatGPT conversations can use the same Pi session. One conversation can also operate on several Pi sessions explicitly. Requests already assigned to a session continue there even if the conversation later changes its default.

Remote Pi sessions appear in the same list when they connect to a broker exposed through `listen` and `connect`. Their tools, global `AGENTS.md`, files, images, and Pi interfaces come from the remote device.

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

When enabled, `ask` creates a question in ChatGPT and returns its ID immediately:

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

### Images

`read` and Pi tool results send images directly to ChatGPT for visual inspection. Chappie also returns a `chappie://` image reference with Pi images. Pass that reference to `transfer.paths` when the same bytes are needed as a file in ChatGPT's cloud environment.

Use the original local path with `transfer` when the original image file is required; Pi can resize or convert images used only for display.
