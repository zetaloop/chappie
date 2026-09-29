# Chappie

Use ChatGPT to work through Pi, Oh My Pi, OpenCode, or Codex: edit projects, run commands, and exchange files and images. Agent sessions can also work with each other, on the same computer or across devices.

## Setup

Install Chappie in each participating agent:

| Agent                                             | Install                                          |
| ------------------------------------------------- | ------------------------------------------------ |
| [Pi](https://github.com/earendil-works/pi)        | `pi install npm:@zetaloop/chappie`               |
| [Oh My Pi](https://github.com/can1357/oh-my-pi)   | `omp plugin install @zetaloop/chappie`           |
| [OpenCode](https://github.com/anomalyco/opencode) | `opencode plugin add @zetaloop/chappie`          |
| [Codex](https://github.com/openai/codex)          | [Plugin and provider setup](docs/setup.md#codex) |

The broker connects these sessions to ChatGPT and to each other. Install it on one device:

```sh
pnpm add -g @zetaloop/chappie --config.minimum-release-age=0
```

## With ChatGPT

Run the broker through [otunnel](https://github.com/zetaloop/otunnel) with this MCP configuration:

```yaml
mcp:
  commands:
    - channel: main
      command: chappie
```

Add the tunnel as a developer-mode app in ChatGPT. Open a project in the agent with its Chappie model selected, then tell ChatGPT which project or session to use and what to do:

> Use \@Chappie to review the recent changes in the website project.

Tool activity and assistant messages appear in the agent's interface. Messages entered there reach ChatGPT with later tool results. Attach files in ChatGPT for the agent to use, or ask for generated files to be sent back.

To continue from another chat or branch, ask ChatGPT to reconnect to the same agent session.

## Between agents

An agent using its usual model can work through another agent session. For example, an assistant on macOS can run a build in a Windows session and retrieve the output files.

Start `chappie` in a terminal, or use the broker already running through otunnel. On the controlling agent's device, enable local tools in `~/.chappie/config.json`:

```json
{ "localTools": true }
```

Use the usual model in the controlling session and the Chappie model in the target session. Ask the controlling assistant to find that session and work on its project.

See [setup and configuration](docs/setup.md) for device connections and agent-specific settings, and the [tool guide](docs/tools.md) for the available operations and their parameters.
