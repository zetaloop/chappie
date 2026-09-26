# Tools

| Tool | Purpose |
|---|---|
| `sessions` | Find sessions by agent, device, directory, or name. |
| `init` | Select this ChatGPT conversation's default session and read its environment. |
| `tools` | Read the selected session's native tool definitions. |
| `call` | Execute a native tool batch. |
| `chat` | Send an assistant message and finish the native turn. |
| `history` | Read the agent's transcript with entry IDs and timestamps. |
| `transfer` | Exchange files and images with ChatGPT or another session. |
| `ask` | Create a persistent question in ChatGPT. |
| `ask_assert` | Confirm that its widget loaded. |

## Sessions

`init` accepts a `sessionId` to resume a task, including from another ChatGPT conversation or branch. Read recent `history` to recover its progress. When `globalAgents` is present, its path identifies the host's global instruction file.

Without `sessionId`, `init` reuses the saved default or selects an online session with no saved ChatGPT binding. The first execution tool can also establish a default. Once a default exists, another tool's `sessionId` selects only that operation's target; `init({ sessionId })` changes the default.

Several conversations can share a session, and one conversation can work with several sessions. An operation stays associated with the target selected when it started. Conversation bindings survive broker restarts.

`sessions` returns IDs, agents, devices, working directories, names, models, execution status, and binding counts. A session registers while its Chappie provider is selected. Devices using `listen` and `connect` share this directory of sessions.

## Native tools

`init` includes a short tool catalog. `tools` returns full definitions, optionally selected by name:

```json
{ "names": ["read", "bash"] }
```

Names and parameters come from the selected agent. For example, a Pi session accepts this batch:

```json
{
  "calls": [
    { "name": "read", "arguments": { "path": "package.json" } },
    { "name": "read", "arguments": { "path": "src/index.ts" } }
  ]
}
```

A `calls` array executes as one native batch. Separate requests are ordered within a session; different sessions can execute independently. Tools retain their host's execution, interaction, and transcript behavior.

`call` also accepts `base64`: the same `calls` array serialized as UTF-8 JSON and encoded as Base64. Supply either representation, with `sessionId` outside the encoded array.

`chat` produces a normal assistant message and completes the native turn:

```json
{ "text": "Updated the parser and its callers." }
```

Local user input accompanies later results, including images. Completed output from an interrupted request can be delivered to its originating conversation with a later response.

## History

`history` reads the native transcript using the saved default or an explicit `sessionId`:

```json
{ "sessionId": "<session-id>", "limit": 20, "before": "<entry-id>" }
```

The default is the latest 20 readable entries. `before` pages backward and `after` pages forward; both can delimit a range. Named entries are excluded from that range. Results follow transcript order, with native IDs and recorded timestamps. `hasMore` indicates more entries in the requested direction.

Use `after` with `wait: true` to follow progress. Available entries return immediately; at the end of the transcript the request waits up to 30 seconds, returning an empty page when no entries arrive. Reads with `before` return immediately.

History includes native messages, tool calls and results, summaries, images, and resource references. Reading it uses an independent cursor from local input and pending-result delivery.

### Participation

The executing assistant uses `chat` for progress and completion. When `initialization.instructions` assigns observation, read that work through `history` with `observer: true` and `wait: true`, then report its recorded outcome in ChatGPT.

## Files and images

`paths` names files on the selected session's device. Relative paths use its working directory; absolute paths and `~/` are accepted. Each transfer pairs source and destination paths by position.

### From ChatGPT

Pair destination paths with ChatGPT attachments:

```json
{
  "paths": ["assets/reference.png", "data/input.csv"],
  "files": ["/mnt/data/reference.png", "/mnt/data/input.csv"]
}
```

ChatGPT converts the attachment references into downloadable file objects. Chappie creates parent directories. `overwrite: true` replaces existing targets.

### To ChatGPT

Export files from the selected session:

```json
{ "paths": ["build/output.zip", "renders/preview.png"] }
```

The returned resource links identify the original session and file. ChatGPT retrieves their bytes through resource materialization, which may prompt for approval. The producing connection and source file provide those bytes even after the conversation changes its default session.

Native image results also carry `chappie://` references. Pass a reference to `transfer.paths` to retrieve those exact bytes, or use the original file path to export the source image.

### Between sessions

Send files using `to`:

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

Retrieve files using `from`:

```json
{
  "paths": ["downloads/output.zip"],
  "from": {
    "sessionId": "<source-session>",
    "paths": ["build/output.zip"]
  }
}
```

Both sides use their existing broker connections and resolve paths on their own devices. Different agents use the same transfer operations. Completed files remain available when another file in the batch fails or is cancelled.

## Local models

Enable `localTools` in Chappie's configuration to provide these tools to ordinary models:

| Tool | Target |
|---|---|
| `sessions` | Online Chappie sessions, with the current local ID reported as `self`. |
| `remote_tools` | Tool definitions from the required `sessionId`. |
| `remote_call` | One native tool batch in the required `sessionId`. |
| `history` | The current local transcript, or a Chappie session named by `sessionId`. |
| `transfer` | Local files and resources exchanged with Chappie sessions. |

Ordinary models use their existing provider for local work and connect as requesters. Chappie-model sessions are addressable targets. Local `history` and file operations use the host's current session context.

## Questions in ChatGPT

`ask` saves a question and requests its widget:

```json
{
  "header": "Export format",
  "question": "Which export format should the command use?",
  "options": [
    { "title": "JSON", "description": "Structured data for programs.", "recommended": true },
    { "title": "CSV", "description": "Tabular data for spreadsheets." }
  ]
}
```

Call `ask_assert` with the returned `question.id`. It confirms loading or marks the question skipped after 10 seconds. Native agent interaction tools are also available through `call`.

Answers, revisions, and skips arrive as `webAnswer` in later results. Omit `options` for a text answer; use `allowMultiple: true` for multiple choices. Questions persist across replies and broker restarts.
