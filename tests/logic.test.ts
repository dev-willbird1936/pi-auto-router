import { expect, test } from "bun:test";
import {
  activeProfile,
  activeTiers,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  canonicalLevelForScore,
  CANONICAL_BANDS,
  CANONICAL_LEVELS,
  fuzzyFilterModels,
  heuristicScores,
  migrateV1Config,
  modelIndexForPosition,
  modelSearchText,
  normalizeConfig,
  parseJudgeScores,
  resolveModelTier,
  resolveOrdinaryThinking,
  resolveThinkingDecision,
  resolveUltraThinking,
  selectModel,
  type ModelEntry,
  type RouterConfig,
  type TierConfig,
} from "../src/logic.ts";

// --- Canonical scale ----------------------------------------------------------

test("band boundaries belong to the lower band", () => {
  expect(canonicalLevelForScore(0)).toBe("none");
  expect(canonicalLevelForScore(0.02)).toBe("none");
  expect(canonicalLevelForScore(0.020001)).toBe("minimal");
  expect(canonicalLevelForScore(0.1)).toBe("minimal");
  expect(canonicalLevelForScore(0.100001)).toBe("low");
  expect(canonicalLevelForScore(0.25)).toBe("low");
  expect(canonicalLevelForScore(0.250001)).toBe("medium");
  expect(canonicalLevelForScore(0.5)).toBe("medium");
  expect(canonicalLevelForScore(0.500001)).toBe("high");
  expect(canonicalLevelForScore(0.7)).toBe("high");
  expect(canonicalLevelForScore(0.700001)).toBe("xhigh");
  expect(canonicalLevelForScore(0.85)).toBe("xhigh");
  expect(canonicalLevelForScore(0.850001)).toBe("max");
  expect(canonicalLevelForScore(0.95)).toBe("max");
  expect(canonicalLevelForScore(0.950001)).toBe("ultra");
  expect(canonicalLevelForScore(1)).toBe("ultra");
});

test("scores clamp outside 0..1", () => {
  expect(canonicalLevelForScore(-5)).toBe("none");
  expect(canonicalLevelForScore(5)).toBe("ultra");
});

// --- Tier fallback --------------------------------------------------------------

function tier(...refs: string[]): TierConfig {
  return { enabled: true, models: refs.map(ref => ({ ref })) };
}

test("sparse tiers: nearest enabled tier above wins, never falling into ultra", () => {
  const tiers = { low: tier("p/low"), max: tier("p/max") };
  expect(resolveModelTier("medium", tiers)).toBe("max");
  expect(resolveModelTier("xhigh", tiers)).toBe("max");
  // "max" disabled and only "ultra" left above -> never fall into ultra, use highest enabled ordinary (low).
  const tiersNoMax = { low: tier("p/low"), ultra: tier("p/ultra") };
  expect(resolveModelTier("xhigh", tiersNoMax)).toBe("low");
  expect(resolveModelTier("max", tiersNoMax)).toBe("low");
});

test("canonical tier itself wins when enabled, including ultra", () => {
  const tiers = { low: tier("p/low"), ultra: tier("p/ultra") };
  expect(resolveModelTier("low", tiers)).toBe("low");
  expect(resolveModelTier("ultra", tiers)).toBe("ultra");
});

test("disabled tier is treated as absent", () => {
  const tiers = { low: { enabled: false, models: [{ ref: "p/low" }] }, high: tier("p/high") };
  expect(resolveModelTier("low", tiers)).toBe("high");
});

test("nothing enabled anywhere resolves to undefined", () => {
  expect(resolveModelTier("medium", {})).toBeUndefined();
});

// --- Model selection within a tier ----------------------------------------------

test("1 model always wins", () => {
  expect(modelIndexForPosition(0, 1)).toBe(0);
  expect(modelIndexForPosition(0.5, 1)).toBe(0);
  expect(modelIndexForPosition(1, 1)).toBe(0);
});

test("2 models: exact 0.5 goes to the lower model", () => {
  expect(modelIndexForPosition(0, 2)).toBe(0);
  expect(modelIndexForPosition(0.5, 2)).toBe(0);
  expect(modelIndexForPosition(0.500001, 2)).toBe(1);
  expect(modelIndexForPosition(1, 2)).toBe(1);
});

test("3 models split into thirds, boundaries belong to the lower model", () => {
  expect(modelIndexForPosition(0, 3)).toBe(0);
  expect(modelIndexForPosition(1 / 3, 3)).toBe(0);
  expect(modelIndexForPosition(1 / 3 + 0.001, 3)).toBe(1);
  expect(modelIndexForPosition(2 / 3, 3)).toBe(1);
  expect(modelIndexForPosition(2 / 3 + 0.001, 3)).toBe(2);
  expect(modelIndexForPosition(1, 3)).toBe(2);
});

