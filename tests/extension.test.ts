import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Parent-session routing is skipped when PI_SUBAGENT_CHILD=1. Tests often run
// inside a Pi worker, so isolate that env var from the host process.
const hostSubagentChild = process.env.PI_SUBAGENT_CHILD;
const hostTypesafeKey = process.env.TYPESAFE_API_KEY;
const hadTypesafeKey = Object.prototype.hasOwnProperty.call(process.env, "TYPESAFE_API_KEY");
beforeAll(() => {
  delete process.env.PI_SUBAGENT_CHILD;
  process.env.TYPESAFE_API_KEY = "";
});
beforeEach(() => {
  delete process.env.PI_SUBAGENT_CHILD;
  process.env.TYPESAFE_API_KEY = "";
});
afterAll(() => {
  if (hostSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = hostSubagentChild;
  if (hadTypesafeKey) process.env.TYPESAFE_API_KEY = hostTypesafeKey;
  else delete process.env.TYPESAFE_API_KEY;
});

let agentDir = mkdtempSync(join(tmpdir(), "pi-auto-router-"));

mock.module("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
  CONFIG_DIR_NAME: ".pi",
}));

const { default: piAutoRouterExtension, REQUEST_CHANNEL, ROUTED_CHANNEL, FAILED_CHANNEL } = await import(
  "../src/extension.ts"
);
const { extractTaskHandle } = await import("../src/dispatch.ts");

function freshDir(): string {
  agentDir = mkdtempSync(join(tmpdir(), "pi-auto-router-"));
  return agentDir;
}

function writeConfig(dir: string, config: unknown): void {
  writeFileSync(join(dir, "pi-auto-router.json"), `${JSON.stringify(config)}\n`, "utf8");
}

function baseConfig() {
  return {
    version: 2,
    enabled: true,
    thinkingUltraEnabled: false,
    debug: false,
    useJev: false,
    tiers: {
      low: { enabled: true, models: [{ ref: "p/low" }] },
      medium: { enabled: true, models: [{ ref: "p/med" }] },
      high: { enabled: true, models: [{ ref: "p/high" }] },
      max: { enabled: true, models: [{ ref: "p/max" }] },
      ultra: { enabled: true, models: [{ ref: "p/ultra" }] },
    },
    overrideModel: { kind: "auto" },
    overrideThinking: { kind: "auto" },
  };
}

/** `judgeJson` may be a function of the judged text, so a split test can score each task differently. */
function setup(options?: {
  config?: unknown;
  judgeJson?: string | ((text: string) => string);
  splitJson?: string;
  authed?: boolean;
  activeTools?: string[];
}) {
  const dir = freshDir();
  writeConfig(dir, options?.config ?? baseConfig());
  const ids = ["min", "low", "med", "high", "xhigh", "max", "ultra", "judge", "forced"] as const;
  const models = ids.map(id => ({ provider: "p", id, name: id, contextWindow: 200_000 }));
  models.push({ provider: "z", id: "forced", name: "forced", contextWindow: 200_000 } as any);
  let current: any = models.find(m => m.id === "med");
  let thinking = "medium";
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, any>();
  const bus = new Map<string, ((data: any) => void)[]>();
  const emitted: { channel: string; data: any }[] = [];
  const notifications: string[] = [];
  const completeCalls: { ref: string; systemPrompt: string; effort: unknown }[] = [];
  const authed = options?.authed ?? true;
  let activeTools = options?.activeTools ?? ["subagent"];

  const ctx: any = {
    get model() {
      return current;
    },
    mode: "print",
    hasUI: false,
    cwd: process.cwd(),
    signal: undefined,
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 10, contextWindow: 200_000 }),
    modelRegistry: {
      find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
      getAvailable: () => models,
      hasConfiguredAuth: () => authed,
      complete: async (model: any, request: any, opts: any) => {
        completeCalls.push({
          ref: `${model.provider}/${model.id}`,
          systemPrompt: request.systemPrompt,
          effort: opts?.reasoningEffort,
        });
        const splitting = typeof request.systemPrompt === "string" && request.systemPrompt.includes("task splitter");
        const judged = request.messages?.[0]?.content?.[0]?.text ?? "";
        const judgeJson = typeof options?.judgeJson === "function" ? options.judgeJson(judged) : options?.judgeJson;
        const text = splitting ? options?.splitJson ?? '{"tasks":[]}' : judgeJson ?? '{"model_score":0.9,"thinking_score":0.1}';
        return { stopReason: "stop", content: [{ type: "text", text }] };
      },
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  };
  const pi: any = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, def: unknown) => commands.set(name, def),
    registerTool: mock(() => {}),
    getActiveTools: () => activeTools,
    events: {
      emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
      on: (channel: string, handler: (data: unknown) => void) => {
        const list = bus.get(channel) ?? [];
        list.push(handler);
        bus.set(channel, list);
      },
    },
    setModel: async (model: any) => {
      current = model;
      return true;
    },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: string) => {
      thinking = level;
    },
    sendMessage: () => {},
    getSessionName: () => undefined,
  };
  piAutoRouterExtension(pi);
  const fire = (channel: string, data: unknown) => bus.get(channel)?.forEach(h => h(data));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  return {
    pi, ctx, handlers, commands, emitted, notifications, completeCalls, fire, tick, dir,
    currentRef: () => `${current.provider}/${current.id}`,
    thinking: () => thinking,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };
}

