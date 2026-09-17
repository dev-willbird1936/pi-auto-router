import { expect, test } from "bun:test";
import { boardModels, buildRouteBoard, jevState, scoresFromJev, type JevAnswer } from "../src/jev.ts";
import { normalizeConfig } from "../src/logic.ts";

function choice(label: string, p = 1): JevAnswer {
  return { type: "choice", choice: label, confidence: p, probabilities: { [label]: p } };
}

function score(value: number, confidence = 0.9): JevAnswer {
  return { type: "score", score: value, confidence };
}

function noul(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

test("chat and lookup cap both axes at minimal", () => {
  const { scores, read } = scoresFromJev({
    kind: choice("lookup"),
    domain: choice("math"),
    context: choice("self-contained"),
    difficulty: score(6),
    precision: score(2),
    bigModelGain: score(3),
    reasoning: score(6),
    length: score(2),
    wantsSpeed: noul(0.1),
    freshFacts: noul(0.1),
  });
  expect(read.kind).toBe("lookup");
  expect(scores.modelScore).toBeLessThanOrEqual(0.1);
  expect(scores.thinkingScore).toBeLessThanOrEqual(0.1);
});

test("hard proof maps high model and thinking scores", () => {
  const { scores, read } = scoresFromJev({
    kind: choice("task"),
    domain: choice("math", 1),
    context: choice("self-contained", 1),
    difficulty: score(6, 0.95),
    precision: score(2, 0.96),
    bigModelGain: score(3, 0.9),
    reasoning: score(6, 0.9),
    length: score(1, 0.65),
    wantsSpeed: noul(0.05),
    freshFacts: noul(0.04),
  });
  expect(read.domain).toBe("math");
  expect(scores.modelScore).toBeGreaterThan(0.7);
  expect(scores.thinkingScore).toBeGreaterThan(0.7);
  expect(scores.thinkingScore).toBeLessThan(1);
});

test("length does not raise thinking", () => {
  const short = scoresFromJev({
    kind: choice("task"),
    domain: choice("coding"),
    context: choice("self-contained"),
    difficulty: score(2),
    precision: score(1),
    bigModelGain: score(1),
    reasoning: score(2),
    length: score(0),
    wantsSpeed: noul(0),
    freshFacts: noul(0),
  }).scores;
  const long = scoresFromJev({
    kind: choice("task"),
    domain: choice("coding"),
    context: choice("self-contained"),
    difficulty: score(2),
    precision: score(1),
    bigModelGain: score(1),
    reasoning: score(2),
    length: score(2),
    wantsSpeed: noul(0),
    freshFacts: noul(0),
  }).scores;
  expect(long.thinkingScore).toBe(short.thinkingScore);
  expect(long.modelScore).toBe(short.modelScore);
});

test("board lists enabled profile models and marks the winner", () => {
  const config = normalizeConfig({
    version: 2,
    enabled: true,
    activeProfile: "gpt",
    profiles: {
      gpt: {
        tiers: {
          low: { enabled: true, models: [{ ref: "openai-codex/gpt-5.6-luna", thinkingOverride: "low" }] },
          high: { enabled: true, models: [{ ref: "openai-codex/gpt-5.6-sol", thinkingOverride: "high" }] },
        },
      },
    },
  });
  const rows = boardModels(config, "openai-codex/gpt-5.6-sol");
  expect(rows.map(row => row.ref)).toEqual(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"]);
  expect(rows.find(row => row.ref.endsWith("sol"))?.selected).toBe(true);
});

test("route board uses the existing resolver against the active profile", () => {
  const config = normalizeConfig({
    version: 2,
    enabled: true,
    activeProfile: "gpt",
    profiles: {
      gpt: {
        tiers: {
          none: { enabled: true, models: [{ ref: "openai-codex/gpt-5.6-luna", thinkingOverride: "low" }] },
          high: { enabled: true, models: [{ ref: "openai-codex/gpt-5.6-sol", thinkingOverride: "low" }] },
        },
      },
    },
  });
  const board = buildRouteBoard(config, { modelScore: 0.6, thinkingScore: 0.2 }, { wantsSpeed: 0.1, difficulty: 0.6 });
  expect(board.decision?.model.ref).toBe("openai-codex/gpt-5.6-sol");
  expect(board.minTier).toBe("high");
  expect(board.steps[0]).toContain("survive");
});

test("jev state keeps a short conversation prefix", () => {
  const state = jevState("prove it", [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
  ]) as { current_user_message: string; conversation: unknown[] };
  expect(state.current_user_message).toBe("prove it");
  expect(state.conversation).toHaveLength(2);
});
