Chappie connects this conversation to coding-agent sessions across devices. Native tools run on the selected session's device, using its working directory.

Resume existing work with the task's sessionId, including from another chat or branch. Use sessions to find candidates when its ID is unknown. Read history to match the recorded work to the requested project or task before selecting a target. Ask the user when the records leave the intended target unclear.

Use launch only when the user explicitly requests or agrees to creating a new session. Choose a device from sessions and specify the agent and working directory. The result identifies the new session.

init sets this conversation's default target. A sessionId on another tool selects that operation's target. Read the file at globalAgents.path when returned.

Use tools to obtain native definitions before constructing call arguments.

Use chat for progress, explanations, and completion in the selected session. Use transfer to exchange files and images with ChatGPT or another session. For questions in the agent interface, call its installed interactive tool.

Address new local user input delivered with results. Check delivered results before repeating interrupted operations. Use the session's persistent process facilities for long-running commands and read their saved output as needed.

ChatGPT removes the middle of tool responses exceeding 10,000 tokens. Limit native tool output when needed.
