import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  activeProfile,
  activeTiers,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  CANONICAL_LEVELS,
  defaultConfig,
  heuristicScores,
  isPiThinking,
  JUDGE_CURRENT,
  JUDGE_HEURISTIC,
  normalizeConfig,
  parseJudgeScores,
  ULTRA_THINKING_WARNING,
  type CanonicalLevel,
  type ModelOverride,
  type PiThinking,
  type RouterConfig,
  type Scores,
  type ThinkingOverride,
} from "./logic.ts";
import { answerInline, buildRouteDecision, resolveOrchestration, type RouteDebug, type RouteDecision } from "./router.ts";
import { classifyWithJev, typesafeConfigured, type ConversationTurn } from "./jev.ts";
import {
  buildParentDispatch,
  buildSplitDispatch,
  configureTaskStore,
  partitionRoutedTasks,
  resolveWorkerTask,
  resourceNames,
  shouldDispatch,
  type RoutedSubTask,
} from "./dispatch.ts";
import {
  buildSplitSystemPrompt,
  buildSplitUserPrompt,
  checkSplitWithJev,
  heuristicSplitCheck,
  parseSubTasks,
  splitLocally,
  wantsSplit,
  type SubTask,
} from "./split.ts";
import { runConfigUI, type ConfigCommandCtx, type StatusCtx } from "./config-ui.ts";

export const REQUEST_CHANNEL = "pi-auto-router:request";
export const ROUTED_CHANNEL = "pi-auto-router:routed";
export const FAILED_CHANNEL = "pi-auto-router:failed";

const CONFIG_FILE = "pi-auto-router.json";
const JUDGE_TIMEOUT_MS = 15_000;
const SPLIT_TIMEOUT_MS = 30_000;
const ORCHESTRATION_TOOL_PATTERN = /subagent|workflow/i;

export interface RoutedPayload {
  tier: CanonicalLevel;
  from: string | undefined;
  to: string;
  thinking: PiThinking | undefined;
  via: "auto" | "command" | "bus";
  noop: boolean;
  dispatched: boolean;
  orchestrationInjected: boolean;
  /** Set when this route is one task of a split request. */
  split?: { index: number; total: number };
  debug: RouteDebug;
}

export interface FailedPayload {
  error: string;
  via: "auto" | "command" | "bus";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBusScores(data: unknown): Scores | undefined {
  if (!isRecord(data)) return undefined;
  const modelScore = Number(data.modelScore ?? data.model_score);
  const thinkingScore = Number(data.thinkingScore ?? data.thinking_score);
  if (!Number.isFinite(modelScore) || !Number.isFinite(thinkingScore)) return undefined;
  return { modelScore: Math.min(1, Math.max(0, modelScore)), thinkingScore: Math.min(1, Math.max(0, thinkingScore)) };
}

function modelRef(model: Model<any> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function configPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

function loadConfig(): RouterConfig {
  try {
    if (existsSync(configPath())) {
      return normalizeConfig(JSON.parse(readFileSync(configPath(), "utf8")));
    }
  } catch (error) {
    console.error(`[pi-auto-router] invalid config, using defaults:`, error);
  }
  const fresh = defaultConfig();
  try {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
  } catch {
    // Read-only home dir: run memory-only this session.
  }
  return fresh;
}

function saveConfig(config: RouterConfig): void {
  try {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(`[pi-auto-router] could not save config:`, error);
  }
}

function hasAuth(ctx: ExtensionContext, model: Model<any>): boolean {
  try {
    const registry = ctx.modelRegistry as unknown as {
      hasConfiguredAuth?: (model: Model<any>) => boolean;
    };
    if (typeof registry.hasConfiguredAuth === "function") return registry.hasConfiguredAuth(model);
  } catch {
    // Fall through: assume authed, let setModel report otherwise.
  }
  return true;
}

function findModel(ctx: ExtensionContext, ref: string): Model<any> | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
}

function sessionTurns(ctx: ExtensionContext): ConversationTurn[] {
  const entries = (ctx.sessionManager as { getEntries?: () => unknown[] } | undefined)?.getEntries?.() ?? [];
  const turns: ConversationTurn[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const role = entry.role === "assistant" || entry.type === "assistant" ? "assistant" : entry.role === "user" || entry.type === "user" ? "user" : undefined;
    if (!role) continue;
    let text = "";
    if (typeof entry.text === "string") text = entry.text;
    else if (typeof entry.content === "string") text = entry.content;
    else if (Array.isArray(entry.content)) {
      text = entry.content
        .filter((part): part is { type: string; text: string } => !!part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: string }).text === "string")
        .map(part => part.text)
        .join("\n");
    }
    if (text.trim()) turns.push({ role, text });
  }
  return turns;
}

