# Setup and configuration

The `chappie` command runs the broker and ChatGPT MCP server. When `connect` is configured, it runs as a client of that broker instead. Agent plugins also connect from their own devices.

## Codex

On the Codex device, install Chappie, create its model catalog, and add the plugin:

```sh
pnpm add -g @zetaloop/chappie --config.minimum-release-age=0
chappie codex setup
codex plugin marketplace add zetaloop/chappie
codex plugin add chappie@chappie
```

### Using an ordinary model

Enable `localTools` in Chappie's configuration. The installed plugin provides tools for working with other Chappie sessions.

### Using the Remote model

To let connected assistants launch Codex sessions, add Chappie's provider to `~/.codex/config.toml` or `$CODEX_HOME/config.toml`:

```toml
[model_providers.chappie]
name = "Chappie"
base_url = "http://127.0.0.1:24275/v1"
```

To use Remote by default in Codex, also add these settings at the top of the file:

```toml
model_provider = "chappie"
model = "remote"
model_catalog_json = "~/.chappie/codex.json"
```

Restart the Codex app after changing its provider configuration. The plugin starts the local provider service and refreshes the model catalog.

Start a new conversation or open an existing Chappie conversation to make it available to connected assistants. Existing conversations use their saved provider.

To start new conversations with an ordinary model, restore its model, provider, and catalog settings, then restart the app.

## Configuration

Settings live in `~/.chappie/config.json` and are read at startup.

Agent plugins provide `transfer` in every session. Enable `localTools` for the complete [local tool set](tools.md#local-tools).

| Setting      | Default      | Used by       | Purpose                                                                    |
| ------------ | ------------ | ------------- | -------------------------------------------------------------------------- |
| `listen`     | `false`      | Broker        | Accept TCP connections; `true` uses port `24274`, or supply a port number. |
| `connect`    | Local socket | Clients       | Broker hostname, optionally followed by `:port`.                           |
| `localTools` | `false`      | Agent plugins | Enable collaboration tools.                                                |

### Multiple devices

On the broker's device:

```json
{ "listen": true }
```

On each other device:

```json
{ "connect": "<broker>.local" }
```

Connected agents can discover Remote sessions and transfer files across devices.

Run `chappie` with `connect` configured to keep a device available independently of its agents.

### Starting sessions

A connected agent plugin makes its device available for starting sessions, including while using an ordinary model.

Session launching opens a terminal in the device's logged-in desktop. The selected agent and its Chappie integration must be installed. On Linux desktops, install `xdg-terminal-exec` for terminal launching.

### OpenCode

Chappie discovers OpenCode's local background service automatically. For a standalone server, set `opencode.url` to its HTTP address and `opencode.password` when authentication is enabled.

### Codex service

| Setting           | Default                    | Purpose                                                      |
| ----------------- | -------------------------- | ------------------------------------------------------------ |
| `codex.port`      | `24275`                    | Local provider HTTP port.                                    |
| `codex.appServer` | Default CLI control socket | CLI app-server endpoint: `unix://<path>` or a WebSocket URL. |

When changing `codex.port`, update `model_providers.chappie.base_url` in Codex's configuration to match.
