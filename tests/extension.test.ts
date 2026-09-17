import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentDir = mkdtempSync(join(tmpdir(), "pi-auto-router-"));

mock.module("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
  CONFIG_DIR_NAME: ".pi",
}));

const { default: piAutoRouterExtension, REQUEST_CHANNEL, ROUTED_CHANNEL, FAILED_CHANNEL } = await import(
  "../src/extension.ts"
);

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

function setup(options?: { config?: unknown; judgeJson?: string; authed?: boolean; activeTools?: string[] }) {
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
  let activeTools = options?.activeTools ?? [];

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
        return {
          stopReason: "stop",
          content: [{ type: "text", text: options?.judgeJson ?? '{"model_score":0.9,"thinking_score":0.1}' }],
        };
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

test("before_agent_start routes a difficult prompt to a higher tier", async () => {
  const t = setup({ judgeJson: '{"model_score":0.6,"thinking_score":0.1}' });
  await boot(t);
  const config = baseConfig();
  config.judgeModel = "p/judge";
  writeConfig(t.dir, config);
  await boot(t); // reload with judge configured
  await t.handlers.get("before_agent_start")?.({ prompt: "implement a rate limiter", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.currentRef()).toBe("p/high");
  expect(t.thinking()).toBe("minimal");
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

test("heuristic fallback routes without a judge configured", async () => {
  const t = setup();
  await boot(t);
  await t.handlers.get("before_agent_start")?.({ prompt: "hi", images: [], systemPrompt: "SYS" }, t.ctx);
  // heuristic scores a greeting as ~0.01/0.01 -> canonical "none", falls forward to "low" (nearest enabled).
  expect(t.currentRef()).toBe("p/low");
});

test("sparse tiers fall back to the nearest enabled tier above, never landing on ultra as a fallback", async () => {
  const config = baseConfig();
  config.tiers = { low: { enabled: true, models: [{ ref: "p/low" }] }, ultra: { enabled: true, models: [{ ref: "p/ultra" }] } };
  config.judgeModel = "p/judge";
  const t = setup({ config, judgeJson: '{"model_score":0.8,"thinking_score":0}' }); // "xhigh" canonical, max/ultra above but ultra excluded
  await boot(t);
  await t.handlers.get("before_agent_start")?.({ prompt: "anything", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.currentRef()).toBe("p/low");
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
  expect(t.currentRef()).toBe("p/ultra");
  expect(result?.systemPrompt).toContain("SYS");
  expect(result.systemPrompt.match(/workflows and subagents/g)?.length).toBe(1);
});

test("orchestration prompt is omitted when no orchestration tool is registered", async () => {
  const config = baseConfig();
  config.judgeModel = "p/judge";
  const t = setup({ config, judgeJson: '{"model_score":0.99,"thinking_score":0}', activeTools: [] });
  await boot(t);
  const result: any = await t.handlers.get("before_agent_start")?.(
    { prompt: "anything", images: [], systemPrompt: "SYS" },
    t.ctx,
  );
  expect(t.currentRef()).toBe("p/ultra");
  expect(result).toBeUndefined();
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
  expect(t.thinking()).toBe("max");
  expect(result).toBeUndefined(); // no orchestration: Thinking Ultra never triggered
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
  expect(t.thinking()).toBe("xhigh");
  expect(result?.systemPrompt).toContain("workflows and subagents");
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
  expect(t.currentRef()).toBe("p/ultra");
  expect(t.emitted.some(e => e.channel === ROUTED_CHANNEL)).toBe(true);
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
  await t.handlers.get("before_agent_start")?.({ prompt: "implement something complex", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.currentRef()).toBe("z/forced");
});

test("auto-router-route: manual one-shot score bypasses the judge", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-route") as any).handler("0.99 0", t.ctx);
  expect(t.currentRef()).toBe("p/ultra");
  expect(t.completeCalls).toHaveLength(0);
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
  expect(t.currentRef()).toBe("p/ultra");
});

test("/auto-router-profile new creates and switches, clone copies the active profile's tiers", async () => {
  const t = setup();
  await boot(t);
  await (t.commands.get("auto-router-profile") as any).handler("new cheap", t.ctx);
  let file = JSON.parse(readFileSync(join(t.dir, "pi-auto-router.json"), "utf8"));
  expect(file.activeProfile).toBe("cheap");
  expect(file.profiles.cheap).toEqual({ tiers: {} });
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
  await t.handlers.get("before_agent_start")?.({ prompt: "implement a rate limiter", images: [], systemPrompt: "SYS" }, t.ctx);
  expect(t.currentRef()).toBe("p/high");
});