function sessionHistory(ctx: ExtensionContext): ConversationTurn[] {
  return sessionTurns(ctx).slice(-8);
}

function inSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

export default function piAutoRouterExtension(pi: ExtensionAPI): void {
  let config = loadConfig();
  let latestCtx: ExtensionContext | undefined;
  let lastRoute: (RoutedPayload & { at: number }) | undefined;
  /** Defensive: the judge call must never re-enter before_agent_start (it bypasses the agent loop already, but guard anyway). */
  let judging = false;

  function llmJudgeLabel(): string {
    const { judgeModel, judgeThinking } = activeProfile(config);
    if (judgeModel === JUDGE_HEURISTIC) return "heuristic";
    const name = !judgeModel || judgeModel === JUDGE_CURRENT ? "current model" : judgeModel;
    return `${name}:${judgeThinking ?? "high"}`;
  }

  function judgeLabel(): string {
    if (config.useJev) {
      return typesafeConfigured() ? "jev-latest" : `jev (no key) → ${llmJudgeLabel()}`;
    }
    return llmJudgeLabel();
  }

  function overrideLabel(): string {
    const model = config.overrideModel.kind === "auto" ? "auto" : JSON.stringify(config.overrideModel);
    const thinking = config.overrideThinking.kind === "auto" ? "auto" : JSON.stringify(config.overrideThinking);
    return `model=${model} thinking=${thinking}`;
  }

  function statusText(ctx: ExtensionContext): string {
    const current = modelRef(ctx.model) ?? "(no model)";
    const tiers = activeTiers(config);
    const tierSummary = CANONICAL_LEVELS.map(level => {
      const tier = tiers[level];
      if (!tier) return `  ${level}: -`;
      const refs = tier.models.map(m => m.ref).join(", ");
      return `  ${level}: ${tier.enabled ? "" : "(disabled) "}${refs}`;
    }).join("\n");
    const last = lastRoute
      ? `${lastRoute.from ?? "none"} -> ${lastRoute.to}:${lastRoute.thinking ?? "inherit"}`
      : "no route yet";
    const otherProfiles = Object.keys(config.profiles).filter(name => name !== config.activeProfile);
    const lines = [
      `Auto-router: ${config.enabled ? "on" : "off"}  profile: ${config.activeProfile}${otherProfiles.length ? ` (also: ${otherProfiles.join(", ")})` : ""}`,
      `Judge: ${judgeLabel()}  ultra-thinking: ${config.thinkingUltraEnabled ? "on" : "off"}  split-check: ${config.splitCheckEnabled ? "on" : "off"}`,
      `Current: ${current} [${pi.getThinkingLevel()}]`,
      `Overrides: ${overrideLabel()}`,
      `Last: ${last}`,
      `Tiers:\n${tierSummary}`,
    ];
    if (config.debug && lastRoute) lines.push(`Debug: ${JSON.stringify(lastRoute.debug)}`);
    return lines.join("\n");
  }

  function updateStatus(ctx: ExtensionContext | StatusCtx): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "auto-router",
      config.enabled ? `auto:${lastRoute ? lastRoute.debug.resolved_model_level : "idle"}` : "auto:off",
    );
  }

  function showStatus(ctx: ExtensionCommandContext): void {
    if (ctx.hasUI) ctx.ui.notify(statusText(ctx), "info");
    else pi.sendMessage({ customType: "pi-auto-router", content: statusText(ctx), display: true }, { triggerTurn: false });
  }

  function orchestrationAvailable(): boolean {
    return pi.getActiveTools().some(name => ORCHESTRATION_TOOL_PATTERN.test(name));
  }

  function subagentAvailable(): boolean {
    return pi.getActiveTools().some(name => /subagent/i.test(name));
  }

  function recordRoute(
    ctx: ExtensionContext,
    decision: RouteDecision,
    via: RoutedPayload["via"],
    from: string | undefined,
    noop: boolean,
    dispatched: boolean,
    orchestrationInjected: boolean,
    split?: { index: number; total: number },
  ): RoutedPayload {
    const payload: RoutedPayload = {
      tier: decision.debug.resolved_model_level,
      from,
      to: decision.model.ref,
      thinking: decision.nativeThinking,
      via,
      noop,
      dispatched,
      orchestrationInjected,
      ...(split ? { split } : {}),
      debug: decision.debug,
    };
    lastRoute = { ...payload, at: Date.now() };
    pi.events.emit(ROUTED_CHANNEL, payload);
    updateStatus(ctx);
    if (config.debug && ctx.hasUI) ctx.ui.notify(`pi-auto-router debug: ${JSON.stringify(decision.debug)}`, "info");
    return payload;
  }

  async function applyDecision(
    ctx: ExtensionContext,
    decision: RouteDecision,
    via: RoutedPayload["via"],
    launch?: { prompt: string; imageCount: number; contextFiles: string[]; skills: string[]; kind?: string },
  ): Promise<{ ok: boolean; dispatched: boolean; message: string; parentDispatch?: string }> {
    const target = findModel(ctx, decision.model.ref);
    if (!target) {
      const error = `unknown model ${decision.model.ref}`;
      pi.events.emit(FAILED_CHANNEL, { error, via } satisfies FailedPayload);
      return { ok: false, dispatched: false, message: `pi-auto-router: ${error}.` };
    }
    if (!hasAuth(ctx, target)) {
      const error = `no auth for ${decision.model.ref}`;
      pi.events.emit(FAILED_CHANNEL, { error, via } satisfies FailedPayload);
      return { ok: false, dispatched: false, message: `pi-auto-router: ${error}; sign in first.` };
    }

    const from = modelRef(ctx.model);
    const noop = !shouldDispatch(from, decision, pi.getThinkingLevel());
    const orchestration = resolveOrchestration(decision, orchestrationAvailable());

    if (!launch) {
      recordRoute(ctx, decision, via, from, noop, false, false);
      return {
        ok: true,
        dispatched: false,
        message: `pi-auto-router: ${decision.debug.canonical_model_level} -> ${decision.debug.resolved_model_level} (${from ?? "none"} stays, target ${decision.model.ref}:${decision.nativeThinking ?? "inherit"}).`,
      };
    }

    if (answerInline(decision, launch?.kind)) {
      recordRoute(ctx, decision, via, from, true, false, false);
      return {
        ok: true,
        dispatched: false,
        message: `pi-auto-router: ${decision.debug.canonical_model_level} work; ${from ?? "the parent"} answers in chat, no worker launched.`,
      };
    }

    if (noop) {
      recordRoute(ctx, decision, via, from, true, false, false);
      return {
        ok: true,
        dispatched: false,
        message: `pi-auto-router: already on ${decision.model.ref}:${decision.nativeThinking ?? "inherit"}; parent handles this turn.`,
      };
    }

    if (!subagentAvailable()) {
      const error = "subagent tool is not active";
      pi.events.emit(FAILED_CHANNEL, { error, via } satisfies FailedPayload);
      return { ok: false, dispatched: false, message: `pi-auto-router: ${error}; parent model left unchanged.` };
    }

    const parentDispatch = buildParentDispatch(decision, {
      cwd: ctx.cwd,
      sessionName: pi.getSessionName?.(),
      parentModel: from,
      parentThinking: pi.getThinkingLevel(),
      profile: config.activeProfile,
      prompt: launch.prompt,
      imageCount: launch.imageCount,
      contextFiles: launch.contextFiles,
      skills: launch.skills,
      history: sessionTurns(ctx),
      orchestration: orchestration.prompt,
    });
    recordRoute(ctx, decision, via, from, false, true, !!orchestration.prompt);
    return {
      ok: true,
      dispatched: true,
      message: `pi-auto-router: dispatch ${from ?? "none"} stays -> worker ${decision.model.ref}:${decision.nativeThinking ?? "inherit"}.`,
      parentDispatch,
    };
  }

  function findJudge(ctx: ExtensionContext): Model<any> | undefined {
    const { judgeModel } = activeProfile(config);
    if (judgeModel === JUDGE_HEURISTIC) return undefined;
    // Unset means the default: score with whatever model is currently selected.
    if (!judgeModel || judgeModel === JUDGE_CURRENT) return ctx.model;
    return findModel(ctx, judgeModel);
  }

  function judgeEffort(): PiThinking {
    const configured = activeProfile(config).judgeThinking;
    return configured === "inherit" ? (pi.getThinkingLevel() as PiThinking) : configured ?? "high";
  }

  function completionText(response: { content: { type: string }[] }): string {
    return response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map(part => part.text)
      .join("\n");
  }

  /** Stage 1 (Judge): Jev by default; otherwise the prompted model (or an explicit judge). */
  async function classifyWithLlm(prompt: string, ctx: ExtensionContext): Promise<{ scores: Scores } | undefined> {
    const judge = findJudge(ctx);
    if (!judge || !hasAuth(ctx, judge)) return undefined;
    try {
      const signal = ctx.signal ?? AbortSignal.timeout(JUDGE_TIMEOUT_MS);
      const response = await ctx.modelRegistry.complete(
        judge,
        {
          systemPrompt: buildJudgeSystemPrompt(),
          messages: [
            { role: "user", content: [{ type: "text", text: buildJudgeUserPrompt(prompt) }], timestamp: Date.now() },
          ],
        },
        { signal, reasoningEffort: judgeEffort(), cacheRetention: "none" } as Parameters<
          ExtensionContext["modelRegistry"]["complete"]
        >[2],
      );
      const scores = parseJudgeScores(completionText(response));
      return scores ? { scores } : undefined;
    } catch {
      return undefined;
    }
  }

  async function classify(prompt: string, ctx: ExtensionContext): Promise<{ scores: Scores; kind?: string }> {
    const heuristic = { scores: heuristicScores(prompt) as Scores };
    if (activeProfile(config).judgeModel === JUDGE_HEURISTIC) return heuristic;
    if (config.useJev && typesafeConfigured()) {
      try {
        const result = await classifyWithJev(prompt, sessionHistory(ctx), {
          signal: ctx.signal,
          timeoutMs: JUDGE_TIMEOUT_MS,
        });
        return { scores: result.scores, kind: result.read.kind };
      } catch {
        // Missing/failed Jev: the prompted agent (or explicit judge) decides.
      }
    }
    return (await classifyWithLlm(prompt, ctx)) ?? heuristic;
  }

  /** Stage 0 (Split check): runs before the judge, so the judge can score each task on its own. */
  async function checkSplit(prompt: string, ctx: ExtensionContext): Promise<boolean> {
    const local = heuristicSplitCheck(prompt);
    if (!config.useJev || !typesafeConfigured()) return wantsSplit(local);
    try {
      return wantsSplit(
        await checkSplitWithJev(prompt, sessionHistory(ctx), { signal: ctx.signal, timeoutMs: JUDGE_TIMEOUT_MS }),
      );
    } catch {
      return wantsSplit(local);
    }
  }

  /**
   * Stage 0b (Splitter): local task list first, then the judge model if that
   * did not find two pieces (the current model when the profile judges with
   * `current` or the heuristic). Fewer than two tasks means "not split".
   */
  async function splitTasks(prompt: string, ctx: ExtensionContext): Promise<SubTask[]> {
    const local = splitLocally(prompt);
    if (local.length >= 2) return local;
    const splitter = findJudge(ctx) ?? ctx.model;
    if (!splitter || !hasAuth(ctx, splitter)) return [];
    try {
      const signal = ctx.signal ?? AbortSignal.timeout(SPLIT_TIMEOUT_MS);
      const response = await ctx.modelRegistry.complete(
        splitter,
        {
          systemPrompt: buildSplitSystemPrompt(),
          messages: [
            { role: "user", content: [{ type: "text", text: buildSplitUserPrompt(prompt) }], timestamp: Date.now() },
          ],
        },
        { signal, reasoningEffort: judgeEffort(), cacheRetention: "none" } as Parameters<
          ExtensionContext["modelRegistry"]["complete"]
        >[2],
      );
      return parseSubTasks(completionText(response));
    } catch {
      return [];
    }
  }

  /**
   * Split path: check, split, judge each task. Cheap chat/lookup pieces stay with
   * the parent; the rest get workers. Undefined means this is not a split (or the
   * split is not dispatchable) and the caller should route the whole prompt as one task.
   * Empty string means every piece stayed with the parent: no worker, no extra classify.
   */
  async function routeSplit(
    ctx: ExtensionContext,
    launch: { prompt: string; imageCount: number; contextFiles: string[]; skills: string[] },
  ): Promise<string | undefined> {
    // No worker tool means no split to dispatch; the single path reports that failure.
    if (!subagentAvailable() || !(await checkSplit(launch.prompt, ctx))) return undefined;
    const tasks = await splitTasks(launch.prompt, ctx);
    if (tasks.length < 2) return undefined;

    const toolsAvailable = orchestrationAvailable();
    const routed: RoutedSubTask[] = [];
    for (const task of tasks) {
      const classified = await classify(task.prompt, ctx);
      const decision = buildRouteDecision(config, classified.scores);
      if (!decision) return undefined;
      const target = findModel(ctx, decision.model.ref);
      if (!target || !hasAuth(ctx, target)) {
        const error = target ? `no auth for ${decision.model.ref}` : `unknown model ${decision.model.ref}`;
        pi.events.emit(FAILED_CHANNEL, { error, via: "auto" } satisfies FailedPayload);
        return undefined;
      }
      routed.push({
        task,
        decision,
        kind: classified.kind,
        orchestration: resolveOrchestration(decision, toolsAvailable).prompt,
      });
    }

    const { inline, workers } = partitionRoutedTasks(routed);
    if (workers.length === 0) return "";
    if (workers.length === 1 && inline.length === 0) return undefined;

    const from = modelRef(ctx.model);
    const dispatch = buildSplitDispatch(
      workers,
      {
        cwd: ctx.cwd,
        sessionName: pi.getSessionName?.(),
        parentModel: from,
        parentThinking: pi.getThinkingLevel(),
        profile: config.activeProfile,
        prompt: launch.prompt,
        imageCount: launch.imageCount,
        contextFiles: launch.contextFiles,
        skills: launch.skills,
        history: sessionTurns(ctx),
      },
      inline,
    );
    workers.forEach((entry, index) => {
      recordRoute(ctx, entry.decision, "auto", from, false, true, !!entry.orchestration, {
        index: index + 1,
        total: workers.length,
      });
    });
    for (const entry of inline) {
      recordRoute(ctx, entry.decision, "auto", from, true, false, false);
    }
    return dispatch;
  }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    config = loadConfig();
    configureTaskStore(join(getAgentDir(), "pi-auto-router-tasks"));
    updateStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    latestCtx = ctx;
  });

  pi.events.on(REQUEST_CHANNEL, (data: unknown) => {
    void (async () => {
      if (!latestCtx) {
        pi.events.emit(FAILED_CHANNEL, { error: "no active session context yet", via: "bus" } satisfies FailedPayload);
        return;
      }
      if (!config.enabled) {
        pi.events.emit(FAILED_CHANNEL, { error: "router is off", via: "bus" } satisfies FailedPayload);
        return;
      }
      const scores = normalizeBusScores(data);
      if (!scores) {
        pi.events.emit(FAILED_CHANNEL, { error: "bad request; need { modelScore, thinkingScore }", via: "bus" } satisfies FailedPayload);
        return;
      }
      const decision = buildRouteDecision(config, scores);
      if (!decision) {
        pi.events.emit(FAILED_CHANNEL, { error: "no tier is enabled", via: "bus" } satisfies FailedPayload);
        return;
      }
      await applyDecision(latestCtx, decision, "bus");
    })();
  });

  pi.on("tool_call", event => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    const task = input.task;
    if (typeof task !== "string") return;
    const resolved = resolveWorkerTask(task);
    if (resolved !== task) input.task = resolved;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx;
    if (!config.enabled || judging || inSubagentChild()) return;
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    if (!prompt.trim()) return;
    judging = true;
    try {
      const launch = {
        prompt,
        imageCount: event.images?.length ?? 0,
        contextFiles: resourceNames(event.systemPromptOptions?.contextFiles),
        skills: resourceNames(event.systemPromptOptions?.skills),
      };
      const split = config.splitCheckEnabled ? await routeSplit(ctx, launch) : undefined;
      if (split) return { message: { customType: "pi-auto-router", content: split, display: true } };
      if (split === "") return;
      const needModelScore = config.overrideModel.kind !== "model";
      const needThinkingScore = config.overrideThinking.kind === "auto";
      const classified =
        needModelScore || needThinkingScore ? await classify(prompt, ctx) : { scores: { modelScore: 0, thinkingScore: 0 } };
      const decision = buildRouteDecision(config, classified.scores);
      if (!decision) return;
      const result = await applyDecision(ctx, decision, "auto", { ...launch, kind: classified.kind });
      if (!result.ok && ctx.hasUI) ctx.ui.notify(result.message, "warning");
      if (result.parentDispatch) {
        return {
          message: { customType: "pi-auto-router", content: result.parentDispatch, display: true },
        };
      }
    } finally {
      judging = false;
    }
  });

  function completeModels(prefix: string): { value: string; label: string; description: string }[] | null {
    if (!latestCtx) return null;
    const normalized = prefix.toLowerCase().trimStart();
    const items = [JUDGE_CURRENT, JUDGE_HEURISTIC]
      .filter(value => value.startsWith(normalized))
      .map(value => ({
        value,
        label: value,
        description: value === JUDGE_CURRENT ? "Judge with the selected model (default)" : "Use the local heuristic",
      }));
    items.push(
      ...latestCtx.modelRegistry
        .getAvailable()
        .map(model => `${model.provider}/${model.id}`)
        .filter(ref => ref.toLowerCase().startsWith(normalized))
        .slice(0, 30)
        .map(value => ({ value, label: value, description: "Judge with this model" })),
    );
    return items.length > 0 ? items : null;
  }

  pi.registerCommand("auto-router", {
    description: "Toggle auto-router bare, or /auto-router [on|off|status|<profile name>]",
    getArgumentCompletions: (prefix: string) => {
      const names = ["on", "off", "status", ...Object.keys(config.profiles)];
      const normalized = prefix.toLowerCase().trimStart();
      const items = names
        .filter(name => name.toLowerCase().startsWith(normalized))
        .map(value => ({ value, label: value, description: "Auto-router switch or profile" }));
      return items.length > 0 ? items : null;
    },
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const arg = rawArgs.trim();
      const lower = arg.toLowerCase();
      if (!arg) {
        config.enabled = !config.enabled;
        saveConfig(config);
        updateStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: ${config.enabled ? "on" : "off"}.`, "info");
        return;
      }
      if (lower === "status") {
        showStatus(ctx);
        return;
      }
      if (lower === "on" || lower === "off") {
        config.enabled = lower === "on";
        saveConfig(config);
        updateStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: ${config.enabled ? "on" : "off"}.`, "info");
        return;
      }
      if (config.profiles[arg]) {
        config.activeProfile = arg;
        saveConfig(config);
        updateStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: profile -> ${arg}.`, "info");
        return;
      }
      const available = Object.keys(config.profiles).join(", ") || "(none)";
      if (ctx.hasUI) ctx.ui.notify(`Unknown profile ${JSON.stringify(arg)}. Available: ${available}.`, "error");
    },
  });

  pi.registerCommand("auto-router-profile", {
    description: "Manage profiles: /auto-router-profile [list|new <name>|clone <name>|delete <name>]",
    getArgumentCompletions: (prefix: string) => {
      const names = ["list", "new", "clone", "delete"];
      const normalized = prefix.toLowerCase().trimStart();
      const items = names
        .filter(name => name.startsWith(normalized))
        .map(value => ({ value, label: value, description: "Profile action" }));
      return items.length > 0 ? items : null;
    },
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const [action, ...rest] = rawArgs.trim().split(/\s+/);
      const name = rest.join(" ").trim();
      if (!action || action === "list") {
        const lines = Object.keys(config.profiles).map(n => (n === config.activeProfile ? `* ${n}` : `  ${n}`));
        if (ctx.hasUI) ctx.ui.notify(`Profiles:\n${lines.join("\n")}`, "info");
        return;
      }
      if (action === "new") {
        if (!name) {
          if (ctx.hasUI) ctx.ui.notify("Usage: /auto-router-profile new <name>", "error");
          return;
        }
        if (config.profiles[name]) {
          if (ctx.hasUI) ctx.ui.notify(`Profile ${JSON.stringify(name)} already exists.`, "error");
          return;
        }
        config.profiles[name] = { tiers: {}, judgeModel: JUDGE_CURRENT, judgeThinking: "high" };
        config.activeProfile = name;
        saveConfig(config);
        updateStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: created and switched to profile ${name}.`, "info");
        return;
      }
      if (action === "clone") {
        if (!name) {
          if (ctx.hasUI) ctx.ui.notify("Usage: /auto-router-profile clone <new name>", "error");
          return;
        }
        if (config.profiles[name]) {
          if (ctx.hasUI) ctx.ui.notify(`Profile ${JSON.stringify(name)} already exists.`, "error");
          return;
        }
        config.profiles[name] = JSON.parse(JSON.stringify(activeProfile(config)));
        config.activeProfile = name;
        saveConfig(config);
        updateStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: cloned into profile ${name} and switched to it.`, "info");
        return;
      }
      if (action === "delete") {
        if (!name || !config.profiles[name]) {
          if (ctx.hasUI) ctx.ui.notify(`Usage: /auto-router-profile delete <existing name>`, "error");
          return;
        }
        if (Object.keys(config.profiles).length <= 1) {
          if (ctx.hasUI) ctx.ui.notify("pi-auto-router: cannot delete the last remaining profile.", "error");
          return;
        }
        delete config.profiles[name];
        if (config.activeProfile === name) config.activeProfile = Object.keys(config.profiles)[0]!;
        saveConfig(config);
        updateStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: deleted profile ${name}.`, "info");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Usage: /auto-router-profile [list|new <name>|clone <name>|delete <name>]", "error");
    },
  });

  pi.registerCommand("auto-router-config", {
    description: "Interactive auto-router settings: judge, tiers, models, ultra thinking",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await runConfigUI(ctx as unknown as ConfigCommandCtx, {
        getConfig: () => config,
        save: next => {
          const wasEnabled = config.thinkingUltraEnabled;
          config = next;
          saveConfig(config);
          if (!wasEnabled && config.thinkingUltraEnabled && ctx.hasUI) {
            ctx.ui.notify(ULTRA_THINKING_WARNING, "warning");
          }
        },
        updateStatus,
      });
    },
  });

  pi.registerCommand("auto-router-judge", {
    description: "Unrecommended: set a specific LLM judge. Default is Jev, then the prompted model. /auto-router-judge [provider/model[:thinking]|current[:thinking]|heuristic]",
    getArgumentCompletions: (prefix: string) => completeModels(prefix),
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const arg = rawArgs.trim();
      const profile = activeProfile(config);
      if (!arg) {
        if (ctx.hasUI) ctx.ui.notify(`Judge (profile ${config.activeProfile}): ${judgeLabel()}`, "info");
        return;
      }
      if (arg.toLowerCase() === "clear" || arg.toLowerCase() === "none" || arg.toLowerCase() === JUDGE_HEURISTIC) {
        profile.judgeModel = JUDGE_HEURISTIC;
        saveConfig(config);
        if (ctx.hasUI) ctx.ui.notify("pi-auto-router: judge cleared; using heuristic.", "info");
        return;
      }
      const colon = arg.lastIndexOf(":");
      const slash = arg.indexOf("/");
      const hasSuffix = colon > 0 && (slash < 0 || colon > slash) && isPiThinking(arg.slice(colon + 1).toLowerCase());
      const suffix = hasSuffix ? (arg.slice(colon + 1).toLowerCase() as PiThinking) : undefined;
      const ref = hasSuffix ? arg.slice(0, colon) : arg;
      if (ref.toLowerCase() === JUDGE_CURRENT) {
        profile.judgeModel = JUDGE_CURRENT;
        profile.judgeThinking = suffix ?? profile.judgeThinking ?? "high";
        saveConfig(config);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: judge -> ${judgeLabel()}.`, "info");
        return;
      }
      if (!ref.includes("/")) {
        if (ctx.hasUI) ctx.ui.notify(`Expected "provider/model[:thinking]" or "current", got ${JSON.stringify(arg)}.`, "error");
        return;
      }
      profile.judgeModel = ref;
      profile.judgeThinking = suffix ?? profile.judgeThinking ?? "high";
      saveConfig(config);
      if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: judge -> ${judgeLabel()}.`, "info");
    },
  });

  pi.registerCommand("auto-router-jev", {
    description: "Toggle Jev (TypeSafe) scoring: /auto-router-jev [on|off|status]",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const arg = rawArgs.trim().toLowerCase();
      if (arg === "on") config.useJev = true;
      else if (arg === "off") config.useJev = false;
      else if (arg && arg !== "status") {
        if (ctx.hasUI) ctx.ui.notify('Expected "on", "off", or "status".', "error");
        return;
      }
      if (arg === "on" || arg === "off") saveConfig(config);
      const key = typesafeConfigured() ? "key present" : "no API key";
      if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: jev ${config.useJev ? "on" : "off"} (${key}).`, "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("auto-router-split", {
    description: "Toggle the pre-judge split check (route a request across several workers): /auto-router-split [on|off|status]",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const arg = rawArgs.trim().toLowerCase();
      if (arg === "on") config.splitCheckEnabled = true;
      else if (arg === "off") config.splitCheckEnabled = false;
      else if (arg && arg !== "status") {
        if (ctx.hasUI) ctx.ui.notify('Expected "on", "off", or "status".', "error");
        return;
      }
      if (arg === "on" || arg === "off") saveConfig(config);
      if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: split check ${config.splitCheckEnabled ? "on" : "off"}.`, "info");
    },
  });

  pi.registerCommand("auto-router-override", {
    description: "Force routing: /auto-router-override model <auto|provider/model|tier:<level>> | thinking <auto|inherit|<level>> | clear",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const [axis, ...rest] = rawArgs.trim().split(/\s+/);
      const value = rest.join(" ").trim();
      if (axis === "clear" || (!axis && !value)) {
        config.overrideModel = { kind: "auto" };
        config.overrideThinking = { kind: "auto" };
        saveConfig(config);
        if (ctx.hasUI) ctx.ui.notify("pi-auto-router: overrides cleared.", "info");
        return;
      }
      if (axis === "model") {
        let override: ModelOverride;
        if (!value || value === "auto") override = { kind: "auto" };
        else if (value.toLowerCase().startsWith("tier:")) {
          const tier = value.slice(5).trim() as CanonicalLevel;
          if (!(CANONICAL_LEVELS as readonly string[]).includes(tier)) {
            if (ctx.hasUI) ctx.ui.notify(`Unknown tier ${JSON.stringify(tier)}.`, "error");
            return;
          }
          override = { kind: "tier", tier };
        } else if (value.includes("/")) {
          override = { kind: "model", ref: value };
        } else {
          if (ctx.hasUI) ctx.ui.notify(`Expected "auto", "tier:<level>", or "provider/model", got ${JSON.stringify(value)}.`, "error");
          return;
        }
        config.overrideModel = override;
        saveConfig(config);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: model override -> ${JSON.stringify(override)}.`, "info");
        return;
      }
      if (axis === "thinking") {
        let override: ThinkingOverride;
        if (!value || value === "auto") override = { kind: "auto" };
        else if (value === "inherit") override = { kind: "inherit" };
        else if (isPiThinking(value.toLowerCase())) override = { kind: "level", level: value.toLowerCase() as PiThinking };
        else {
          if (ctx.hasUI) ctx.ui.notify(`Expected "auto", "inherit", or a thinking level, got ${JSON.stringify(value)}.`, "error");
          return;
        }
        config.overrideThinking = override;
        saveConfig(config);
        if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: thinking override -> ${JSON.stringify(override)}.`, "info");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Usage: /auto-router-override <model|thinking> <value> | clear", "error");
    },
  });

  pi.registerCommand("auto-router-debug", {
    description: "Toggle exposing the routing debug object: /auto-router-debug [on|off]",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const arg = rawArgs.trim().toLowerCase();
      config.debug = arg ? arg === "on" : !config.debug;
      saveConfig(config);
      if (ctx.hasUI) ctx.ui.notify(`pi-auto-router: debug ${config.debug ? "on" : "off"}.`, "info");
    },
  });

  pi.registerCommand("auto-router-route", {
    description: "Manual one-shot route: /auto-router-route <model_score 0..1> [thinking_score 0..1]",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const [modelRaw, thinkingRaw] = rawArgs.trim().split(/\s+/);
      const modelScore = Number(modelRaw);
      if (!Number.isFinite(modelScore)) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /auto-router-route <model_score 0..1> [thinking_score 0..1]", "error");
        return;
      }
      const thinkingScore = thinkingRaw === undefined ? modelScore : Number(thinkingRaw);
      const scores: Scores = {
        modelScore: Math.min(1, Math.max(0, modelScore)),
        thinkingScore: Number.isFinite(thinkingScore) ? Math.min(1, Math.max(0, thinkingScore)) : modelScore,
      };
      const decision = buildRouteDecision(config, scores);
      if (!decision) {
        if (ctx.hasUI) ctx.ui.notify("pi-auto-router: no tier is enabled; nothing to route to.", "warning");
        return;
      }
      const result = await applyDecision(ctx, decision, "command");
      if (ctx.hasUI) ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });
}
