import { expect, test } from "bun:test";
import { defaultConfig, type RouterConfig, type RouterProfile, type TierConfig } from "../src/logic.ts";
import { buildRouteDecision, resolveOrchestration } from "../src/router.ts";

function tier(...refs: string[]): TierConfig {
  return { enabled: true, models: refs.map(ref => ({ ref })) };
}

/** Test-only shorthand: pass tiers flat, it gets wrapped into the active profile. */
function config(overrides: Partial<RouterConfig> & { tiers?: RouterProfile["tiers"] } = {}): RouterConfig {
  const { tiers, ...rest } = overrides;
  const base: RouterConfig = { ...defaultConfig(), enabled: true, ...rest };
  if (tiers) base.profiles = { [base.activeProfile]: { tiers } };
  return base;
}

test("routes to the resolved tier's model at the resolved position", () => {
  const cfg = config({ tiers: { high: tier("p/a", "p/b") } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.6, thinkingScore: 0.1 });
  expect(decision?.model.ref).toBe("p/a");
  expect(decision?.debug.canonical_model_level).toBe("high");
  expect(decision?.debug.resolved_model_level).toBe("high");
});

test("nothing enabled anywhere returns undefined (caller keeps current model)", () => {
  const cfg = config({ tiers: {} });
  expect(buildRouteDecision(cfg, { modelScore: 0.6, thinkingScore: 0.6 })).toBeUndefined();
});

test("thinking is resolved per the selected model's declared support", () => {
  const cfg = config({
    tiers: { medium: tier("p/a") },
  });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0.55 });
  expect(decision?.debug.canonical_thinking_level).toBe("high");
  expect(decision?.nativeThinking).toBe("high");
  expect(decision?.debug.thinking_saturated).toBe(false);
});

test("Model Ultra triggers only when the resolved tier is actually ultra", () => {
  const cfg = config({ tiers: { max: tier("p/max"), ultra: tier("p/ultra") } });
  const ultra = buildRouteDecision(cfg, { modelScore: 0.99, thinkingScore: 0 });
  expect(ultra?.modelUltraTriggered).toBe(true);
  expect(ultra?.debug.resolved_model_level).toBe("ultra");

  const fellBack = buildRouteDecision(config({ tiers: { max: tier("p/max") } }), { modelScore: 0.99, thinkingScore: 0 });
  expect(fellBack?.modelUltraTriggered).toBe(false);
  expect(fellBack?.debug.resolved_model_level).toBe("max");
});

test("Thinking Ultra only triggers when enabled, and downgrades to Max otherwise", () => {
  const cfg = config({ tiers: { medium: tier("p/a") } });
  const disabled = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0.99 });
  expect(disabled?.thinkingUltraTriggered).toBe(false);
  expect(disabled?.nativeThinking).toBe("max");

  const enabled = buildRouteDecision({ ...cfg, thinkingUltraEnabled: true }, { modelScore: 0.3, thinkingScore: 0.99 });
  expect(enabled?.thinkingUltraTriggered).toBe(true);
  expect(enabled?.nativeThinking).toBe("xhigh");
});

test("orchestration fires once even when both Ultra dimensions trigger simultaneously", () => {
  const cfg = config({ thinkingUltraEnabled: true, tiers: { ultra: tier("p/ultra") } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.99, thinkingScore: 0.99 })!;
  expect(decision.modelUltraTriggered).toBe(true);
  expect(decision.thinkingUltraTriggered).toBe(true);
  const orchestration = resolveOrchestration(decision, true);
  expect(orchestration.prompt).toBeDefined();
  expect(orchestration.prompt?.match(/workflows and subagents/g)?.length).toBe(1);
});

test("orchestration is requested-but-unavailable when no orchestration tool is present", () => {
  const cfg = config({ tiers: { ultra: tier("p/ultra") } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.99, thinkingScore: 0 })!;
  const orchestration = resolveOrchestration(decision, false);
  expect(orchestration.requested).toBe(true);
  expect(orchestration.available).toBe(false);
  expect(orchestration.prompt).toBeUndefined();
});

