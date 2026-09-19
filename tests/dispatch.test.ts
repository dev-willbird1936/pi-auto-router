import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  buildParentDispatch,
  buildSplitDispatch,
  buildWorkerTask,
  childThinkingLevel,
  clipEnds,
  configureTaskStore,
  extractTaskHandle,
  forgetMemoryHandles,
  lastUserAssistantPairs,
  partitionRoutedTasks,
  resolveWorkerTask,
  resourceNames,
  shouldDispatch,
  TASK_HANDLE_PREFIX,
} from "../src/dispatch.ts";
import { buildRouteDecision } from "../src/router.ts";
import { normalizeConfig, ORCHESTRATION_PROMPT } from "../src/logic.ts";

test("clipEnds keeps short text and splits long text", () => {
  expect(clipEnds("abc", 2, 2)).toBe("abc");
  const long = "a".repeat(10) + "MID" + "b".repeat(10);
  const clipped = clipEnds(long, 4, 4);
  expect(clipped.startsWith("aaaa")).toBe(true);
  expect(clipped.endsWith("bbbb")).toBe(true);
  expect(clipped).toContain("truncated 15 chars");
});

test("lastUserAssistantPairs keeps the last N completed pairs in order", () => {
  const turns = [
    { role: "user" as const, text: "u1" },
    { role: "assistant" as const, text: "a1" },
    { role: "user" as const, text: "u2" },
    { role: "assistant" as const, text: "a2" },
    { role: "user" as const, text: "u3" },
    { role: "assistant" as const, text: "a3" },
    { role: "user" as const, text: "now" },
  ];
  expect(lastUserAssistantPairs(turns, 2, "now")).toEqual([
    { user: "u2", assistant: "a2" },
    { user: "u3", assistant: "a3" },
  ]);
});

test("resourceNames reads path or name", () => {
  expect(resourceNames([{ path: "AGENTS.md" }, { name: "aptus" }, "raw"])).toEqual(["AGENTS.md", "aptus", "raw"]);
});

test("shouldDispatch is false only when parent already matches", () => {
  const decision = {
    model: { ref: "p/med" },
    nativeThinking: "medium" as const,
    debug: { canonical_thinking_level: "medium" },
  } as any;
  expect(shouldDispatch("p/med", decision, "medium")).toBe(false);
  expect(shouldDispatch("p/low", decision, "medium")).toBe(true);
  expect(shouldDispatch("p/med", decision, "high")).toBe(true);
  expect(shouldDispatch("p/med", { ...decision, nativeThinking: undefined }, "high")).toBe(false);
});

function config() {
  return normalizeConfig({
    version: 2,
    enabled: true,
    profiles: {
      default: {
        tiers: {
          high: { enabled: true, models: [{ ref: "p/high" }] },
          ultra: { enabled: true, models: [{ ref: "p/ultra" }] },
        },
      },
    },
  });
}

test("worker task clips history and lists workspace facts", () => {
  const decision = buildRouteDecision(config(), { modelScore: 0.6, thinkingScore: 0.1 })!;
  expect(childThinkingLevel(decision)).toBe("minimal");
  const user = `U${"x".repeat(5000)}TAILU`;
  const assistant = `A${"y".repeat(7000)}TAILA`;
  const task = buildWorkerTask(decision, {
    cwd: "C:/SyncedProjects/Integrations/Plugins/Pi/pi-auto-router",
    sessionName: "demo",
    parentModel: "p/med",
    parentThinking: "medium",
    profile: "default",
    prompt: "implement a rate limiter",
    imageCount: 1,
    contextFiles: ["AGENTS.md"],
    skills: ["aptus"],
    history: [
      { role: "user", text: user },
      { role: "assistant", text: assistant },
    ],
    orchestration: ORCHESTRATION_PROMPT,
  });
  expect(task).toContain("dir: pi-auto-router");
  expect(task).toContain("implement a rate limiter");
  expect(task).toContain("AGENTS.md");
  expect(task).toContain("aptus");
  expect(task).toContain("truncated");
  expect(task).toContain("TAILU");
  expect(task).toContain("TAILA");
  expect(task).toContain("workflows and subagents");
  const parent = buildParentDispatch(decision, {
    cwd: "C:/work",
    parentModel: "p/med",
    parentThinking: "medium",
    profile: "default",
    prompt: "do it",
    imageCount: 0,
    contextFiles: [],
    skills: [],
    history: [],
  });
  expect(parent).toContain("agent: worker");
  expect(parent).toContain("model: p/high");
  expect(parent).toContain("async: false");
  expect(parent).toContain("do not answer");
  expect(parent).toContain(`task: ${TASK_HANDLE_PREFIX}`);
  expect(parent).toContain("pi-auto-router: stay. worker p/high:");
  expect(parent).not.toContain("You are a routed worker");
  const handle = extractTaskHandle(parent);
  expect(handle).toBeDefined();
  expect(resolveWorkerTask(handle!)).toContain("do it");
  expect(parent.length).toBeLessThan(task.length);
});

