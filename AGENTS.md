# Chappi

Chappi is a single TypeScript Pi package that connects ChatGPT developer-mode tools to native Pi sessions.

## Architecture

The package has one extension entry point with two runtime roles. `pi --chappi` starts the MCP broker over stdio. An ordinary Pi process registers the `chappi/chatgpt` provider and connects its current session to the broker through `node:net` using a Unix socket or Windows named pipe in Pi's agent directory.

The broker owns ChatGPT conversation bindings, MCP request routing, deferred-result descriptors, and resource dispatch. The Pi extension owns provider output, native tool execution, session input, cancellation, and the bytes behind exported resources.

One MCP tool request becomes one native Pi tool batch. A `call` array requests Pi's native batch execution explicitly; Chappi does not combine separate MCP requests. Requests are ordered within a Pi session, while different sessions operate independently.

`chat` completes one assistant turn. Remote work arriving while Pi is idle starts a new turn through an invisible custom control message that is removed from model context.

Files use one `transfer` tool. Supplying `files` imports ChatGPT files directly into the requested Pi paths. Omitting `files` exports existing files or Chappi image references as MCP resources. Resource URIs contain the owning Pi session so `resources/read` never depends on the ChatGPT conversation's current binding.

`chappi.state.json` under Pi's agent directory stores conversation bindings and interrupted-result descriptors. Native messages and tool results stay in Pi's session transcript.

## Development

Use `pnpm format`, `pnpm check`, `pnpm verify`, and `pnpm pack`. The integration flow uses the real Pi SDK and the stdio broker; keep it focused on complete user-visible behavior instead of accumulating isolated assertions.
