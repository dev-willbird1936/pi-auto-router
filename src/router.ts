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

/**
 * None/minimal work - a greeting, a question, a one-line lookup - is answered
 * by the parent in the chat it was asked in: launching a worker costs more
 * than the task. A forced model is an explicit instruction about who does the
 * work, so it still dispatches.
 *
 * Uses the judged scores, not the resolved thinking band: a model's
 * thinkingOverride (haiku:high on the Claude none-tier) would otherwise send
 * every greeting to a worker.
 */
export function answerInline(decision: RouteDecision, kind?: string): boolean {
  if (decision.modelOverridden) return false;
  if (kind === "chat") return true;
  const modelLevel = canonicalLevelForScore(decision.debug.model_score);
  const thinkLevel = canonicalLevelForScore(decision.debug.thinking_score);
  const trivial = (level: CanonicalLevel): boolean => level === "none" || level === "minimal";
  if (trivial(modelLevel) && trivial(thinkLevel)) return true;
  // A cheap lookup (time, what a flag does) stays in chat. A specialist quiz
  // (Sylow theorems) scores medium+ and still launches one worker.
  return kind === "lookup" && (modelLevel === "none" || modelLevel === "minimal" || modelLevel === "low") && trivial(thinkLevel);
}

/** After a split: chat/lookup pieces stay with the parent even when they score
 * above none/minimal (explain dosing, state a definition). Task pieces dispatch. */
export function keepWithParent(decision: RouteDecision, kind?: string): boolean {
  if (decision.modelOverridden) return false;
  if (kind === "chat" || kind === "lookup") return true;
  return answerInline(decision, kind);
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
