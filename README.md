# Chappi

Chappi connects ChatGPT developer-mode tools to local Pi sessions. ChatGPT provides the model context, while Pi provides the working directory, native tools, extensions, and user interface.

```text
ChatGPT ↔ OpenAI Tunnel ↔ otunnel ↔ pi --chappi ↔ local IPC ↔ Pi sessions
```

The npm package contains both sides of the bridge. `pi --chappi` serves the MCP broker over stdio for otunnel, and ordinary Pi processes load the same package as the `chappi/chatgpt` provider.

## Install

```sh
pi install npm:chappi
```

Configure otunnel to launch the broker:

```yaml
mcp:
  commands:
    - channel: main
      command: pi --chappi
```

Start Pi in the project directory with Chappi selected:

```sh
pi --provider chappi --model chatgpt
```

Send the task in Pi so the provider enters its ready state. In ChatGPT, enable the Chappi developer plugin and call `init`. Either side may arrive first; Chappi pairs an unbound ChatGPT conversation with the next ready Pi session.

## Sessions

Chappi associates the ChatGPT `openai/session` metadata with Pi's native session ID.

- `init()` reuses the current binding or pairs with a ready Pi session.
- `init({ sessionId })` changes the conversation's default Pi session.
- `sessionId` on any other tool selects a Pi session for that operation only.
- `sessions` lists connected sessions and reports the current binding.
- Multiple ChatGPT conversations may use one Pi session, and one conversation may address multiple Pi sessions explicitly.

Bindings and interrupted-result descriptors are stored in `chappi.state.json` under Pi's agent directory. Tool messages and results remain in the native Pi session transcript.

## Tools

| Tool | Purpose |
|---|---|
| `init` | Connect the ChatGPT conversation and return the Pi environment, current task, global `AGENTS.md`, tools, and skills. |
| `sessions` | Inspect connected Pi sessions and the current binding. |
| `tools` | Read the active tool catalog for a Pi session. |
| `chat` | Send one complete assistant message to Pi. |
| `call` | Execute one or more tools as one native Pi tool batch. |
| `read`, `bash`, `edit`, `write` | Call Pi's standard coding tools directly. |
| `transfer` | Move files between ChatGPT and Pi. |

A `call` array is the explicit way to request a parallel native batch. Separate MCP calls remain separate Pi turns and run in order within a session. Different Pi sessions can execute independently.

All tools run through Pi's native pipeline, including extension tools such as interactive prompts and memory tools. Chappi does not reimplement their execution or interfaces.

## Messages and cancellation

Each `chat` call creates one complete Pi assistant message. A later remote operation starts another provider turn through an invisible control message.

Pi user input consumed during a run is included in the next Chappi reply. Steering therefore reaches ChatGPT with the batch that consumed it, while follow-up messages retain Pi's native follow-up timing.

When an MCP request explicitly ends, Chappi removes a queued request or asks Pi to stop its active batch. Results already recorded by Pi are associated with the originating ChatGPT conversation and appear in a later Chappi reply. Requests that end without an explicit cancellation are treated as delivered.

## Files and images

To copy ChatGPT files into Pi, provide matching `paths` and `files` arrays:

```json
{
  "paths": ["assets/reference.png", "C:/Tmp/input.zip"],
  "files": ["/mnt/data/reference.png", "/mnt/data/input.zip"]
}
```

The ChatGPT host converts the cloud paths into file objects before Chappi receives the call. Relative paths resolve from the Pi working directory; absolute paths and `~/` are accepted. Existing targets cause an error unless `overwrite: true` is explicit. Downloads write directly to the requested destination without a staging directory.

To expose existing Pi files to ChatGPT, omit `files`:

```json
{
  "paths": ["build/output.zip", "/tmp/preview.png"]
}
```

Chappi returns MCP resource links. The host retrieves their bytes through `resources/read`, independently of the conversation's current default binding.

Images produced by Pi remain native image content for model vision and also receive a `chappi://` reference. Passing that reference to `transfer` exposes the same image bytes as a file resource.

## Development

```sh
pnpm format
pnpm check
```

Release verification uses `pnpm verify` for the local broker and Pi SDK integration, and `pnpm verify-package` for loading the npm tarball through Pi.

## Release

A `vX.Y.Z` tag runs verification on Linux, macOS, and Windows, packages the npm archive, and creates a release draft. Manual release runs offer `dryrun` artifacts or a `draft` for the selected tagged commit.

Publishing the draft runs `publish.yml`, which publishes to npm through Trusted Publishing using the `release` environment. The publish workflow also accepts a release tag for manual execution.
