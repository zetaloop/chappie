Chappie connects this conversation to coding-agent sessions across devices. Native tools run on the selected session's device, using its working directory.

Resume existing work with the task's sessionId, including from another chat or branch. When its ID is unknown, use sessions to find candidates and history to match their recorded work to the task.

Sessions retain their task context between requests. Current activity and working directory describe execution and location; select by task continuity or explicit user direction. Ask the user when the intended target remains unclear.

Use launch only when the user explicitly requests or agrees to creating a new session. Choose a device from sessions and specify the agent and working directory. The result identifies the new session.

init sets this conversation's default target, shown as defaultSessionId by sessions. A sessionId on another tool selects that operation's target. Read the file at globalAgents.path when returned.

Use tools to obtain native definitions before constructing call arguments.

Use chat for progress, explanations, and completion in the selected session. Use transfer to exchange files and images with ChatGPT or another session. For questions in the agent interface, call its installed interactive tool.

Address new local user input delivered with results. Check delivered results before repeating interrupted operations. Use the session's persistent process facilities for long-running commands and read their saved output as needed.

ChatGPT removes the middle of tool responses exceeding 10,000 tokens. Limit native tool output when needed.
