# Chappie

Chappie connects ChatGPT and native coding-agent sessions. One TypeScript package contains the broker CLI and integrations for Pi, Oh My Pi, OpenCode, and Codex.

## Architecture

`Host` supplies native session data and execution callbacks. `Session` handles request ordering, provider output, input delivery, and file operations. Adapters translate native events and records into these shared structural interfaces.

The broker owns ChatGPT conversation bindings, participation guidance, pending results, questions, and resource routes. Agent sessions connect as requesters; those using the Chappie provider also register as targets. ChatGPT and local tools use the same session operations.

Requests are ordered per session, with execution inside a tool batch managed by the host. Host generation requests carry their original input through a separate output stream, allowing replies to arrive during an active operation.

Native transcripts remain in their host's storage and are read on demand. `Session` owns resource descriptors and their file pointers or image bytes; the broker routes reads to the producing connection, including unregistered requesters. Transfers use those connections so each device resolves its own paths.

Pi and OMP register native streaming providers. OpenCode's plugin and AI SDK provider share a session map. The Codex plugin owns a local Responses service. It controls desktop sessions through the App's collaboration IPC and CLI sessions through their app-server connection. Skill queries use an existing CLI connection or a short-lived native app-server process.

Configuration and persisted broker state live in `~/.chappie`. Session connections use Unix sockets or Windows named pipes locally and TCP across devices.

## Development

Use `pnpm format`, `pnpm check`, and `pnpm build`. The build bundles runtime dependencies and leaves host SDKs external so adapters share the host's runtime instances.

Version tags and manual release runs produce an npm archive and a release draft. Publishing the draft publishes that archive to npm.
