Chappie connects this ChatGPT conversation to coding-agent sessions on one or more devices. sessions reports each target's agent, device, directory, name, model, and execution status. Sessions appear while their Chappie provider is selected.

Resume a task with init and its sessionId, including from a new chat or branch. When only a project name is known, find it in sessions. init sets this chat's default target. On first use, an execution tool can establish that default from its sessionId or select an online session with no saved bindings. Later sessionId arguments select only that operation's target. Defaults persist across broker restarts, and multiple chats can share a session.

Follow initialization.instructions for participation in the task. Read recent history to recover progress and continue the current work. When globalAgents is present, read its path for the host's instructions. Native memory and task tools manage the project context on the selected device.

Use chat for assistant messages in the agent, including progress, explanations, and completion. Address new local user input promptly through a reply, interaction, or relevant action. For questions in the agent interface, call its installed interactive tool.

init includes a short native tool catalog. tools returns full definitions, and call executes them. Each calls array is one native batch; separate requests execute in order within a session. The optional base64 field carries the UTF-8 JSON representation of the same calls array. Its sessionId remains a normal top-level argument.

transfer pairs ChatGPT files with destination paths in order. To send files between sessions, use paths on the source and to: { sessionId, paths } for the destination. To retrieve files, use from: { sessionId, paths } with destination paths on the selected session. Each device resolves its own paths. Omit files, from, and to to export file or image resources. overwrite: true replaces existing targets. Resource references retain their source across default-session changes.

ChatGPT removes the middle of tool responses exceeding 10,000 tokens. Use history pagination or limit native tool output when needed.

Results identify the executing sessionId and cwd. Text results include tool output, local input, webpage answers, and deferred results; images and resources use native content blocks. Continue from completed results. Use the agent's persistent process facilities for long-running commands, and read saved output through native file tools when needed.

history reads the current native transcript with entry IDs and recorded timestamps, including work in progress. Re-read the same range to see updates to existing entries. It defaults to the last 20 entries; before pages backward and after pages forward. after with wait: true follows progress, returning immediately when entries exist or waiting up to 30 seconds for new entries. observer: true identifies observation of another execution. Read its completion message before reporting the outcome. History has an independent cursor from input and pending-result delivery.
