# Setup and configuration

The broker is available as `chappie` after global installation. Agent plugins connect to it from their own devices.

## Codex

On the Codex device, install Chappie, create its model catalog, and add the plugin:

```sh
pnpm add -g @zetaloop/chappie@1
chappie codex setup
codex plugin marketplace add zetaloop/chappie
codex plugin add chappie@chappie
```

### Using an ordinary model

Enable `localTools` in Chappie's configuration. The installed plugin provides tools for working with other Chappie sessions.

### Using the Chappie model

To receive work in Codex, select Chappie in Codex's user configuration, `~/.codex/config.toml` or `$CODEX_HOME/config.toml`:

```toml
model_provider = "chappie"
model = "chatgpt"
model_catalog_json = "~/.chappie/codex.json"

[model_providers.chappie]
name = "Chappie"
base_url = "http://127.0.0.1:24275/v1"
```

Restart the Codex app after changing its provider configuration. The plugin starts the local provider service and refreshes the model catalog.

Start a new conversation or open an existing Chappie conversation to make it available to connected assistants. Existing conversations use their saved provider.

To start new conversations with an ordinary model, restore its model, provider, and catalog settings, then restart the app.

## Configuration

Settings live in `~/.chappie/config.json`. The broker and agent plugins read this file at startup; an absent file uses the defaults.

Agent plugins provide `transfer` in every session. Enable `localTools` for the complete [local tool set](tools.md#local-tools).

| Setting      | Default      | Used by       | Purpose                                                                    |
| ------------ | ------------ | ------------- | -------------------------------------------------------------------------- |
| `ask`        | `true`       | Broker        | Enable question widgets in ChatGPT.                                        |
| `cooldown`   | `20`         | Broker        | Participation window, in seconds.                                          |
| `listen`     | `false`      | Broker        | Accept TCP connections; `true` uses port `24274`, or supply a port number. |
| `connect`    | Local socket | Agent plugins | Broker hostname, optionally followed by `:port`.                           |
| `localTools` | `false`      | Agent plugins | Enable collaboration tools.                            |

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

| Setting           | Default                    | Purpose                                                      |
| ----------------- | -------------------------- | ------------------------------------------------------------ |
| `codex.port`      | `24275`                    | Local provider HTTP port.                                    |
| `codex.appServer` | Default CLI control socket | CLI app-server endpoint: `unix://<path>` or a WebSocket URL. |

When changing `codex.port`, update `model_providers.chappie.base_url` in Codex's configuration to match.
