# Chappi

Use ChatGPT with [Pi](https://github.com/earendil-works/pi)'s local tools and extensions.

## Setup

Install through Pi:

```sh
pi install npm:chappi
```

Add Chappi to your [otunnel](https://github.com/zetaloop/otunnel) configuration:

```yaml
mcp:
  commands:
    - channel: main
      command: pi --chappi
```

Start otunnel with this configuration and add its tunnel as a developer-mode app in ChatGPT. Run Pi in your project:

```sh
pi --provider chappi --model chatgpt
```

Send a task in Pi, then ask ChatGPT to call `init`. Chappi pairs the chat with a ready Pi session.

## Usage

ChatGPT can run Pi's coding tools, call installed extension tools, and send replies to Pi through `chat`. `tools` lists the active tool catalog; `call` accepts an explicit batch.

`sessions` lists connections. `init({ sessionId })` changes the chat's default session; `sessionId` on other calls selects a session for that operation. New Pi messages and results from canceled calls accompany later tool replies.

## Files

`transfer` copies files in either direction. Import from ChatGPT into Pi:

```json
{ "paths": ["assets/reference.png"], "files": ["/mnt/data/reference.png"] }
```

Export from Pi to ChatGPT:

```json
{ "paths": ["build/output.zip"] }
```

Relative paths use Pi's working directory; absolute paths and `~/` work too. Existing targets require `overwrite: true`.

`read` displays images. Pass an image's `chappi://` reference to `transfer` to provide it as a file in ChatGPT. File resources may prompt for confirmation in ChatGPT.
