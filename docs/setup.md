# Setup and configuration

The broker is available as `chappie` after global installation, or through `pnpx -y @zetaloop/chappie`. Agent plugins connect to it from their own devices.

## Codex

Install the plugin from this repository's marketplace:

```sh
codex plugin marketplace add zetaloop/chappie
codex plugin add chappie@chappie
```

### Using an ordinary model

Enable `localTools` in Chappie's configuration. The installed plugin provides tools for working with other Chappie sessions.

### Using the Chappie model

To receive work in Codex, save the [model catalog](https://raw.githubusercontent.com/zetaloop/chappie/main/src/codex.json) locally and reference its absolute path in Codex's user configuration, `~/.codex/config.toml` or `$CODEX_HOME/config.toml`:

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

Restart the Codex app after changing its provider configuration. The plugin starts the local provider service.

To return to an ordinary model, restore its model, provider, and catalog settings and remove the `[mcp_servers.chappie]` override shown above, then restart the app. The installed plugin supplies the local tools.

## Configuration

Settings live in `~/.chappie/config.json`. The broker and agent plugins read this file at startup; an absent file uses the defaults.

| Setting | Default | Used by | Purpose |
|---|---|---|---|
| `ask` | `true` | Broker | Enable question widgets in ChatGPT. |
| `cooldown` | `20` | Broker | Participation window, in seconds. |
| `listen` | `false` | Broker | Accept TCP connections; `true` uses port `24274`, or supply a port number. |
| `connect` | Local socket | Agent plugins | Broker hostname, optionally followed by `:port`. |
| `localTools` | `false` | Agent plugins | Provide collaboration tools to ordinary models. |

`cooldown` applies to each ChatGPT conversation and target session. Repeated initialization within the window returns [observation instructions](tools.md#participation). The window refreshes when a question widget first loads or a resource is accessed; `0` disables it.

### Multiple devices

On the broker's device:

```json
{ "listen": true }
```

On each other device:

```json
{ "connect": "<broker>.local" }
```

The default TCP port is `24274`. All connected agents share the session directory and file transfer service. Paths are resolved on their respective devices.

### OpenCode

Chappie discovers OpenCode's local background service automatically. For a standalone server, set `opencode.url` to its HTTP address and `opencode.password` when authentication is enabled.

### Codex service

| Setting | Default | Purpose |
|---|---|---|
| `codex.port` | `24275` | Local provider HTTP port. |
| `codex.appServer` | Default control socket | Codex app-server endpoint: `unix://<path>` or a WebSocket URL. |

When changing `codex.port`, update `model_providers.chappie.base_url` in Codex's configuration to match.