async function boot(t: ReturnType<typeof setup>) {
  await t.handlers.get("session_start")?.({}, t.ctx);
}

function expandDispatch(t: ReturnType<typeof setup>, content: string): string {
  const handle = extractTaskHandle(content);
  expect(handle).toBeDefined();
  const input = { agent: "worker", task: handle! };
  t.handlers.get("tool_call")?.({ toolName: "subagent", toolCallId: "test", input }, t.ctx);
  return input.task;
}

test("before_agent_start routes a difficult prompt to a higher tier", async () => {
  const t = setup({ judgeJson: '{"model_score":0.6,"thinking_score":0.1}' });
  await boot(t);
  const config = baseConfig();
  config.judgeModel = "p/judge";
  writeConfig(t.dir, config);
  await boot(t); // reload with judge configured
  const result: any = await t.handlers.get("before_agent_start")?.({ prompt: "implement a rate limiter", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.currentRef()).toBe("p/med");
  expect(t.thinking()).toBe("medium");
  expect(result?.message?.content).toContain("model: p/high");
  expect(result?.message?.content).toContain("agent: worker");
  expect(result?.message?.content).toContain("thinking: minimal");
  expect(t.emitted.some(e => e.channel === ROUTED_CHANNEL && e.data.dispatched)).toBe(true);
  expect(result?.message?.content).toContain("task: pi-auto-router:task:");
  expect(result?.message?.content).not.toContain("implement a rate limiter");
  expect(expandDispatch(t, result?.message?.content)).toContain("implement a rate limiter");
});

const SPLIT_TASKS = '{"tasks":[{"title":"API","prompt":"audit the api"},{"title":"UI","prompt":"audit the ui"}]}';

function splitSetup(options?: { splitJson?: string }) {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  return setup({
    config,
    splitJson: options?.splitJson ?? SPLIT_TASKS,
    // Each task is judged on its own: the api task is harder than the ui task.
    judgeJson: text => (text.includes("api") ? '{"model_score":0.6,"thinking_score":0.1}' : '{"model_score":0.3,"thinking_score":0.1}'),
  });
}

test("a request asking for subagents is split, judged per task, and routed per task", async () => {
  const t = splitSetup();
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "audit the api and the ui, use subagents", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.currentRef()).toBe("p/med"); // the parent never moves
  expect(result?.message?.content).toContain("2 parallel workers");
  expect(result?.message?.content).toContain("1/2 API");
  expect(result?.message?.content).toContain("model: p/high");
  expect(result?.message?.content).toContain("2/2 UI");
  expect(result?.message?.content).toContain("model: p/med");
  expect(result?.message?.content).toContain("async: true");
  expect(expandDispatch(t, result?.message?.content)).toContain("audit the api");

  const routed = t.emitted.filter(e => e.channel === ROUTED_CHANNEL);
  expect(routed).toHaveLength(2);
  expect(routed.map(e => e.data.split)).toEqual([{ index: 1, total: 2 }, { index: 2, total: 2 }]);
  expect(routed.every(e => e.data.dispatched)).toBe(true);
});