test("selectModel positions against the resolved tier's own band, clamped when it's a fallback", () => {
  const tiers = { high: tier("p/a", "p/b") };
  // score 0.6 is in the middle of high's 0.5-0.7 band.
  expect(selectModel(0.6, "high", tiers)?.model.ref).toBe("p/a");
  expect(selectModel(0.69, "high", tiers)?.model.ref).toBe("p/b");
  // score 0.97 (ultra range) fell back onto "high" -> clamps to position 1 -> strongest model.
  expect(selectModel(0.97, "high", tiers)?.model.ref).toBe("p/b");
});

// --- Thinking resolution ----------------------------------------------------------

test("identity mapping when no thinkingMap is declared", () => {
  const model: ModelEntry = { ref: "p/m" };
  expect(resolveOrdinaryThinking("high", model)).toEqual({ native: "high", saturated: false });
  expect(resolveOrdinaryThinking("none", model)).toEqual({ native: "off", saturated: false });
});

test("missing thinking level maps upward without saturating", () => {
  const model: ModelEntry = { ref: "p/m", thinkingMap: { high: null } };
  expect(resolveOrdinaryThinking("high", model)).toEqual({ native: "xhigh", saturated: false });
});

test("above the model's ceiling clamps to its highest supported level and saturates", () => {
  const model: ModelEntry = { ref: "p/m", thinkingMap: { high: null, xhigh: null, max: null } };
  expect(resolveOrdinaryThinking("max", model)).toEqual({ native: "medium", saturated: true });
});

test("explicit remap overrides identity", () => {
  const model: ModelEntry = { ref: "p/m", thinkingMap: { xhigh: "high" } };
  expect(resolveOrdinaryThinking("xhigh", model)).toEqual({ native: "high", saturated: false });
});

test("thinking Ultra uses XHigh, or the model's max if XHigh is unsupported", () => {
  expect(resolveUltraThinking({ ref: "p/m" })).toEqual({ native: "xhigh", saturated: false });
  expect(resolveUltraThinking({ ref: "p/m", thinkingMap: { xhigh: null } })).toEqual({ native: "max", saturated: true });
});

test("thinking Ultra disabled resolves to Max instead", () => {
  const model: ModelEntry = { ref: "p/m" };
  const decision = resolveThinkingDecision(0.99, model, false);
  expect(decision.canonicalLevel).toBe("ultra");
  expect(decision.native).toBe("max");
  expect(decision.ultraTriggered).toBe(false);
});

test("thinking Ultra enabled triggers synthetic XHigh", () => {
  const model: ModelEntry = { ref: "p/m" };
  const decision = resolveThinkingDecision(0.99, model, true);
  expect(decision.native).toBe("xhigh");
  expect(decision.ultraTriggered).toBe(true);
});

test("ordinary thinking scores never trigger Ultra", () => {
  const decision = resolveThinkingDecision(0.6, { ref: "p/m" }, true);
  expect(decision.canonicalLevel).toBe("high");
  expect(decision.ultraTriggered).toBe(false);
});

// --- Judge JSON ---------------------------------------------------------------

test("parses well-formed judge JSON", () => {
  const text = '```json\n{"model_score":0.42,"thinking_score":0.77,"confidence":0.9,"model_reason":"x","thinking_reason":"y"}\n```';
  expect(parseJudgeScores(text)).toEqual({
    modelScore: 0.42,
    thinkingScore: 0.77,
    confidence: 0.9,
    modelReason: "x",
    thinkingReason: "y",
  });
});

test("malformed judge JSON returns undefined", () => {
  expect(parseJudgeScores("not json at all")).toBeUndefined();
  expect(parseJudgeScores('{"model_score":0.5}')).toBeUndefined(); // missing thinking_score
  expect(parseJudgeScores('{"model_score":"nope","thinking_score":0.5}')).toBeUndefined();
  expect(parseJudgeScores(undefined)).toBeUndefined();
  expect(parseJudgeScores("{broken")).toBeUndefined();
});

test("judge system prompt is provider-agnostic and anchors to the canonical bands", () => {
  const prompt = buildJudgeSystemPrompt();
  expect(prompt).toContain("model_score");
  expect(prompt).toContain("thinking_score");
  // Provider/model names would tie one prompt to one profile's lineup.
  expect(prompt.toLowerCase()).not.toMatch(/anthropic|openai|gpt-|claude|gemini/);
  // Band names and edges are stated on purpose so the judge scores against the
  // same scale canonicalLevelForScore() buckets into; drift here silently
  // re-tiers every prompt.
  for (const level of CANONICAL_LEVELS) expect(prompt).toContain(level);
  expect(prompt).toContain("0.00\u20130.02");
  expect(prompt).toContain(">0.95\u20131.00");
});