test("split dispatch gives every task its own worker, model, and brief", () => {
  const cfg = config();
  const routed = [
    { task: { title: "Backend", prompt: "audit the API" }, decision: buildRouteDecision(cfg, { modelScore: 0.6, thinkingScore: 0.1 })! },
    { task: { title: "Frontend", prompt: "audit the UI" }, decision: buildRouteDecision(cfg, { modelScore: 0.99, thinkingScore: 0.1 })!, orchestration: ORCHESTRATION_PROMPT },
  ];
  const parent = buildSplitDispatch(routed, {
    cwd: "C:/work",
    parentModel: "p/med",
    parentThinking: "medium",
    profile: "default",
    prompt: "audit the API and the UI with one agent each",
    imageCount: 0,
    contextFiles: [],
    skills: [],
    history: [],
  });
  expect(parent).toContain("2 parallel workers");
  expect(parent).toContain("1/2 Backend");
  expect(parent).toContain("model: p/high");
  expect(parent).toContain("2/2 Frontend");
  expect(parent).toContain("model: p/ultra");
  expect(parent).toContain("async: true");
  expect(parent).not.toContain("async: false");
  expect(parent).not.toContain("audit the API");

  const handles = parent.match(/pi-auto-router:task:[0-9a-f-]+/g)!;
  expect(handles).toHaveLength(2);
  const first = resolveWorkerTask(handles[0]!);
  expect(first).toContain("## Current request\naudit the API");
  expect(first).toContain("Split request (task 1 of 2: Backend)");
  expect(first).toContain("audit the API and the UI with one agent each"); // the full request, for context
  expect(first).not.toContain("workflows and subagents");
  expect(resolveWorkerTask(handles[1]!)).toContain("workflows and subagents"); // Ultra task only
});

test("split dispatch keeps cheap pieces with the parent and launches workers for the rest", () => {
  const cfg = config();
  const time = {
    task: { title: "Time", prompt: "what time of day is it" },
    decision: buildRouteDecision(cfg, { modelScore: 0.01, thinkingScore: 0.01 })!,
    kind: "lookup",
  };
  const proof = {
    task: { title: "P vs NP", prompt: "solve p=np" },
    decision: buildRouteDecision(cfg, { modelScore: 0.6, thinkingScore: 0.1 })!,
    kind: "task",
  };
  const { inline, workers } = partitionRoutedTasks([time, proof]);
  expect(inline).toEqual([time]);
  expect(workers).toEqual([proof]);
  const parent = buildSplitDispatch(workers, {
    cwd: "C:/work",
    parentModel: "p/med",
    parentThinking: "medium",
    profile: "default",
    prompt: "what time of day is it, and also solve p=np",
    imageCount: 0,
    contextFiles: [],
    skills: [],
    history: [],
  }, inline);
  expect(parent).toContain("Answer: Time");
  expect(parent).toContain("inline: Time: what time of day is it");
  expect(parent).toContain("worker p/high:");
  expect(parent).toContain("1/1 P vs NP");
  expect(parent).toContain("async: false");
  expect(parent).not.toContain("parallel workers");
});

test("resolveWorkerTask falls back to the last stored brief if the uuid is missing", () => {
  const decision = buildRouteDecision(config(), { modelScore: 0.6, thinkingScore: 0.1 })!;
  const snapshot = {
    cwd: "C:/work",
    parentModel: "p/med",
    parentThinking: "medium",
    profile: "default",
    prompt: "fallback please",
    imageCount: 0,
    contextFiles: [],
    skills: [],
    history: [],
  };
  const parent = buildParentDispatch(decision, snapshot);
  expect(resolveWorkerTask("pi-auto-router:task:00000000-0000-0000-0000-000000000000")).toContain("fallback please");
  expect(extractTaskHandle(parent)).toBeDefined();
});

test("worker task handles persist on disk across a memory miss", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ar-tasks-"));
  configureTaskStore(dir);
  try {
    const parent = buildParentDispatch(buildRouteDecision(config(), { modelScore: 0.6, thinkingScore: 0.1 })!, {
      cwd: "C:/work",
      parentModel: "p/med",
      parentThinking: "medium",
      profile: "default",
      prompt: "persist please",
      imageCount: 0,
      contextFiles: [],
      skills: [],
      history: [],
    });
    const handle = extractTaskHandle(parent)!;
    forgetMemoryHandles();
    expect(resolveWorkerTask(handle)).toContain("persist please");
    forgetMemoryHandles();
    expect(resolveWorkerTask("pi-auto-router:task:00000000-0000-0000-0000-000000000000")).toContain("persist please");
  } finally {
    forgetMemoryHandles();
    configureTaskStore(undefined);
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});
