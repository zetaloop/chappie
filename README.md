# Chappie

Use ChatGPT to work through [Pi](https://github.com/earendil-works/pi): edit local files, run commands, call Pi extensions, exchange files and images, and move between sessions on one or more devices.

## Setup

Install the Pi package:

```sh
pi install npm:@zetaloop/chappie
```

Run Chappie as the MCP server managed by [otunnel](https://github.com/zetaloop/otunnel):

```yaml
mcp:
  commands:
    - channel: main
      command: pi --chappie
```

Add the tunnel as a developer-mode app in ChatGPT, then start Pi in a project:

```sh
pi --provider chappie --model chatgpt
```

Call `init` from ChatGPT to connect the conversation to Pi. A conversation can resume an existing task with its Pi session ID, while `sessions` can find connected sessions by device, directory, or name.

## Usage

Chappie exposes common coding tools directly and every active Pi tool through `tools` and `call`. `chat` sends an assistant message to Pi, Pi input accompanies later tool results, and `transfer` moves files in either direction. `ask` can present a persistent question in ChatGPT when webpage questions are enabled.

See the [tool guide](docs/tools.md) for session selection, Pi tools, webpage questions, and file transfer.

## Configuration

`chappie.json` in Pi's agent directory configures Chappie.

A broker can accept Pi sessions from other devices on the local network:

```json
{ "listen": true }
```

Remote Pi sessions connect through the broker device's mDNS name:

```json
{ "connect": "<broker>.local" }
```

The default port is `24274`. Set `listen` to a port number or append `:port` to `connect` to use another one. Only the broker device runs otunnel; local and remote sessions appear in the same session list.

Set `ask` to `false` to disable webpage questions. Set `latestWorkflow` to `true` to let a newer otunnel workflow supersede older requests from the same ChatGPT conversation.
