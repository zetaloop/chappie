# Tools

ChatGPT uses the tools below. Agent sessions also provide [local tools](#local-tools).

| Tool       | Purpose                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `sessions` | Find connected devices and sessions by agent, directory, or name.            |
| `launch`   | Start an agent session in a new terminal on a connected device.              |
| `init`     | Select this ChatGPT conversation's default session and read its environment. |
| `tools`    | Read the selected session's native tool definitions.                         |
| `call`     | Execute a native tool batch.                                                 |
| `chat`     | Send an assistant message or answer a model request.                         |
| `history`  | Read a session's native records to identify its project and task.            |
| `transfer` | Exchange files and images with ChatGPT or another session.                   |

## Sessions

Use `sessions` to find candidates and `history` to match their recorded work to the task. `history` returns native conversation records as text, with attachment metadata.

Select the intended session with `init({ sessionId })`. This saves a default for the conversation; other tools use it unless given a `sessionId`. Several conversations can use the same session, and saved defaults survive broker restarts.

The list contains sessions using Chappie's Remote model. The `devices` array lists connected devices on which new sessions can be launched; `defaultSessionId` identifies this conversation's saved target.

The optional `activity` describes the current request: a `call` lists its tool names, `chat` sends an assistant message, and `generation` lists the kinds of text requested by the agent.

## Starting a session

Use `launch` when the user explicitly requests or agrees to creating a new session:

```json
{
	"device": "<device-id>",
	"agent": "pi",
	"cwd": "/path/to/project"
}
```

Choose `device` from the returned `devices` array. `agent` selects `pi`, `omp`, `opencode`, or `codex`. The working directory must exist; relative paths and `~/` start at the device's home directory.

The selected agent opens in a new terminal with Chappie's Remote model. The result's `session.id` identifies it for subsequent operations. Use `init` to select it as this conversation's default.

## Native tools

`init` includes a short tool catalog. When `globalAgents.path` is returned, read that file for the agent's instructions. Use `tools` for full definitions, optionally selected by name:

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

The agent schedules the tools within each batch. Separate requests are ordered within a session; different sessions can execute independently.

`call` also accepts `base64`: the same `calls` array serialized as UTF-8 JSON and encoded as Base64. Supply either representation, with `sessionId` outside the encoded array.

ChatGPT removes the middle of tool responses exceeding 10,000 tokens. Limit native tool output when needed.

## Messages

`chat` sends progress and completion messages to the selected session:

```json
{ "text": "Updated the parser and its callers." }
```

Messages and images entered in the agent arrive with later tool results. Results from interrupted calls may also arrive later; check them before repeating an operation.

When the agent requests a summary or title, the result includes its instructions and original input. Reply with `chat`, using the returned `request` ID as `replyTo`:

```json
{
	"sessionId": "<session-id>",
	"replyTo": "<request-id>",
	"text": "The requested summary."
}
```

A `call` made while a model request is pending returns `cancelled` without running. Reply to the request, then issue any calls still needed. The response to `chat` may include another request.

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

ChatGPT downloads the returned file links from the source session and may ask for approval.

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

Each side resolves paths on its own device. Completed files remain available if another file fails or the transfer is cancelled.

## Local tools

Every agent session provides `transfer`. Enable `localTools` in Chappie's configuration for the complete tool set:

| Tool              | Purpose                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `remote_sessions` | List connected devices and target sessions, with the caller's ID in `self`. |
| `remote_launch`   | Open a new agent session on a connected device.                             |
| `remote_tools`    | Read the target session's native tool definitions.                          |
| `remote_call`     | Execute a native tool batch in the target session.                          |
| `remote_chat`     | Send an assistant message or answer a model request in the target session.  |
| `transfer`        | Exchange files and attachments.                                             |

Select Chappie's Remote model in each target session. `remote_tools`, `remote_call`, and `remote_chat` take an explicit `sessionId`.

Use `remote_launch` as described under [Starting a session](#starting-a-session).

`transfer` uses local paths and exchanges files with targets through `from` and `to`. Supply `files` to import attachments.

Use `remote_tools` to discover a target's definitions, then `remote_call` to execute them. When `globalAgents.path` is returned, read that file for the target's instructions. `remote_chat` sends an assistant message to the target:

```json
{ "sessionId": "<target-session>", "text": "The build completed successfully." }
```

Supply `replyTo` to answer a model request with `remote_chat`, then submit the tools still needed with `remote_call`.