test("a cheap split task stays with the parent; the rest get workers", async () => {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  const t = setup({
    config,
    splitJson: '{"tasks":[{"title":"Time","prompt":"what time of day is it"},{"title":"P vs NP","prompt":"solve p=np"}]}',
    judgeJson: text =>
      text.includes("time") ? '{"model_score":0.01,"thinking_score":0.01}' : '{"model_score":0.6,"thinking_score":0.1}',
  });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "what time of day is it, and also solve p=np, use subagents", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(result?.message?.content).toContain("Answer: what time of day is it");
  expect(result?.message?.content).toContain("inline: what time of day is it");
  expect(result?.message?.content).toContain("1/1 solve p=np");
  expect(result?.message?.content).toContain("model: p/high");
  expect(result?.message?.content).toContain("async: false");
  const routed = t.emitted.filter(e => e.channel === ROUTED_CHANNEL);
  expect(routed.filter(e => e.data.dispatched)).toHaveLength(1);
  expect(routed.filter(e => e.data.dispatched === false)).toHaveLength(1);
});

test("a split of only cheap tasks stays in chat with no worker", async () => {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  const t = setup({
    config,
    splitJson: '{"tasks":[{"title":"Thanks","prompt":"thanks"},{"title":"Flag","prompt":"what does auto-router-split do"}]}',
    judgeJson: '{"model_score":0.01,"thinking_score":0.01}',
  });
  await boot(t);
  const result = await t.handlers.get("before_agent_start")?.(
    { prompt: "thanks, and also what does /auto-router-split do, use subagents", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(result).toBeUndefined();
  expect(t.emitted.filter(e => e.channel === ROUTED_CHANNEL && e.data.dispatched)).toHaveLength(0);
});

test("the split check runs before the judge and stays off the splitter for ordinary prompts", async () => {
  const t = splitSetup();
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "audit the api", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.completeCalls.some(c => c.systemPrompt.includes("task splitter"))).toBe(false);
  expect(result?.message?.content).toContain("pi-auto-router: stay");
  expect(result?.message?.content).toContain("do not answer");
});

test("a splitter that returns one task falls back to the single-worker path", async () => {
  const t = splitSetup({ splitJson: '{"tasks":[{"title":"All","prompt":"audit the api and the ui"}]}' });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "audit the api and the ui, use subagents", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.completeCalls.some(c => c.systemPrompt.includes("task splitter"))).toBe(true);
  expect(result?.message?.content).toContain("pi-auto-router: stay");
  expect(result?.message?.content).toContain("do not answer");
  expect(t.emitted.filter(e => e.channel === ROUTED_CHANNEL)).toHaveLength(1);
});

