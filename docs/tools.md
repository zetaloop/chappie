# Tools

ChatGPT uses the tools below. Agent sessions also provide [local tools](#local-tools).

| Tool       | Purpose                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `sessions` | Find connected devices and sessions by agent, directory, or name.            |
| `init`     | Select this ChatGPT conversation's default session and read its environment. |
| `tools`    | Read the selected session's native tool definitions.                         |
| `call`     | Execute a native tool batch.                                                 |
| `chat`     | Send an assistant message or answer a model request.                         |
| `history`  | Read a session's native records to identify its project and task.            |
| `transfer` | Exchange files and images with ChatGPT or another session.                   |

## Sessions

Use `sessions` to find candidates and `history` to identify the project and task recorded in each. Select the intended target with `init({ sessionId })`. When `globalAgents` is present, its path identifies the host's global instruction file.

`init` sets this conversation's default session, including when resuming work from another ChatGPT conversation or branch. Omitting `sessionId` reuses the existing default. Other tools use that default or an explicit `sessionId` for the current operation. Without a default, supply a session ID.

Several conversations can share a session, and one conversation can work with several sessions. An operation stays associated with the target selected when it started. Conversation bindings survive broker restarts.

`sessions` returns IDs, agents, devices, working directories, names, models, execution status, and binding counts. A session registers while its Chappie provider is selected. Devices using `listen` and `connect` share this directory of sessions.

The `devices` array lists each connected device's ID, name, and platform.

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

`chat` sends progress and completion messages to the selected session:

```json
{ "text": "Updated the parser and its callers." }
```

Local user input accompanies later results, including images. Completed output from an interrupted request can be delivered to its originating conversation with a later response.

A session can request generated text, such as a summary or title. The result includes a `request` ID, its `sessionId`, instructions, and the original input. Reply with `chat`:

```json
{
	"sessionId": "<session-id>",
	"replyTo": "<request-id>",
	"text": "The requested summary."
}
```

During a pending model request, `call` reports the batch as unexecuted with `cancelled` and an error status. Reply to the request, then submit the tools still needed. Each request has its own ID; a reply can include another request when the session needs several summaries.

ChatGPT removes the middle of tool responses exceeding 10,000 tokens. Limit native tool output when needed; local tools have no such response limit.

## History

`history` returns native session records as text, with attachments represented by their metadata. Pass `sessionId` to inspect a candidate, or omit it to read the default selected with `init`.

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

## Local tools

Every agent session provides `transfer`. Enable `localTools` in Chappie's configuration for the complete tool set:

| Tool              | Target                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| `remote_sessions` | Connected devices and sessions, with the current local ID reported as `self`. |
| `remote_tools`    | Tool definitions from the required `sessionId`.                               |
| `remote_call`     | One native tool batch in the required `sessionId`.                            |
| `remote_chat`     | An assistant message or model-request reply in the required `sessionId`.      |
| `transfer`        | Local files and resources exchanged with Chappie sessions.                    |

Select Chappie's Remote model in each target session. This supports agent-to-agent collaboration, such as building a project on another operating system.

`transfer` uses local paths and exchanges files with targets through `from` and `to`. Supply `files` to import attachments.

Use `remote_tools` to discover a target's definitions, then `remote_call` to execute them. When `globalAgents.path` is returned, read that file for the target's instructions. `remote_chat` sends an assistant message to the target:

```json
{ "sessionId": "<target-session>", "text": "The build completed successfully." }
```

Model requests include instructions naming the local tools. Supply `replyTo` to answer with `remote_chat`, then submit the tools still needed with `remote_call`. These operations use native session IDs, independently of ChatGPT conversation bindings.
