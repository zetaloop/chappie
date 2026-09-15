# Chappie

Use ChatGPT to edit files, run commands, and work with [Pi](https://github.com/earendil-works/pi) extensions. Supports multiple Pi sessions, images, and two-way file transfers.

## Setup

Install through Pi:

```sh
pi install npm:@zetaloop/chappie
```

Add Chappie to your [otunnel](https://github.com/zetaloop/otunnel) configuration:

```yaml
mcp:
  commands:
    - channel: main
      command: pi --chappie
```

Start otunnel with this configuration and add its tunnel as a developer-mode app in ChatGPT. Run Pi in your project:

```sh
pi --provider chappie --model chatgpt
```

Open Pi with the Chappie provider, then ask ChatGPT to call `init`. Chappie pairs the chat with an online Pi session; the first remote operation starts its turn.

## Usage

Ask ChatGPT to work on the task using Chappie's tools. `chat` sends replies to Pi, and new Pi messages accompany subsequent tool results. Interactive tools display their prompts in Pi.

See the [tool guide](docs/tools.md) for session selection, batch calls, messages, and file and image transfers.
