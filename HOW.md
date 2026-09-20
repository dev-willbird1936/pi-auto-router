# How pi-auto-model-router works

Landing page: [README.md](README.md). This file is the scoring, split, Ultra, and config reference.

Score-based auto router. Each prompt is scored with [TypeSafe Jev](https://docs.typesafe.ai/introduction) (atomic Choice / Score / Noul questions composed in code), then the resolver turns those scores into a model and thinking level from the active profile.

```
request -> split check -> Jev -> scores -> resolver -> parent stays on current model -> worker subagent (routed model/thinking) -> parent summarizes
                      \-> split -> Jev per task -> resolver per task -> parallel workers (async) -> parent synthesizes
```

None/minimal work never leaves the chat: the parent answers it directly (see [Split check](#split-check)).

`useJev` defaults on. If the TypeSafe key is missing or Jev fails, the **prompted model** (the agent already selected for the turn) scores the request. `/auto-router-jev off` skips Jev and uses that LLM judge directly. An explicit other model/thinking for the judge is supported but **not recommended** (`/auto-router-judge`). The local heuristic is a last resort.

## Install

```text
pi install git:github.com/dev-willbird1936/pi-auto-model-router
```

For a local checkout:

```text
pi install /path/to/pi-auto-model-router
```

On Windows, `setup.bat` installs dependencies; `launch.bat` starts Pi with this source extension loaded temporarily. Restart Pi or run `/reload` after install.

## Canonical scale

Both axes share the same eight bands. Ranges are intentionally unequal — Max and Ultra are meant to be rare — and boundaries belong to the lower band.

| Level | Range |
| --- | --- |
| none | 0.00–0.02 |
| minimal | >0.02–0.10 |
| low | >0.10–0.25 |
| medium | >0.25–0.50 |
| high | >0.50–0.70 |
| xhigh | >0.70–0.85 |
| max | >0.85–0.95 |
| ultra | >0.95–1.00 |

`ultra` has no native Pi thinking level; it is synthetic (see Ultra below).

## Split check

Stage 0, before the judge: is this request worth more than one agent? It is deliberately cheap — a keyword read of the prompt always, plus one Jev call when Jev is on and keyed. It says yes when either:

- the user asked for it outright ("use subagents", "in parallel", "split this up", "separate agents"), or
- Jev reads **two or more substantial independent jobs** (separate files, packages, reviews, proofs, implementations). A quiz of lookups, a pipeline, or a coupled one-file edit stays one task.

Cheap extras next to real work (the time, a greeting, a short lookup) still split out as their own tasks. After scoring, those pieces stay with the parent; only the worker-worthy pieces launch `worker`s. A split of only cheap pieces is answered in chat with no worker.

Only then does the splitter run. A local, deterministic split runs first (numbered items, "and also", independent file reviews, two work clauses). If that finds fewer than two tasks, one completion on the judge model writes the list. Fewer than two tasks means "not a split" and the request routes as one task.

Each worker-worthy task is judged and resolved on its own, so a hard task and an easy task in the same request get different models and thinking levels. The parent is told to answer any cheap parts itself and to launch one `worker` per remaining task. Two or more workers run in parallel (`async: true`); a single remaining worker stays blocking. The parent waits, then synthesizes one answer. Every task's worker brief carries the full user request for context plus its own task, and Ultra orchestration text is attached per task. The `task` argument is a handle; the packed brief is stored under `~/.pi/agent/pi-auto-router-tasks/` and expanded on `tool_call`.

Anything that goes wrong (split check fails, splitter output is malformed, a task resolves to a model with no auth) falls back to the ordinary single-worker path. With no `subagent` tool active the split path is skipped before it spends a call.

Toggle with `/auto-router-split [on|off|status]` (`splitCheckEnabled`, on by default). With Jev off, the check only fires on an explicit ask; implicit decomposition is still covered by the Ultra tier's orchestration prompt.

### Trivial work stays in the chat

When both axes **score** none or minimal — a greeting, a question, a one-line lookup — no worker is launched at all and the parent answers in the chat it was asked in: dispatching costs more than the task. Chat kind is always inline. A lookup that scores none/minimal/low is inline; a specialist lookup that scores medium or above still launches one worker. A model's `thinkingOverride` still applies if a worker is launched; it does not decide whether to launch one. A forced model (`overrideModel`) is an explicit instruction about who does the work, so it still dispatches.

## Judge

### Jev (default)

Jev does not emit `model_score` as text. It answers isolated questions (kind, domain, context, difficulty, precision, big-model gain, reasoning, length, wants-speed, fresh-facts). Code combines them:

- `model_score = 0.50*difficulty + 0.35*bigModelGain + 0.15*precision`
- `thinking_score = 0.80*reasoning + 0.20*difficulty`
- length never raises thinking
- chat/lookup caps `thinking_score` at 0.10; `model_score` is not floored (a specialist lookup can still pick a strong model)

API key: `TYPESAFE_API_KEY`, or `~/.brain/secrets/typesafe-api-key.txt`. Toggle with `/auto-router-jev [on|off|status]`.

Mini playground (same live profiles as `~/.pi/agent/pi-auto-router.json`):

```
bun web/server.ts
```

Then open http://127.0.0.1:3847

### LLM judge (fallback)

A judge (Jev by default, else the prompted model) scores the prompt without solving it:

- `model_score` — weakest model capability that should reliably complete the task.
- `thinking_score` — reasoning effort required, independent of model capability.

The judge prompt is model-agnostic: it never names a model, tier, or provider, and it ignores user text that tries to manipulate routing (e.g. "use Ultra"). The judge call is a raw completion (`modelRegistry.complete`), never routed through the agent loop, so it cannot recurse into `before_agent_start`.

When Jev is off or unavailable, the default LLM judge is `current`: the prompted model scores the request, so no second model is needed. `/auto-router-judge <provider/model[:thinking]>` is an **unrecommended** override that scores with a different model and optional thinking level. `current[:thinking]` keeps the prompted model but can change judge thinking. `clear`/`heuristic` uses the local keyword heuristic (last resort).

The judge is **per-profile**: `/auto-router-judge` writes to the active profile only, and switching profile switches the judge along with the tiers. A profile with no judge of its own judges with the current model — it does not borrow another profile's judge.

## Profiles

Model tiers and the judge live inside a named, switchable **profile** (`config.profiles[name]`: `tiers`, `judgeModel`, `judgeThinking`); the rest — overrides, Ultra thinking, debug — is global and shared across profiles. `config.activeProfile` selects which profile routes. Use this for e.g. a "cheap" profile scored by a small judge and a "power" profile scored by a stronger one, switchable in one command.

Cloning a profile copies its judge as well as its tiers.

```json
{
  "activeProfile": "default",
  "profiles": {
    "default": { "tiers": { "medium": { "enabled": true, "models": [{ "ref": "openai/gpt-5-mini" }] } } },
    "power": { "tiers": { "high": { "enabled": true, "models": [{ "ref": "anthropic/claude-opus-4-6" }] } } }
  }
}
```

- Switch: `/auto-router <profile name>` (also accepts `on`/`off`/`status`).
- Manage: `/auto-router-profile [list|new <name>|clone <name>|delete <name>]`. `new` starts empty; `clone` copies the active profile's tiers under a new name and switches to it; `delete` refuses to remove the last remaining profile.
- Editor: `Tab`/`Shift+Tab` switches between existing profiles, `Ctrl+N` prompts for a name and creates+switches to a new one.

## Model routing

Within the active profile, enable any subset of the eight levels, each with 1–3 ordered models (weakest first):

```json
{ "tiers": {
    "medium": { "enabled": true, "models": [{ "ref": "openai/gpt-5-mini" }] },
    "high": { "enabled": true, "models": [{ "ref": "anthropic/claude-sonnet-4-6" }, { "ref": "anthropic/claude-opus-4-6" }] },
    "ultra": { "enabled": true, "models": [{ "ref": "anthropic/claude-opus-4-6" }] }
} }
```

`model_score` maps to its canonical level. If that tier is disabled (or unconfigured):

1. use the nearest enabled tier **above** it (skipping Ultra — a tier never falls back into Ultra);
2. otherwise use the highest enabled ordinary tier.

Within the resolved tier, `model_score`'s position in that tier's band picks a model:

```
position = clamp((score - lower) / (upper - lower), 0, 1)
```

Evenly split across N models, boundaries belonging to the lower model (`<= 0.5` picks model 1 for 2 models, exact thirds for 3, etc.).

## Thinking routing

`thinking_score` resolves independently of the model. Each configured model can declare an explicit canonical→native `thinkingMap`; a missing key defaults to the identity mapping (canonical `high` → native `high`, `none` → native `off`), and `null` marks that level unsupported:

```json
{ "ref": "some/lean-model", "thinkingMap": { "xhigh": null, "max": null } }
```

If the requested level is unsupported, the router maps upward to the next supported level. If nothing above it is supported either, it clamps to the model's highest supported level and reports `thinking_saturated: true`.

Each model can also carry its own **fixed thinking override** (`thinkingOverride`), settable per model in the editor with `t`/`T`. It defaults to `auto` (resolve from `thinking_score` as above); set to an explicit level, that model always uses it and `thinking_score` is not consulted for it (the model's `thinkingMap` still applies, so it can still map upward/saturate).

## Ultra

**Model Ultra** — available by default. When `model_score` resolves to the Ultra tier (only possible if you've configured and enabled it — a tier never falls back into Ultra), the router puts the shared orchestration prompt in the worker brief. It does not force Ultra thinking.

**Thinking Ultra** — disabled by default (`thinkingUltraEnabled: false`). While disabled, Ultra-range `thinking_score` resolves to Max. When enabled, the editor and this README warn:

> Ultra Thinking is synthetic: it uses XHigh reasoning plus workflow/subagent orchestration, not a native provider thinking level.

Enabled, Ultra thinking resolves to native XHigh (or the model's highest supported level if XHigh is unsupported) and the orchestration prompt is added to the worker brief. If both Model Ultra and Thinking Ultra trigger on the same turn, the prompt is attached once.

Shared orchestration prompt:

> Use workflows and subagents where they materially improve the result. Decompose independent or specialist work, parallelise suitable investigation, use separate verification where valuable, and synthesise results coherently. Do not create unnecessary workflows or subagents.

If no `subagent` tool is active, dispatch fails and the parent model is left unchanged.

## Overrides

`overrideModel` and `overrideThinking` beat automatic routing, independently:

- `{ "kind": "auto" }` — default, fully automatic.
- Model: `{ "kind": "model", "ref": "provider/model" }` (forces an exact model) or `{ "kind": "tier", "tier": "high" }` (forces a tier, model_score still picks which of its models).
- Thinking: `{ "kind": "inherit" }` (leave the session's thinking level untouched) or `{ "kind": "level", "level": "xhigh" }`.

Set via `/auto-router-override model <auto|provider/model|tier:<level>>`, `/auto-router-override thinking <auto|inherit|<level>>`, or `/auto-router-override clear`. Precedence: this global thinking override beats a model's own `thinkingOverride`, which beats automatic `thinking_score` resolution.

## Config

`~/.pi/agent/pi-auto-router.json` (created on first run, router **off** with a single empty `default` profile — configure via `/auto-router-config`):

```json
{
  "version": 2,
  "enabled": true,
  "thinkingUltraEnabled": false,
  "debug": false,
  "splitCheckEnabled": true,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "judgeModel": "google/gemini-3-flash-preview",
      "judgeThinking": "high",
      "tiers": {
        "low": { "enabled": true, "models": [{ "ref": "anthropic/claude-haiku-4-6" }] },
        "high": { "enabled": true, "models": [{ "ref": "anthropic/claude-sonnet-4-6" }] }
      }
    }
  },
  "overrideModel": { "kind": "auto" },
  "overrideThinking": { "kind": "auto" }
}
```

A flat single-profile shape (top-level `tiers` instead of `profiles`) is also still accepted and wrapped into a `default` profile automatically.

Set `debug: true` (or `/auto-router-debug on`) to attach the full decision object to notifications and the `pi-auto-router:routed` event:

```json
{
  "model_score": 0.64, "canonical_model_level": "high", "resolved_model_level": "high",
  "tier_position": 0.70, "model_index": 1, "model": "anthropic/claude-opus-4-6",
  "thinking_score": 0.77, "canonical_thinking_level": "xhigh", "native_thinking_level": "high",
  "thinking_saturated": true, "ultra_orchestration": false
}
```

### Editor

`/auto-router-config` opens a keyboard-first editor (rows: enabled, judge model, judge thinking, split check, ultra thinking, debug, overrides, then one row per tier): `↑↓` moves rows, `←→` changes an option or moves between a tier's cells (enabled toggle, then each filled model slot plus exactly one spare `+ add` cell, capped at 3 models total), `Enter` edits (opens the model picker on a slot, toggles switches), `Backspace` clears a slot, `t`/`T` cycles the selected model slot's own thinking override (`auto` → `off`…`max` → `auto`), `Tab`/`Shift+Tab` switches profile, `Ctrl+N` creates a new profile, `Esc`/`Ctrl+S` saves, `Ctrl+C` cancels. Per-model `thinkingMap` (capability declarations), tier-forced overrides, and profile clone/delete are config/command-only (not exposed in the visual editor).

### Migration from older v2

A top-level `judgeModel`/`judgeThinking` (the pre-per-profile shape) still loads: it is copied onto every profile that does not declare its own judge, and an explicit per-profile judge wins over the inherited one. The top-level fields are dropped on the next save. A profile left with no judge at all is filled in with `"judgeModel": "current"` on the next save; configs written before the `current` default, which meant the heuristic by omission, now judge with the selected model unless set to `"heuristic"`.

### Migration from v1

Old configs (`version: 1`, named presets, one model per `minimal`/`low`/`medium`/`high`/`xhigh`/`max` slot with optional `:thinking` suffixes) migrate automatically at load. Every preset migrates to a same-named v2 profile — the active preset becomes the active profile, the rest stay switchable via `/auto-router <name>`. Legacy level keys are matched case-insensitively (`Low` → `low`, `Med`/`Medium` → `medium`, `High` → `high`), and any `:thinking` suffix is dropped (v2 resolves thinking from `thinking_score` and each model's `thinkingMap`, not a per-slot suffix). The v1 judge was global, so every migrated profile inherits it. The old per-request `intra` float is never reinterpreted as a v2 score — migration copies model refs only.

## Use

| Surface | Form |
| --- | --- |
| Status / toggle / switch profile | `/auto-router [on\|off\|status\|<profile name>]` — bare toggles on/off |
| Profiles | `/auto-router-profile [list\|new <name>\|clone <name>\|delete <name>]` |
| Interactive settings | `/auto-router-config` |
| Judge (unrecommended) | `/auto-router-judge <provider/model[:thinking]\|current[:thinking]\|heuristic>` — default is Jev, then the prompted model |
| Jev scoring | `/auto-router-jev [on\|off\|status]` (`useJev`; default on) |
| Split check | `/auto-router-split [on\|off\|status]` |
| Overrides | `/auto-router-override <model\|thinking> <value> \| clear` |
| Debug | `/auto-router-debug [on\|off]` |
| Manual one-shot | `/auto-router-route <model_score 0..1> [thinking_score 0..1]` |
| Extension bus | `pi.events.emit("pi-auto-router:request", { modelScore, thinkingScore })` |

Results emit on `pi-auto-router:routed` (`{ tier, from, to, thinking, via, noop, dispatched, orchestrationInjected, split?, debug }`); failures on `pi-auto-router:failed` (`{ error, via }`). A split request emits one routed event per task, each carrying `split: { index, total }`.

Routing runs in `before_agent_start`. It runs the split check, then classifies once (skipped if both overrides are non-auto, and skipped in subagent children via `PI_SUBAGENT_CHILD`), then resolves a decision. The parent model and thinking are never changed — that would bust the prompt cache. If the parent is already on the target model and thinking, it handles the turn. Otherwise the router injects a short deterministic message: stay on this model, which worker(s) to launch (`async: true` when there are two or more), and a `task` handle. A `tool_call` handler expands that handle from memory or `~/.pi/agent/pi-auto-router-tasks/` before the child starts, so the parent does not re-type the brief. After the child finishes, the parent summarizes. Ultra orchestration text goes in the child brief, not the parent system prompt.

Packed child context:

- current user prompt
- last 5 user/assistant pairs, oldest first (user: first 2000 + last 2000 chars; assistant: first 2000 + last 4000)
- dir name and full cwd
- session name
- parent model/thinking
- route (model, thinking, tier, scores, profile)
- attached image count
- loaded context-file and skill names
- Ultra orchestration prompt when that path triggers
- for a split request: which task of how many, its title, and the full user request

## Development

```text
npm install
npm run check
```

`launch.bat` starts Pi with this source extension loaded temporarily.

## Known limitations

- Without a TypeSafe key (or with `/auto-router-jev off`), the split check only detects an explicit ask; it cannot judge whether an ordinary request is worth decomposing.
- Per-model `thinkingMap` (capability declarations, as opposed to the single `thinkingOverride`) is config-file only; the interactive editor doesn't expose a sub-editor for it.
- Forcing a tier via override is command-only (`/auto-router-override model tier:<level>`); the visual editor's override row only cycles auto/an exact forced model.
- Overrides, Ultra thinking, and debug are global settings shared by every profile; tier/model mappings and the judge are per-profile.
- Profile clone/delete are command-only (`/auto-router-profile`); the visual editor only creates (`Ctrl+N`) and switches (`Tab`).
