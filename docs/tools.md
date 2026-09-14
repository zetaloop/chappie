# Tools

| Tool | Purpose |
|---|---|
| `init` | Connect to a Pi session and read its environment, tools, skills, global `AGENTS.md`, and pending input. |
| `sessions` | List connected Pi sessions and the chat's default session. |
| `tools` | Read the selected session's active tool definitions. |
| `chat` | Send an assistant message to Pi. |
| `call` | Run one or more tools as a Pi batch. |
| `read` | Read local text or images. |
| `bash` | Execute a shell command. |
| `edit` | Apply text replacements. |
| `write` | Write text to a file. |
| `transfer` | Copy files between ChatGPT and Pi, or export a Pi image as a file. |

## Sessions

Call `init` with `{}` to reuse the chat's session or pair with the next ready, unbound Pi session. Either side can arrive first. Sending a task in Pi starts its Chappie provider request.

`sessions` lists session IDs, working directories, names, and status. `ready` means the provider is accepting output, `executing` means Pi is handling an operation, and `idle` means the next operation will start a turn.

Use an ID from that list to select a default with `init`:

```json
{ "sessionId": "<session-id>" }
```

The optional `sessionId` on other tools selects a session for that operation. For example, `read` can inspect another project:

```json
{ "path": "package.json", "sessionId": "<session-id>" }
```

`sessions({ sessionId })` shows the selected session and retrieves available input and deferred results. It can be called while Pi is executing a tool batch.

Several chats can select the same Pi session, and one chat can address several sessions. Defaults are saved in `chappie.state.json` under Pi's agent directory. An existing binding waits for its Pi session to reconnect; `init` with another ID selects a different target.

## Tool calls

`read`, `bash`, `edit`, and `write` accept Pi's tool parameters plus `sessionId`. Their descriptions provide the current schemas. For installed extension tools, call `tools` and use the returned name and parameters in `call`.

A single tool uses a one-item `calls` array. To request a batch:

```json
{
  "calls": [
    { "name": "read", "arguments": { "path": "package.json" } },
    { "name": "read", "arguments": { "path": "src/index.ts" } }
  ]
}
```

Each batch returns its results together. Pi determines how its tools run within the batch. Separate calls run in order within one Pi session; different sessions can work independently.

Extension tools execute through Pi, including their interactive prompts. Results include each tool's name, call ID, error status, and original text or image content.

ChatGPT file inputs use the direct `transfer` tool. Its top-level `files` parameter lets the host prepare the files before sending them to Pi.

## Messages and interrupted calls

Call `chat` to display a reply in Pi:

```json
{ "text": "Updated the parser and its callers." }
```

Each call completes one assistant message. Later operations start another turn when Pi is idle. Use `chat` for text that should appear in Pi.

User messages consumed by Pi accompany later Chappie replies, including images. Steering is delivered when Pi consumes it; follow-up uses Pi's normal follow-up timing.

Explicit cancellation removes a queued request or asks Pi to stop its active batch. Available results from that batch accompany a later reply to the originating chat. `sessions` can retrieve them before another tool call. When ChatGPT stops without sending cancellation, local execution continues.

Host request deadlines include time spent in the queue. Use local facilities such as tmux for work intended to outlive one call.

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