test("/auto-router-split off skips the whole split path", async () => {
  const t = splitSetup();
  await boot(t);
  await (t.commands.get("auto-router-split") as any).handler("off", t.ctx);
  expect(JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8")).splitCheckEnabled).toBe(false);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "audit the api and the ui, use subagents", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.completeCalls.some(c => c.systemPrompt.includes("task splitter"))).toBe(false);
  expect(result?.message?.content).toContain("pi-auto-router: stay");
  expect(result?.message?.content).toContain("do not answer");
});

test("switching profile switches which judge model scores the prompt", async () => {
  const tiers = baseConfig().tiers;
  const config = {
    version: 2,
    enabled: true,
    thinkingUltraEnabled: false,
    debug: false,
    useJev: false,
    activeProfile: "cheap",
    profiles: {
      cheap: { judgeModel: "p/judge", judgeThinking: "low", tiers },
      power: { judgeModel: "p/max", judgeThinking: "xhigh", tiers },
    },
    overrideModel: { kind: "auto" },
    overrideThinking: { kind: "auto" },
  };
  const t = setup({ config });
  await boot(t);
  await t.handlers.get("before_agent_start")?.({ prompt: "anything", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.completeCalls.at(-1)?.ref).toBe("p/judge");
  expect(t.completeCalls.at(-1)?.effort).toBe("low");

  await (t.commands.get("auto-router") as any).handler("power", t.ctx);
  await t.handlers.get("before_agent_start")?.({ prompt: "anything", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.completeCalls.at(-1)?.ref).toBe("p/max");
  expect(t.completeCalls.at(-1)?.effort).toBe("xhigh");
});

test("auto-router-judge writes to the active profile only, leaving other profiles' judges alone", async () => {
  const tiers = baseConfig().tiers;
  const config = {
    version: 2,
    enabled: true,
    thinkingUltraEnabled: false,
    debug: false,
    useJev: false,
    activeProfile: "cheap",
    profiles: {
      cheap: { judgeModel: "p/judge", judgeThinking: "low", tiers },
      power: { judgeModel: "p/max", judgeThinking: "xhigh", tiers },
    },
    overrideModel: { kind: "auto" },
    overrideThinking: { kind: "auto" },
  };
  const t = setup({ config });
  await boot(t);
  await (t.commands.get("auto-router-judge") as any).handler("p/high:max", t.ctx);
  const file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.profiles.cheap.judgeModel).toBe("p/high");
  expect(file.profiles.cheap.judgeThinking).toBe("max");
  expect(file.profiles.power.judgeModel).toBe("p/max");
  expect(file.profiles.power.judgeThinking).toBe("xhigh");
});

test("without a Jev key, scoring uses the prompted model", async () => {
  const config = baseConfig();
  config.useJev = true;
  const t = setup({ config, judgeJson: '{"model_score":0.6,"thinking_score":0.1}' });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.({ prompt: "implement a rate limiter", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.completeCalls.at(-1)?.ref).toBe("p/med");
  expect(result?.message?.content).toContain("model: p/high");
});

test("an explicit judge model is used when Jev has no key", async () => {
  const config = baseConfig();
  config.useJev = true;
  config.judgeModel = "p/judge";
  const t = setup({ config, judgeJson: '{"model_score":0.6,"thinking_score":0.1}' });
  await boot(t);
  await t.handlers.get("before_agent_start")?.({ prompt: "implement a rate limiter", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.completeCalls.at(-1)?.ref).toBe("p/judge");
});

test("an unset judge defaults to scoring with the current model", async () => {
  const t = setup({ judgeJson: '{"model_score":0.6,"thinking_score":0.1}' });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.({ prompt: "hi", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.completeCalls.at(-1)?.ref).toBe("p/med"); // the selected model, not a separate judge
  expect(result?.message?.content).toContain("model: p/high");
});

test("heuristic fallback routes when the judge is explicitly set to the heuristic", async () => {
  const config = baseConfig();
  config.judgeModel = "heuristic";
  const t = setup({ config, judgeJson: '{"model_score":0.6,"thinking_score":0.1}' });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.({ prompt: "refactor the failing middleware test", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.completeCalls.length).toBe(0);
  // heuristic scores this as ~0.35/0.21 -> canonical "medium", which is enabled.
  expect(t.currentRef()).toBe("p/med");
  expect(result?.message?.content).toContain("model: p/med");
});

test("none/minimal work is answered in chat instead of launching a worker", async () => {
  const config = baseConfig();
  config.judgeModel = "heuristic";
  const t = setup({ config });
  await boot(t);
  // The heuristic scores a greeting at ~0.01/0.01: canonical "none" on both axes.
  const result = await t.handlers.get("before_agent_start")?.({ prompt: "hi", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(result).toBeUndefined();
  expect(t.currentRef()).toBe("p/med");
  const routed = t.emitted.filter(e => e.channel === ROUTED_CHANNEL);
  expect(routed).toHaveLength(1);
  expect(routed[0]?.data.dispatched).toBe(false);
  expect(routed[0]?.data.noop).toBe(true);
});

test("/auto-router-judge clear stores the heuristic sentinel so it survives a reload", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-judge") as any).handler("clear", t.ctx);
  const file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.profiles[file.activeProfile].judgeModel).toBe("heuristic");
  await boot(t); // reload
  await t.handlers.get("before_agent_start")?.({ prompt: "hi", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.completeCalls.length).toBe(0);
});

test("sparse tiers fall back to the nearest enabled tier above, never landing on ultra as a fallback", async () => {
  const config = baseConfig();
  config.tiers = { low: { enabled: true, models: [{ ref: "p/low" }] }, ultra: { enabled: true, models: [{ ref: "p/ultra" }] } };
  config.judgeModel = "p/judge";
  const t = setup({ config, judgeJson: '{"model_score":0.8,"thinking_score":0}' }); // "xhigh" canonical, max/ultra above but ultra excluded
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.({ prompt: "anything", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.currentRef()).toBe("p/med");
  expect(result?.message?.content).toContain("model: p/low");
});

test("Model Ultra injects the orchestration prompt once when the tool is available", async () => {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  const t = setup({ config, judgeJson: '{"model_score":0.99,"thinking_score":0}', activeTools: ["subagent"] });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "anything", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.currentRef()).toBe("p/med");
  expect(result?.systemPrompt).toBeUndefined();
  expect(result?.message?.content).toContain("model: p/ultra");
  expect(result?.message?.content).not.toContain("workflows and subagents");
  expect(expandDispatch(t, result.message.content).match(/workflows and subagents/g)?.length).toBe(1);
});

test("missing subagent tool fails without switching the parent model", async () => {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  const t = setup({ config, judgeJson: '{"model_score":0.99,"thinking_score":0}', activeTools: [] });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "anything", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.currentRef()).toBe("p/med");
  expect(result).toBeUndefined();
  expect(t.emitted.some(e => e.channel === FAILED_CHANNEL && e.data.error === "subagent tool is not active")).toBe(true);
});

test("Thinking Ultra disabled by default resolves to Max, not synthetic XHigh", async () => {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  const t = setup({ config, judgeJson: '{"model_score":0.3,"thinking_score":0.99}', activeTools: ["subagent"] });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "anything", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.thinking()).toBe("medium");
  expect(result?.message?.content).toContain("thinking: max");
  expect(result?.message?.content).not.toContain("workflows and subagents");
  expect(expandDispatch(t, result?.message?.content)).not.toContain("workflows and subagents");
});

test("Thinking Ultra enabled triggers synthetic XHigh plus orchestration", async () => {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  config.thinkingUltraEnabled = true;
  const t = setup({ config, judgeJson: '{"model_score":0.3,"thinking_score":0.99}', activeTools: ["subagent"] });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "anything", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.thinking()).toBe("medium");
  expect(result?.message?.content).toContain("thinking: xhigh");
  expect(result?.message?.content).not.toContain("workflows and subagents");
  expect(expandDispatch(t, result?.message?.content)).toContain("workflows and subagents");
});

test("recursion guard: the judge call cannot re-enter before_agent_start", async () => {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  const t = setup({ config });
  await boot(t);
  const handler = t.handlers.get("before_agent_start")!;
  // Simulate the judge's completion synchronously calling back into the same handler
  // (defensive: this must short-circuit and not double-route or recurse further).
  const original = t.ctx.modelRegistry.complete;
  let reentered = false;
  t.ctx.modelRegistry.complete = async (...args: any[]) => {
    reentered = await handler({ prompt: "nested", images: [], systemPrompt: "SYS" }, t.ctx).then(() => true);
    return original(...args);
  };
  await handler({ prompt: "outer", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(reentered).toBe(true); // the nested call ran...
  expect(t.emitted.filter(e => e.channel === ROUTED_CHANNEL)).toHaveLength(1); // ...but only the outer call actually routed.
});

test("bus request routes via modelScore/thinkingScore", async () => {
  const t = setup();
  await boot(t);
  t.fire(REQUEST_CHANNEL, { modelScore: 0.99, thinkingScore: 0 });
  await t.tick();
  expect(t.currentRef()).toBe("p/med");
  expect(t.emitted.some(e => e.channel === ROUTED_CHANNEL && e.data.dispatched === false)).toBe(true);
});

test("bus request fails cleanly when the router is off", async () => {
  const config = baseConfig();
  config.enabled = false;
  const t = setup({ config });
  await boot(t);
  t.fire(REQUEST_CHANNEL, { modelScore: 0.9, thinkingScore: 0.9 });
  await t.tick();
  expect(t.emitted.some(e => e.channel === FAILED_CHANNEL && e.data.error === "router is off")).toBe(true);
});

test("overrides: forced model beats automatic routing", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-override") as any).handler("model z/forced", t.ctx);
  const result: any = await t.handlers.get("before_agent_start")?.({ prompt: "implement something complex", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.currentRef()).toBe("p/med");
  expect(result?.message?.content).toContain("model: z/forced");
});

test("auto-router-route: manual one-shot score bypasses the judge", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-route") as any).handler("0.99 0", t.ctx);
  expect(t.currentRef()).toBe("p/med");
  expect(t.completeCalls).toHaveLength(0);
  expect(t.emitted.some(e => e.channel === ROUTED_CHANNEL && e.data.to === "p/ultra")).toBe(true);
});

test("auto-router-judge accepts current sentinel with thinking suffix", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-judge") as any).handler("current:low", t.ctx);
  const file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.profiles[file.activeProfile].judgeModel).toBe("current");
  expect(file.profiles[file.activeProfile].judgeThinking).toBe("low");
});

test("auto-router-debug toggles and status/route include the debug object", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-debug") as any).handler("on", t.ctx);
  const file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.debug).toBe(true);
});

test("bare auto-router command toggles on and off", async () => {
  const t = setup();
  await boot(t);
  const file = () => JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file().enabled).toBe(true);
  await (t.commands.get("auto-router") as any).handler("", t.ctx);
  expect(file().enabled).toBe(false);
  await (t.commands.get("auto-router") as any).handler("", t.ctx);
  expect(file().enabled).toBe(true);
});