test("orchestration does not fire for ordinary routes", () => {
  const cfg = config({ tiers: { medium: tier("p/a") } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0.3 })!;
  expect(resolveOrchestration(decision, true)).toEqual({ requested: false, available: true });
});

// --- Overrides ------------------------------------------------------------------

test("forced exact model bypasses tier resolution entirely", () => {
  const cfg = config({ tiers: { medium: tier("p/a") }, overrideModel: { kind: "model", ref: "z/forced" } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0.3 });
  expect(decision?.model.ref).toBe("z/forced");
  expect(decision?.modelOverridden).toBe(true);
  expect(decision?.modelUltraTriggered).toBe(false);
});

test("forced tier still runs position/N-model selection against the judged score", () => {
  const cfg = config({ tiers: { high: tier("p/a", "p/b") }, overrideModel: { kind: "tier", tier: "high" } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.01, thinkingScore: 0 }); // score far below "high"'s band -> clamps to model 1
  expect(decision?.model.ref).toBe("p/a");
  expect(decision?.debug.resolved_model_level).toBe("high");
});

test("forced thinking beats the judged thinking_score", () => {
  const cfg = config({ tiers: { medium: tier("p/a") }, overrideThinking: { kind: "level", level: "xhigh" } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0.01 });
  expect(decision?.nativeThinking).toBe("xhigh");
  expect(decision?.thinkingOverridden).toBe(true);
});

test("manual model + auto thinking", () => {
  const cfg = config({ tiers: { medium: tier("p/a") }, overrideModel: { kind: "model", ref: "z/forced" } });
  const decision = buildRouteDecision(cfg, { modelScore: 0, thinkingScore: 0.55 });
  expect(decision?.model.ref).toBe("z/forced");
  expect(decision?.thinkingOverridden).toBe(false);
  expect(decision?.nativeThinking).toBe("high");
});

test("auto model + manual thinking (inherit leaves thinking untouched)", () => {
  const cfg = config({ tiers: { medium: tier("p/a") }, overrideThinking: { kind: "inherit" } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0.9 });
  expect(decision?.model.ref).toBe("p/a");
  expect(decision?.nativeThinking).toBeUndefined();
  expect(decision?.thinkingOverridden).toBe(true);
});

// --- Per-model thinking override -----------------------------------------------

test("a model's own thinkingOverride ignores thinking_score entirely", () => {
  const cfg = config({ tiers: { medium: { enabled: true, models: [{ ref: "p/a", thinkingOverride: "minimal" }] } } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0.99 });
  expect(decision?.nativeThinking).toBe("minimal");
  expect(decision?.modelThinkingOverridden).toBe(true);
  expect(decision?.debug.thinking_saturated).toBe(false);
  expect(decision?.thinkingUltraTriggered).toBe(false);
});

test("a model's thinkingOverride still respects its own declared thinkingMap (saturates)", () => {
  const cfg = config({
    tiers: { medium: { enabled: true, models: [{ ref: "p/a", thinkingOverride: "max", thinkingMap: { high: null, xhigh: null, max: null } }] } },
  });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0 });
  expect(decision?.nativeThinking).toBe("medium");
  expect(decision?.debug.thinking_saturated).toBe(true);
});

test("defaults to auto: a model with no thinkingOverride still resolves from thinking_score", () => {
  const cfg = config({ tiers: { medium: { enabled: true, models: [{ ref: "p/a" }] } } });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0.9 });
  expect(decision?.modelThinkingOverridden).toBe(false);
  expect(decision?.nativeThinking).toBe("max");
});

test("the global thinking override still beats a model's own thinkingOverride", () => {
  const cfg = config({
    tiers: { medium: { enabled: true, models: [{ ref: "p/a", thinkingOverride: "minimal" }] } },
    overrideThinking: { kind: "level", level: "xhigh" },
  });
  const decision = buildRouteDecision(cfg, { modelScore: 0.3, thinkingScore: 0 });
  expect(decision?.nativeThinking).toBe("xhigh");
  expect(decision?.thinkingOverridden).toBe(true);
  expect(decision?.modelThinkingOverridden).toBe(false);
});
