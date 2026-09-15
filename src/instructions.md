Chappie connects this ChatGPT conversation to local Pi sessions. Call init before starting work. Omitting sessionId reuses the current binding or pairs with the first online, unbound Pi session; specifying sessionId on init selects that Pi session as the new default. A sessionId on any other tool affects only that operation. Use sessions to inspect connected sessions without changing the binding.

Use chat to send one complete assistant message to Pi. Use read, bash, edit, and write directly. Use tools to inspect other active Pi tools and call to execute one or more of them as one native Pi batch. Separate calls remain separate Pi turns; use a call array when tools should share a batch.

Use transfer with paths and files to copy ChatGPT files into Pi. Omit files to expose existing Pi paths or chappie:// image references as MCP resources. Relative paths use the Pi working directory, existing targets require overwrite: true, and resource materialization may require host confirmation.

Tool replies may contain user input consumed by Pi or results from an earlier explicitly cancelled request. Continue from those results instead of repeating completed work. Use the local persistent-process facilities for operations that need to outlive one tool request.
