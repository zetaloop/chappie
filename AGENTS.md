# Chappie

Chappie is a single TypeScript Pi package that connects ChatGPT developer-mode tools to native Pi sessions.

## Architecture

The package has one extension entry point with two runtime roles. `pi --chappie` starts the MCP broker over stdio. An ordinary Pi process registers the `chappie/chatgpt` provider and connects its current session through `node:net`: locally through a Unix socket or Windows named pipe in Pi's agent directory, or through TCP when `connect` targets another device.

The broker owns ChatGPT conversation bindings, initialization cooldowns, MCP request routing, deferred-result descriptors, and resource dispatch. The Pi extension owns provider output, native tool execution, session input, branch history, cancellation, and the bytes behind exported resources.

One MCP tool request becomes one native Pi tool batch. A `call` array requests Pi's native batch execution explicitly; Chappie does not combine separate MCP requests. Requests are ordered within a Pi session, while different sessions operate independently.

`chat` completes one assistant turn. Remote work arriving while Pi is idle starts a new turn through an invisible custom control message that is removed from model context.

File bytes belong to the originating Pi session. Resource reads retain that ownership across conversation binding changes. Session-to-session copies use the existing broker connections so the devices only need to reach the broker.

`chappie.state.json` under Pi's agent directory stores conversation bindings, questions, and interrupted-result descriptors. Initialization cooldowns live in broker memory and are scoped to a ChatGPT conversation and Pi session. They address duplicate execution bursts during initialization or resumption after host-side widget and file interactions.

Native messages, tool results, and activity records stay in Pi's session transcript. History reads the current branch through an independent IPC request and returns original entry IDs and timestamps. Its response remains separate from input and pending-result delivery.

## Development

Use `pnpm format` and `pnpm check` during development. Version tags and manual release runs check the source and produce an npm package with a release draft. Publishing the draft runs the npm publishing workflow.