test("/auto-router <name> switches the active profile", async () => {
  const config = baseConfig();
  (config as any).profiles = {
    default: { tiers: config.tiers },
    power: { tiers: { ultra: { enabled: true, models: [{ ref: "p/ultra" }] } } },
  };
  (config as any).activeProfile = "default";
  delete (config as any).tiers;
  const t = setup({ config });
  await boot(t);
  await (t.commands.get("auto-router") as any).handler("power", t.ctx);
  const file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.activeProfile).toBe("power");
  // "power" only maps the "ultra" tier; only that profile's tiers are reachable now.
  await (t.commands.get("auto-router-route") as any).handler("0.99 0", t.ctx);
  expect(t.currentRef()).toBe("p/med");
  expect(t.emitted.some(e => e.channel === ROUTED_CHANNEL && e.data.to === "p/ultra")).toBe(true);
});

test("/auto-router-profile new creates and switches, clone copies the active profile's tiers", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-profile") as any).handler("new cheap", t.ctx);
  let file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.activeProfile).toBe("cheap");
  expect(file.profiles.cheap).toEqual({ tiers: {}, judgeModel: "current", judgeThinking: "high" });
  expect(file.profiles.default).toBeDefined(); // original profile untouched

  await (t.commands.get("auto-router") as any).handler("default", t.ctx);
  await (t.commands.get("auto-router-profile") as any).handler("clone budget", t.ctx);
  file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.activeProfile).toBe("budget");
  expect(file.profiles.budget.tiers.low.models[0].ref).toBe("p/low");
});

