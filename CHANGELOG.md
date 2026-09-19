# Changelog

## [0.1.0] - 2026-09-19

Initial GitHub-ready release of the experimental Jev-router default.

- Score-based auto router for Pi Coding Agent: eight shared bands (none through ultra), per-profile model tiers, and independent thinking resolution.
- TypeSafe Jev scoring is on by default (`useJev`). Missing or failed Jev falls back to the prompted model as judge. `/auto-router-jev off` uses that LLM judge only. `/auto-router-judge` can pin a specific model and thinking (unrecommended). The local heuristic is last resort.
- TypeSafe credentials are read from `TYPESAFE_API_KEY` or `~/.brain/secrets/typesafe-api-key.txt` (never from files in this repository).
- Split check, local then LLM splitter, per-task routing, and cheap none/minimal (and cheap lookup) work answered in the parent chat.
- Parent model and thinking stay unchanged; worker briefs are packed under `~/.pi/agent/pi-auto-router-tasks/` and expanded on `subagent` `tool_call`. Two or more remaining workers launch with `async: true`.
- Mini Jev playground: `bun web/server.ts` (http://127.0.0.1:3847), using the same live profiles as `~/.pi/agent/pi-auto-router.json`.
- Commands: `/auto-router`, `/auto-router-profile`, `/auto-router-config`, `/auto-router-judge`, `/auto-router-jev`, `/auto-router-split`, `/auto-router-override`, `/auto-router-debug`, `/auto-router-route`.
