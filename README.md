# pi-auto-model-router

Scores requests with Jev or an LLM judge and routes work to configured worker models and thinking levels. The parent model stays selected, simple requests can stay in the parent chat, and independent tasks can use multiple workers.

## Install

Choose one installation source.

```text
pi install npm:pi-auto-model-router
pi install git:github.com/dev-willbird1936/pi-auto-model-router
```

Restart Pi, or run `/reload` in an existing session.

The router starts **off** with an empty profile. Open `/auto-router-config`, add models, then `/auto-router on`.

## What it does

Each prompt is scored, then mapped to a model and thinking level from the active profile. The parent model is not switched. Work that needs another model is sent to a `worker` subagent; the parent summarizes.

None/minimal work stays in the chat. Independent tasks can split across workers.

Scoring uses TypeSafe Jev when a key is present. If the key is missing or Jev fails, the prompted model scores the request. `/auto-router-jev off` uses that LLM judge only.

Reference: [HOW.md](HOW.md).

## Commands

| Command | Effect |
|---|---|
| `/auto-router [on\|off\|status\|<profile>]` | Toggle, status, or switch profile. Bare toggles on/off |
| `/auto-router-config` | Interactive settings |
| `/auto-router-profile [list\|new\|clone\|delete]` | Manage profiles |
| `/auto-router-jev [on\|off\|status]` | Jev scoring (default on) |
| `/auto-router-split [on\|off\|status]` | Split check (default on) |
| `/auto-router-override` | Force model or thinking |
| `/auto-router-debug [on\|off]` | Attach decision details |

## Requirements

- Node.js `>=22.19.0`
- Pi Coding Agent `>=0.84.0`
- A Pi session with the `subagent` tool and a `worker` agent. Neither is bundled. Without that tool, routing does not dispatch; the parent stays on the current model.

Optional TypeSafe key: `TYPESAFE_API_KEY` or `~/.brain/secrets/typesafe-api-key.txt`.

## Configuration

`~/.pi/agent/pi-auto-router.json` is created on first run.

`/auto-router-config` edits enabled state, judge, split check, Ultra thinking, debug, overrides, and per-tier models. `Esc` saves. `Ctrl+C` cancels.

## Development

```text
npm run check
```

`setup.bat` / `launch.bat` and `bun web/server.ts` are checkout helpers. They are not in the npm package.

By [dev-willbird1936](https://github.com/dev-willbird1936).
