# Chappie

Chappie connects ChatGPT to native coding-agent sessions. One TypeScript package contains the broker CLI and integrations for Pi, Oh My Pi, OpenCode, and Codex.

## Architecture

`Host` supplies native session data and execution callbacks. `Session` handles request ordering, provider output, input delivery, and file operations. Each adapter translates its host's events and messages into those shared interfaces.

The broker manages ChatGPT conversation bindings, initialization participation, pending results, questions, and resource routing. Each `call` array becomes one native tool batch. Separate requests are ordered per session; different sessions execute independently. `chat` produces an assistant message and completes a native turn.

Sessions using the Chappie provider register as addressable targets. Ordinary models with `localTools` connect as requesters. Their local tools use the same broker operations, with local history and files supplied by their host context.

Configuration and persisted broker state live in `~/.chappie`. Session connections use Unix sockets or Windows named pipes locally and TCP across devices. Files belong to the connection that produced their resource descriptors. Transfers reuse those connections, including when the source is an unregistered requester.

Native transcripts remain in their host's storage. History returns native IDs and recorded timestamps through an independent request. Its cursor is separate from input and pending-result delivery.

Pi and OMP register native streaming providers. OpenCode registers an AI SDK provider through native plugin hooks and reads complete transcripts through the host's HTTP API. The Codex plugin starts a local Responses service and joins native threads through app-server. Its control socket carries WebSocket traffic. The Codex MCP configuration invokes the same package by name and selects its Chappie-mode tool catalog.

## Development

Use `pnpm format`, `pnpm check`, and `pnpm build`. The build bundles runtime dependencies and leaves host SDKs external so adapters share the host's runtime instances.

Version tags and manual release runs produce an npm archive and a release draft. Publishing the draft publishes that archive to npm.