test("judge user prompt clips long input", () => {
  const long = "x".repeat(3000);
  expect(buildJudgeUserPrompt(long, 2000)).toContain("[truncated]");
  expect(buildJudgeUserPrompt("short")).toBe("<request>\nshort\n</request>\nClassify.");
});

test("heuristic never reuses v1 bucket/intra shape", () => {
  const trivial = heuristicScores("thanks");
  expect(trivial).toEqual({ modelScore: 0.01, thinkingScore: 0.01 });
  const complex = heuristicScores("design a distributed caching strategy across microservices");
  expect(complex.modelScore).toBeGreaterThan(0.5);
  expect("bucket" in complex).toBe(false);
  expect("intra" in complex).toBe(false);
});

// --- Migration ------------------------------------------------------------------

test("legacy v1 config migrates every preset into a same-named v2 profile", () => {
  const legacy = {
    version: 1,
    enabled: true,
    activePreset: "p1",
    judgeModel: "google/gemini",
    judgeThinking: "high",
    presets: {
      p1: {
        minimal: "p/a",
        Low: "p/b:minimal",
        Med: "p/c",
        High: "p/d:inherit",
        xhigh: "p/e",
        max: "p/f",
      },
      p2: { low: "p/other" },
    },
  };
  const config = normalizeConfig(legacy);
  expect(config.version).toBe(2);
  expect(config.enabled).toBe(true);
  // The v1 judge was global, so every migrated profile inherits it.
  expect(config.profiles.p1?.judgeModel).toBe("google/gemini");
  expect(config.profiles.p1?.judgeThinking).toBe("high");
  expect(config.profiles.p2?.judgeModel).toBe("google/gemini");
  expect(config.activeProfile).toBe("p1");
  const p1 = activeTiers(config);
  expect(p1.minimal?.models[0]?.ref).toBe("p/a");
  expect(p1.low?.models[0]?.ref).toBe("p/b"); // ":minimal" thinking suffix dropped
  expect(p1.medium?.models[0]?.ref).toBe("p/c"); // "Med" alias
  expect(p1.high?.models[0]?.ref).toBe("p/d"); // ":inherit" suffix dropped, "High" alias
  expect(p1.xhigh?.models[0]?.ref).toBe("p/e");
  expect(p1.max?.models[0]?.ref).toBe("p/f");
  expect(p1.ultra).toBeUndefined();
  // Every preset migrates, not just the active one: p2 survives as its own switchable profile.
  expect(config.profiles.p2?.tiers.low?.models[0]?.ref).toBe("p/other");
});

test("migration falls back to the first preset when activePreset is missing or stale", () => {
  const config = migrateV1Config({
    version: 1,
    presets: { p1: { low: "p/a" } },
  });
  expect(config.activeProfile).toBe("p1");

  const stale = migrateV1Config({
    version: 1,
    activePreset: "gone",
    presets: { p1: { low: "p/a" } },
  });
  expect(stale.activeProfile).toBe("p1");
});

test("migration keeps colon-bearing model ids that are not thinking suffixes", () => {
  const config = migrateV1Config({
    version: 1,
    activePreset: "p1",
    presets: { p1: { low: "ollama/llama3.1:8b" } },
  });
  expect(activeTiers(config).low?.models[0]?.ref).toBe("ollama/llama3.1:8b");
});

test("fresh/garbage config falls back to safe defaults", () => {
  expect(normalizeConfig(null).version).toBe(2);
  expect(normalizeConfig({}).useJev).toBe(true);
  expect(activeTiers(normalizeConfig({}))).toEqual({});
  expect(activeTiers(normalizeConfig({ tiers: { low: { models: ["not-a-ref"] } } })).low).toBeUndefined();
});

test("v2 config in the flat single-profile shape (no profiles key) still normalizes, for back-compat", () => {
  const input = {
    version: 2,
    enabled: true,
    thinkingUltraEnabled: true,
    debug: true,
    tiers: {
      low: { enabled: true, models: [{ ref: "p/a", thinkingMap: { high: null, xhigh: "high" } }] },
      max: { enabled: false, models: ["p/b"] },
    },
    overrideModel: { kind: "tier", tier: "high" },
    overrideThinking: { kind: "level", level: "xhigh" },
  };
  const config: RouterConfig = normalizeConfig(input);
  expect(config.thinkingUltraEnabled).toBe(true);
  expect(config.debug).toBe(true);
  const tiers = activeTiers(config);
  expect(tiers.low?.models[0]).toEqual({ ref: "p/a", thinkingMap: { high: null, xhigh: "high" } });
  expect(tiers.max?.enabled).toBe(false);
  expect(config.overrideModel).toEqual({ kind: "tier", tier: "high" });
  expect(config.overrideThinking).toEqual({ kind: "level", level: "xhigh" });
});

