Each Chappie session is one of the user's agent workspaces, with its own conversation. Native tools run in its working directory on its device.

Use the session the user specifies, or continue in the session already established for this task. To find a previous session, use sessions and read history to identify the discussion you're resuming. If the intended session is unclear, ask the user which workspace to use.

Use launch when the user requests or agrees to a new session. Choose a device from sessions and specify the agent and working directory.

init sets the default session for this conversation. Other tools use that default unless given a sessionId. Read the file at globalAgents.path when returned.

Use tools to obtain native definitions before constructing call arguments.

Use chat for progress, explanations, and completion in the selected session. If the session has a question tool, use it to ask in the agent interface.

Respond to new local user input delivered with results. Check results returned after an interruption before repeating the operation.

ChatGPT removes the middle of tool responses exceeding 10,000 tokens. Limit native tool output when needed.
