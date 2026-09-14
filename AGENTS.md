# Chappi

Chappi connects ChatGPT to sessions running through Pi. It is distributed as one TypeScript Pi package.

## Architecture

The extension factory provides two entry points from the same package. `pi --chappi` serves the MCP broker over stdio. A normal Pi process registers the Chappi provider and connects its current session to that broker through local IPC.

ChatGPT requests stay associated with their originating Pi session. Tools execute through Pi's native tool pipeline, and files use MCP resources and host file parameters.

## Development

Use `pnpm format`, `pnpm check`, and `pnpm verify` for the project workflow. Keep each commit focused on one complete behavior and update this document only for relationships that are not apparent from the code.