test("cloning a profile copies its judge, not just its tiers", () => {
  const config = normalizeConfig({
    version: 2,
    activeProfile: "src",
    profiles: { src: { judgeModel: "p/j", judgeThinking: "low", tiers: { low: { enabled: true, models: [{ ref: "p/a" }] } } } },
  });
  config.profiles.copy = JSON.parse(JSON.stringify(activeProfile(config)));
  expect(config.profiles.copy?.judgeModel).toBe("p/j");
  expect(config.profiles.copy?.judgeThinking).toBe("low");
  expect(config.profiles.copy?.tiers.low?.models[0]?.ref).toBe("p/a");
});

test("v2 config with explicit named profiles round-trips activeProfile and switching", () => {
  const input = {
    version: 2,
    activeProfile: "power",
    profiles: {
      cheap: { tiers: { low: { enabled: true, models: [{ ref: "p/a" }] } } },
      power: { tiers: { high: { enabled: true, models: [{ ref: "p/b" }] } } },
    },
  };
  const config = normalizeConfig(input);
  expect(config.activeProfile).toBe("power");
  expect(Object.keys(config.profiles)).toEqual(["cheap", "power"]);
  expect(activeTiers(config).high?.models[0]?.ref).toBe("p/b");
  expect(config.profiles.cheap?.tiers.low?.models[0]?.ref).toBe("p/a");
});

test("each profile carries its own judge, and switching profile switches judge", () => {
  const config = normalizeConfig({
    version: 2,
    activeProfile: "cheap",
    profiles: {
      cheap: { judgeModel: "p/small", judgeThinking: "low", tiers: {} },
      power: { judgeModel: "p/big", judgeThinking: "xhigh", tiers: {} },
      heuristic: { tiers: {} },
    },
  });
  expect(activeProfile(config).judgeModel).toBe("p/small");
  expect(activeProfile(config).judgeThinking).toBe("low");
  config.activeProfile = "power";
  expect(activeProfile(config).judgeModel).toBe("p/big");
  expect(activeProfile(config).judgeThinking).toBe("xhigh");
  // A profile with no judge of its own falls back to the local heuristic, not to another profile's judge.
  config.activeProfile = "heuristic";
  expect(activeProfile(config).judgeModel).toBeUndefined();
});

test("a pre-per-profile top-level judge migrates onto every profile that lacks its own", () => {
  const config = normalizeConfig({
    version: 2,
    judgeModel: "p/global",
    judgeThinking: "medium",
    activeProfile: "a",
    profiles: {
      a: { tiers: {} },
      b: { judgeModel: "p/own", judgeThinking: "max", tiers: {} },
    },
  });
  expect(config.profiles.a?.judgeModel).toBe("p/global");
  expect(config.profiles.a?.judgeThinking).toBe("medium");
  // An explicit per-profile judge wins over the inherited global one.
  expect(config.profiles.b?.judgeModel).toBe("p/own");
  expect(config.profiles.b?.judgeThinking).toBe("max");
  expect("judgeModel" in config).toBe(false);
});

test("an activeProfile that doesn't exist falls back to the first profile", () => {
  const config = normalizeConfig({
    version: 2,
    activeProfile: "gone",
    profiles: { only: { tiers: {} } },
  });
  expect(config.activeProfile).toBe("only");
});

test("a model entry's own thinkingOverride round-trips, default is auto (absent)", () => {
  const config = normalizeConfig({
    version: 2,
    tiers: {
      low: { enabled: true, models: [{ ref: "p/a", thinkingOverride: "Minimal" }, { ref: "p/b" }] },
    },
  });
  const tiers = activeTiers(config);
  expect(tiers.low?.models[0]).toEqual({ ref: "p/a", thinkingOverride: "minimal" });
  expect(tiers.low?.models[1]).toEqual({ ref: "p/b" });
  expect(tiers.low?.models[1]?.thinkingOverride).toBeUndefined();
});

test("an invalid thinkingOverride is dropped, defaulting to auto", () => {
  const config = normalizeConfig({
    version: 2,
    tiers: { low: { enabled: true, models: [{ ref: "p/a", thinkingOverride: "turbo" }] } },
  });
  expect(activeTiers(config).low?.models[0]?.thinkingOverride).toBeUndefined();
});

// --- Model search (unchanged helpers) --------------------------------------------

test("model search text leads with provider like /model", () => {
  const text = modelSearchText({ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" });
  expect(text.startsWith("anthropic anthropic/claude-opus-4-6")).toBe(true);
});

test("fuzzy filter matches /model token semantics", () => {
  const items = [
    { provider: "anthropic", id: "claude-opus-4-6" },
    { provider: "openai", id: "gpt-5.2" },
  ];
  const result = fuzzyFilterModels(items, "opus", modelSearchText);
  expect(result).toHaveLength(1);
  expect(result[0]?.id).toBe("claude-opus-4-6");
});
