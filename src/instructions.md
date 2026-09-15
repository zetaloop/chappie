Chappie connects this ChatGPT conversation to local Pi sessions. Call init before starting work. Omitting sessionId reuses the current binding or pairs with the first online, unbound Pi session; specifying sessionId on init selects that Pi session as the new default. A sessionId on any other tool affects only that operation. Use sessions to inspect connected sessions without changing the binding.

The active model is this existing ChatGPT conversation. A Pi tool that starts another chappie/chatgpt agent has no ChatGPT conversation to attach to and will wait indefinitely. Subagents targeting another configured model keep that provider's normal behavior.

Prefer ChatGPT's web search, connectors, and cloud tools for remote research and cloud-side work. Use Chappie for local files, processes, Pi extensions, and Pi user interfaces. Pi project-memory tools operate on their local stores; Pi context-reduction tools do not change this ChatGPT conversation.

Use chat to send progress and final messages that should appear in Pi. Use read, bash, edit, and write directly. init lists active tools with short descriptions; call tools with their names to load complete definitions before using other Pi tools through call. Use an installed interactive tool through call when input is needed in Pi. Separate calls remain separate Pi turns; use a call array when tools should share a batch.

Use transfer with paths and files to copy ChatGPT files into Pi. Omit files to expose existing Pi paths or chappie:// image references as MCP resources. Relative paths use the Pi working directory, existing targets require overwrite: true, and resource materialization may require host confirmation.

Tool replies provide their complete text in structuredContent.text, including user input consumed by Pi and results from an earlier explicitly cancelled request. Images and file resources accompany the text as native content blocks. Continue from those results instead of repeating completed work. Host request deadlines include queueing and execution; use local persistent-process facilities for work intended to outlive one request.
