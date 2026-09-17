import {
  activeTiers,
  bandPosition,
  CANONICAL_BANDS,
  canonicalLevelForScore,
  modelIndexForPosition,
  ordinaryFromPiThinking,
  ORCHESTRATION_PROMPT,
  resolveModelTier,
  resolveOrdinaryThinking,
  resolveThinkingDecision,
  type CanonicalLevel,
  type ModelEntry,
  type PiThinking,
  type RouterConfig,
  type Scores,
} from "./logic.ts";

export interface RouteDebug {
  model_score: number;
  canonical_model_level: CanonicalLevel;
  resolved_model_level: CanonicalLevel;
  tier_position: number;
  model_index: number;
  model: string;
  thinking_score: number;
  canonical_thinking_level: CanonicalLevel;
  native_thinking_level: PiThinking;
  thinking_saturated: boolean;
  ultra_orchestration: boolean;
}

export interface RouteDecision {
  model: ModelEntry;
  /** Undefined when overrideThinking is "inherit": leave the session's thinking level untouched. */
  nativeThinking: PiThinking | undefined;
  modelOverridden: boolean;
  /** True when the global config-level thinking override applied (beats everything, including the model's own thinkingOverride). */
  thinkingOverridden: boolean;
  /** True when the selected model's own thinkingOverride applied (thinking_score was not consulted). */
  modelThinkingOverridden: boolean;
  modelUltraTriggered: boolean;
  thinkingUltraTriggered: boolean;
  debug: RouteDebug;
}

/**
 * Stage 2 (Resolver): scores + config + overrides -> concrete model and
 * native thinking level. Undefined means nothing is enabled anywhere and no
 * override forces a model: the caller should keep the current model/thinking.
 */
export function buildRouteDecision(config: RouterConfig, scores: Scores): RouteDecision | undefined {
  const tiers = activeTiers(config);
  const canonicalModelLevel = canonicalLevelForScore(scores.modelScore);
  const override = config.overrideModel;

  let resolvedModelLevel: CanonicalLevel | undefined;
  let forcedModel: ModelEntry | undefined;
  const modelOverridden = override.kind !== "auto";

  if (override.kind === "model") {
    forcedModel = { ref: override.ref };
  } else if (override.kind === "tier") {
    resolvedModelLevel = resolveModelTier(override.tier, tiers);
  } else {
    resolvedModelLevel = resolveModelTier(canonicalModelLevel, tiers);
  }

  let model: ModelEntry;
  let tierPosition = 0;
  let modelIndex = 0;
  if (forcedModel) {
    model = forcedModel;
  } else if (resolvedModelLevel) {
    const tier = tiers[resolvedModelLevel]!;
    tierPosition = bandPosition(scores.modelScore, CANONICAL_BANDS[resolvedModelLevel]);
    modelIndex = modelIndexForPosition(tierPosition, tier.models.length);
    model = tier.models[modelIndex]!;
  } else {
    return undefined;
  }

  const thinkingOverride = config.overrideThinking;
  const thinkingOverridden = thinkingOverride.kind !== "auto";
  let nativeThinking: PiThinking | undefined;
  let canonicalThinkingLevel: CanonicalLevel;
  let thinkingSaturated = false;
  let thinkingUltraTriggered = false;
  let modelThinkingOverridden = false;

  if (thinkingOverride.kind === "inherit") {
    nativeThinking = undefined;
    canonicalThinkingLevel = canonicalLevelForScore(scores.thinkingScore);
  } else if (thinkingOverride.kind === "level") {
    nativeThinking = thinkingOverride.level;
    canonicalThinkingLevel = canonicalLevelForScore(scores.thinkingScore);
  } else if (model.thinkingOverride) {
    const forced = ordinaryFromPiThinking(model.thinkingOverride);
    const resolved = resolveOrdinaryThinking(forced, model);
    nativeThinking = resolved.native;
    thinkingSaturated = resolved.saturated;
    canonicalThinkingLevel = forced;
    modelThinkingOverridden = true;
  } else {
    const decision = resolveThinkingDecision(scores.thinkingScore, model, config.thinkingUltraEnabled);
    nativeThinking = decision.native;
    thinkingSaturated = decision.saturated;
    canonicalThinkingLevel = decision.canonicalLevel;
    thinkingUltraTriggered = decision.ultraTriggered;
  }

  const modelUltraTriggered = resolvedModelLevel === "ultra";

  return {
    model,
    nativeThinking,
    modelOverridden,
    thinkingOverridden,
    modelThinkingOverridden,
    modelUltraTriggered,
    thinkingUltraTriggered,
    debug: {
      model_score: scores.modelScore,
      canonical_model_level: canonicalModelLevel,
      resolved_model_level: resolvedModelLevel ?? canonicalModelLevel,
      tier_position: tierPosition,
      model_index: modelIndex,
      model: model.ref,
      thinking_score: scores.thinkingScore,
      canonical_thinking_level: canonicalThinkingLevel,
      native_thinking_level: nativeThinking ?? "off",
      thinking_saturated: thinkingSaturated,
      ultra_orchestration: modelUltraTriggered || thinkingUltraTriggered,
    },
  };
}

export interface OrchestrationResult {
  requested: boolean;
  available: boolean;
  /** Set once, regardless of whether Model Ultra, Thinking Ultra, or both triggered. */
  prompt?: string;
}

/** Stage 3 (Executor) input: whether to attach the shared orchestration prompt. */
export function resolveOrchestration(decision: RouteDecision, toolsAvailable: boolean): OrchestrationResult {
  const requested = decision.modelUltraTriggered || decision.thinkingUltraTriggered;
  if (!requested) return { requested: false, available: toolsAvailable };
  return { requested: true, available: toolsAvailable, prompt: toolsAvailable ? ORCHESTRATION_PROMPT : undefined };
}
