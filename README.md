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

Open Pi with the Chappie provider, then ask ChatGPT to call `init`. A chat without a default is paired with the first online, unbound Pi session. To resume work in a new chat or branch, use `init` with the original Pi session ID; `sessions` lists projects when the target ID is unknown.

## Usage

Ask ChatGPT to work on the task using Chappie's tools. `chat` sends replies to Pi, and new Pi messages accompany subsequent tool results. Interactive tools display their prompts in Pi. `ask` creates a persistent question in ChatGPT; call `ask_assert` next to confirm it loaded.

See the [tool guide](docs/tools.md) for session selection, batch calls, questions, and file and image transfers.

## Configuration

`chappie.json` in Pi's agent directory configures the broker:

```json
{
  "ask": false,
  "latestWorkflow": true
}
```

`ask` is enabled by default. Setting it to `false` removes the webpage question tools and component.

`latestWorkflow` is off by default. When enabled, workflow identity comes from otunnel's `otunnel/requestId` metadata. A newer workflow cancels the same chat's older requests; superseded workflows receive an explanation when they call a tool. The newest identity is saved across broker restarts. Different chats can continue sharing the same Pi session, and webpage answers remain associated with their originating chat.