test("/auto-router-profile delete removes a profile but refuses to delete the last one", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-profile") as any).handler("new extra", t.ctx);
  await (t.commands.get("auto-router-profile") as any).handler("delete extra", t.ctx);
  let file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.profiles.extra).toBeUndefined();
  expect(file.activeProfile).toBe("default");

  await (t.commands.get("auto-router-profile") as any).handler("delete default", t.ctx);
  file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.profiles.default).toBeDefined(); // refused: cannot delete the last remaining profile
});

test("legacy v1 config on disk migrates transparently at load", async () => {
  const t = setup();
  writeConfig(t.dir, {
    version: 1,
    enabled: true,
    activePreset: "p1",
    presets: { p1: { low: "p/low", high: "p/high" } },
  });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.({ prompt: "implement a rate limiter", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.currentRef()).toBe("p/med");
  expect(result?.message?.content).toContain("model: p/high");
});

test("child sessions skip routing", async () => {
  const prev = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const t = setup({ judgeJson: '{"model_score":0.6,"thinking_score":0.1}' });
    await boot(t);
    const result = await t.handlers.get("before_agent_start")?.({ prompt: "implement a rate limiter", images: [], systemPrompt: "SYS" }, t.ctx);
    expect(result).toBeUndefined();
    expect(t.emitted.filter(e => e.channel === ROUTED_CHANNEL)).toHaveLength(0);
    expect(t.currentRef()).toBe("p/med");
  } finally {
    if (prev === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = prev;
  }
});
