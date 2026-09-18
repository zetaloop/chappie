# Chappie

Chappie is a single TypeScript Pi package that connects ChatGPT developer-mode tools to native Pi sessions.

## Architecture

The package has one extension entry point with two runtime roles. `pi --chappie` starts the MCP broker over stdio. An ordinary Pi process registers the `chappie/chatgpt` provider and connects its current session through `node:net`: locally through a Unix socket or Windows named pipe in Pi's agent directory, or through TCP when `connect` targets another device.

The broker owns ChatGPT conversation bindings, initialization cooldowns, MCP request routing, deferred-result descriptors, and resource dispatch. The Pi extension owns provider output, native tool execution, session input, branch history, cancellation, and the bytes behind exported resources.

One MCP tool request becomes one native Pi tool batch. A `call` array requests Pi's native batch execution explicitly; Chappie does not combine separate MCP requests. Requests are ordered within a Pi session, while different sessions operate independently.

`chat` completes one assistant turn. Remote work arriving while Pi is idle starts a new turn through an invisible custom control message that is removed from model context.

Files use one `transfer` tool. Supplying `files` imports ChatGPT files directly into the requested Pi paths. Supplying `to` copies source files or image references to another Pi session through broker-relayed IPC requests. The destination pulls bounded resource chunks and installs each completed file from a temporary sibling directory. Omitting both exports existing files or Chappie image references as MCP resources. Resource URIs contain the owning Pi session so `resources/read` never depends on the ChatGPT conversation's current binding.

`chappie.state.json` under Pi's agent directory stores conversation bindings, questions, and interrupted-result descriptors. Initialization cooldowns live in broker memory and are scoped to a ChatGPT conversation and Pi session. Widget loading and resource reads also start cooldowns. Exported resource links carry the receiving conversation ID; file bytes remain associated with the owning Pi session.

Native messages, tool results, and activity records stay in Pi's session transcript. History reads the current branch through an independent IPC request and returns original entry IDs and timestamps. Its response remains separate from input and pending-result delivery.

## Development

Use `pnpm format` and `pnpm check` during development. Version tags and manual release runs check the source and produce an npm package with a release draft. Publishing the draft runs the npm publishing workflow.
