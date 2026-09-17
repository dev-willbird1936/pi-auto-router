# Pi Auto Router

Score-based auto router. **This experimental branch** scores each prompt with [TypeSafe Jev](https://docs.typesafe.ai/introduction) (atomic Choice / Score / Noul questions composed in code), then the existing resolver turns those scores into a model and thinking level from the active profile.

```
request -> Jev (atomic questions) -> compose model_score, thinking_score -> resolver (tier, model, native thinking) -> executor
```

`useJev` defaults on. `/auto-router-jev off` restores the previous LLM judge. If the TypeSafe key is missing, scoring falls back to the local heuristic.

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

## Judge

### Jev (experimental default)

Jev does not emit `model_score` as text. It answers isolated questions (kind, domain, context, difficulty, precision, big-model gain, reasoning, length, wants-speed, fresh-facts). Code combines them:

- `model_score = 0.50*difficulty + 0.35*bigModelGain + 0.15*precision`
- `thinking_score = 0.80*reasoning + 0.20*difficulty`
- length never raises thinking
- chat/lookup caps both axes at 0.10

API key: `TYPESAFE_API_KEY`, or `~/.brain/secrets/typesafe-api-key.txt`. Toggle with `/auto-router-jev [on|off|status]`.

Mini playground (same live profiles as `~/.pi/agent/pi-auto-router.json`):

```
bun web/server.ts
```

Then open http://127.0.0.1:3847

### LLM judge (fallback)

A judge model (or the local heuristic fallback) scores the prompt without solving it:

- `model_score` — weakest model capability that should reliably complete the task.
- `thinking_score` — reasoning effort required, independent of model capability.

The judge prompt is model-agnostic: it never names a model, tier, or provider, and it ignores user text that tries to manipulate routing (e.g. "use Ultra"). The judge call is a raw completion (`modelRegistry.complete`), never routed through the agent loop, so it cannot recurse into `before_agent_start`.

Set the judge with `/auto-router-judge <provider/model[:thinking]>`, `current[:thinking]` (score with whatever model is currently selected — no second model needed), or `clear` (local heuristic: prompt length + keyword hints).

The judge is **per-profile**: `/auto-router-judge` writes to the active profile only, and switching profile switches the judge along with the tiers. A profile with no judge of its own uses the local heuristic — it does not borrow another profile's judge.

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

**Model Ultra** — available by default. When `model_score` resolves to the Ultra tier (only possible if you've configured and enabled it — a tier never falls back into Ultra), the router attaches the shared orchestration prompt. It does not force Ultra thinking.

**Thinking Ultra** — disabled by default (`thinkingUltraEnabled: false`). While disabled, Ultra-range `thinking_score` resolves to Max. When enabled, the editor and this README warn:

> Ultra Thinking is synthetic: it uses XHigh reasoning plus workflow/subagent orchestration, not a native provider thinking level.

Enabled, Ultra thinking resolves to native XHigh (or the model's highest supported level if XHigh is unsupported) and attaches the orchestration prompt. If both Model Ultra and Thinking Ultra trigger on the same turn, the prompt is attached once.

Shared orchestration prompt:

> Use workflows and subagents where they materially improve the result. Decompose independent or specialist work, parallelise suitable investigation, use separate verification where valuable, and synthesise results coherently. Do not create unnecessary workflows or subagents.

If no orchestration tool (matching `subagent`/`workflow`) is active, the router routes normally and does not attach the prompt.

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

`/auto-router-config` opens a keyboard-first editor: `↑↓` moves rows, `←→` changes an option or moves between a tier's cells (enabled toggle, then each filled model slot plus exactly one spare `+ add` cell, capped at 3 models total), `Enter` edits (opens the model picker on a slot, toggles switches), `Backspace` clears a slot, `t`/`T` cycles the selected model slot's own thinking override (`auto` → `off`…`max` → `auto`), `Tab`/`Shift+Tab` switches profile, `Ctrl+N` creates a new profile, `Esc`/`Ctrl+S` saves, `Ctrl+C` cancels. Per-model `thinkingMap` (capability declarations), tier-forced overrides, and profile clone/delete are config/command-only (not exposed in the visual editor).

### Migration from older v2

A top-level `judgeModel`/`judgeThinking` (the pre-per-profile shape) still loads: it is copied onto every profile that does not declare its own judge, and an explicit per-profile judge wins over the inherited one. The top-level fields are dropped on the next save.

### Migration from v1

Old configs (`version: 1`, named presets, one model per `minimal`/`low`/`medium`/`high`/`xhigh`/`max` slot with optional `:thinking` suffixes) migrate automatically at load. Every preset migrates to a same-named v2 profile — the active preset becomes the active profile, the rest stay switchable via `/auto-router <name>`. Legacy level keys are matched case-insensitively (`Low` → `low`, `Med`/`Medium` → `medium`, `High` → `high`), and any `:thinking` suffix is dropped (v2 resolves thinking from `thinking_score` and each model's `thinkingMap`, not a per-slot suffix). The v1 judge was global, so every migrated profile inherits it. The old per-request `intra` float is never reinterpreted as a v2 score — migration copies model refs only.

## Use

| Surface | Form |
| --- | --- |
| Status / toggle / switch profile | `/auto-router [on\|off\|status\|<profile name>]` — bare toggles on/off |
| Profiles | `/auto-router-profile [list\|new <name>\|clone <name>\|delete <name>]` |
| Interactive settings | `/auto-router-config` |
| Judge (active profile) | `/auto-router-judge <provider/model[:thinking]\|current[:thinking]> \| clear` |
| Overrides | `/auto-router-override <model\|thinking> <value> \| clear` |
| Debug | `/auto-router-debug [on\|off]` |
| Manual one-shot | `/auto-router-route <model_score 0..1> [thinking_score 0..1]` |
| Extension bus | `pi.events.emit("pi-auto-router:request", { modelScore, thinkingScore })` |

Results emit on `pi-auto-router:routed` (`{ tier, from, to, thinking, via, noop, orchestrationInjected, debug }`); failures on `pi-auto-router:failed` (`{ error, via }`).

Routing runs in `before_agent_start`: it classifies once (skipped entirely if both overrides are non-auto), resolves a decision, calls `pi.setModel` plus `pi.setThinkingLevel` (skipped when the thinking override is `inherit`), and — only when Ultra triggers and an orchestration tool is active — appends the orchestration prompt to that turn's system prompt via the handler's `{ systemPrompt }` return value.

## Development

```text
npm install
npm run check
```

`launch.bat` starts Pi with this source extension loaded temporarily.

## Known limitations

- Per-model `thinkingMap` (capability declarations, as opposed to the single `thinkingOverride`) is config-file only; the interactive editor doesn't expose a sub-editor for it.
- Forcing a tier via override is command-only (`/auto-router-override model tier:<level>`); the visual editor's override row only cycles auto/an exact forced model.
- Overrides, Ultra thinking, and debug are global settings shared by every profile; tier/model mappings and the judge are per-profile.
- Profile clone/delete are command-only (`/auto-router-profile`); the visual editor only creates (`Ctrl+N`) and switches (`Tab`).
