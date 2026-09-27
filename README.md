# Chappie

Use ChatGPT through Pi, Oh My Pi, OpenCode, or Codex. Run their native tools, work with local files, exchange images and artifacts, and move between sessions across devices.

## Setup

Install Chappie in the agent:

| Agent | Install |
|---|---|
| [Pi](https://github.com/earendil-works/pi) | `pi install npm:@zetaloop/chappie` |
| [Oh My Pi](https://github.com/can1357/oh-my-pi) | `omp plugin install @zetaloop/chappie` |
| [OpenCode](https://github.com/anomalyco/opencode) | `opencode plugin add @zetaloop/chappie` |
| [Codex](https://github.com/openai/codex) | See [Codex](#codex) below. |

Install the broker on the device running the tunnel:

```sh
pnpm add -g @zetaloop/chappie
```

Use `chappie` as the MCP command in [otunnel](https://github.com/zetaloop/otunnel):

```yaml
mcp:
  commands:
    - channel: main
      command: chappie
```

The same executable is available through `pnpx -y @zetaloop/chappie`.

Add the tunnel as a developer-mode app in ChatGPT. Select `chappie/chatgpt` in Pi, OMP, or OpenCode, or configure Codex as described below.

Call `init` from ChatGPT. `sessions` finds connected sessions by agent, device, directory, and name. An existing task can be resumed with its session ID from another chat or branch.

### Codex

Install the plugin from this repository's marketplace:

```sh
codex plugin marketplace add zetaloop/chappie
codex plugin add chappie@chappie
```

Save the [model catalog](src/codex.json) locally and reference its absolute path in Codex's user configuration, `~/.codex/config.toml` or `$CODEX_HOME/config.toml`:

```toml
model_provider = "chappie"
model = "chatgpt"
model_catalog_json = "/absolute/path/to/codex.json"

[model_providers.chappie]
name = "Chappie"
base_url = "http://127.0.0.1:24275/v1"

[mcp_servers.chappie]
command = "pnpx"
args = ["-y", "@zetaloop/chappie", "codex", "--chatgpt"]
env_vars = ["CODEX_HOME"]
```

Restart the Codex app after changing its provider configuration. The plugin starts its local Responses service and connects to Codex's app-server.

## Usage

`tools` returns the selected session's native tool definitions; `call` executes them. `chat` sends an assistant message, and local user input accompanies later results. `history` reads the agent's transcript, `transfer` moves files, and `ask` presents a question in ChatGPT.

See the [tool guide](docs/tools.md) for parameters and examples.

## Configuration

Settings live in `~/.chappie/config.json`. Local connections use the defaults when this file is absent.

A broker accepts sessions from other devices with:

```json
{ "listen": true }
```

On another device, point the agent's plugin to that broker:

```json
{ "connect": "<broker>.local" }
```

The default TCP port is `24274`. Set `listen` to a port number or append `:port` to `connect` to change it. All connected devices use the same session list and file transfer service.

Set `ask` to `false` to disable ChatGPT question widgets.

Ordinary models can access Chappie sessions with:

```json
{ "localTools": true }
```

This enables `sessions`, `remote_tools`, `remote_call`, `history`, and `transfer` for local collaboration. `history` can read the current session; remote operations name a session using the Chappie provider.

OpenCode discovers its local background service. For a standalone server, set `opencode.url` to its HTTP address and `opencode.password` when authentication is enabled.

Codex uses port `24275` for its local Responses service and the default app-server control socket. Use `codex.port` to change the Responses port and `codex.appServer` for an explicit `unix://<path>` or WebSocket URL. Set `model_providers.chappie.base_url` in Codex to match the Responses port.
