import { expect, test } from "bun:test";
import {
  buildSplitSystemPrompt,
  buildSplitUserPrompt,
  heuristicSplitCheck,
  MAX_SUBTASKS,
  parseSubTasks,
  splitCheckFromJev,
  splitLocally,
  splitQuestions,
  wantsSplit,
} from "../src/split.ts";
import type { JevAnswer } from "../src/jev.ts";

function noul(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

function score(value: number): JevAnswer {
  return { type: "score", score: value, confidence: 0.9 };
}

test("the heuristic check only fires on an explicit delegation ask", () => {
  expect(heuristicSplitCheck("use subagents to audit each module").requested).toBe(true);
  expect(heuristicSplitCheck("Review the backend and the frontend in parallel").requested).toBe(true);
  expect(heuristicSplitCheck("split this up into separate tasks").requested).toBe(true);
  expect(heuristicSplitCheck("what does this function return?").requested).toBe(false);
  expect(heuristicSplitCheck("implement a rate limiter").requested).toBe(false);
});

test("wantsSplit needs either an explicit ask or a worthwhile multi-task read", () => {
  expect(wantsSplit({ requested: true, worthwhile: false, taskEstimate: 1, source: "heuristic" })).toBe(true);
  expect(wantsSplit({ requested: false, worthwhile: true, taskEstimate: 3, source: "jev" })).toBe(true);
  expect(wantsSplit({ requested: false, worthwhile: true, taskEstimate: 1, source: "jev" })).toBe(false);
  expect(wantsSplit({ requested: false, worthwhile: false, taskEstimate: 3, source: "jev" })).toBe(false);
});

test("the split check reads independent work, gain, and task count from Jev", () => {
  const questions = splitQuestions();
  expect(Object.keys(questions)).toEqual(["subagentRequested", "independentWork", "splitGain", "taskCount"]);

  const split = splitCheckFromJev({
    subagentRequested: noul(0.1),
    independentWork: noul(0.9),
    splitGain: noul(0.8),
    taskCount: score(2),
  });
  expect(split).toEqual({ requested: false, worthwhile: true, taskEstimate: MAX_SUBTASKS, source: "jev" });

  // Independent parts that gain nothing from separate agents are not a split.
  const noGain = splitCheckFromJev({
    subagentRequested: noul(0),
    independentWork: noul(0.9),
    splitGain: noul(0.2),
    taskCount: score(1),
  });
  expect(noGain.worthwhile).toBe(false);
  expect(noGain.taskEstimate).toBe(3);

  // Even-or-better noul (0.5) is a yes: Jev sat just under 0.6 on real splits.
  expect(
    splitCheckFromJev({
      subagentRequested: noul(0),
      independentWork: noul(0.5),
      splitGain: noul(0.5),
      taskCount: score(1),
    }).worthwhile,
  ).toBe(true);

  // A question: one task, nothing to fan out.
  expect(splitCheckFromJev({}).taskEstimate).toBe(1);
  expect(wantsSplit(splitCheckFromJev({}))).toBe(false);
});

test("parseSubTasks reads the task list and caps it", () => {
  const tasks = parseSubTasks(
    'noise {"tasks":[{"title":"Backend","prompt":"Audit the API"},{"prompt":"Audit the UI"}]} trailing',
  );
  expect(tasks).toEqual([
    { title: "Backend", prompt: "Audit the API" },
    { title: "Task 2", prompt: "Audit the UI" },
  ]);

  const many = parseSubTasks(JSON.stringify({ tasks: Array.from({ length: 9 }, (_, i) => ({ prompt: `t${i}` })) }));
  expect(many).toHaveLength(MAX_SUBTASKS);
});

test("parseSubTasks returns nothing for malformed or empty output", () => {
  expect(parseSubTasks("not json")).toEqual([]);
  expect(parseSubTasks('{"tasks":"nope"}')).toEqual([]);
  expect(parseSubTasks('{"tasks":[{"title":"empty","prompt":"  "}]}')).toEqual([]);
  expect(parseSubTasks(undefined)).toEqual([]);
});

test("splitLocally covers the labelled mixed and multi-worker prompts", () => {
  const titles = (prompt: string) => splitLocally(prompt).map(task => task.prompt.toLowerCase());

  const timePnp = titles("what time of day is it, and also solve p=np");
  expect(timePnp).toHaveLength(2);
  expect(timePnp[0]).toContain("time of day");
  expect(timePnp[1]).toContain("p=np");

  const twoProofs = titles("solve p=np, also solve hodge conjecture");
  expect(twoProofs).toHaveLength(2);
  expect(twoProofs[1]).toContain("hodge");

  const editTest = titles(
    "Fix the typo decsions in README, and add a test that answerInline returns true for scores 0.01/0.01 on the Claude none-tier.",
  );
  expect(editTest).toHaveLength(2);
  expect(editTest[0]).toContain("readme");
  expect(editTest[1]).toContain("test");

  const files = titles(
    "Rewrite the split-check section of README.md, and separately fuzz parseSubTasks in tests/split.test.ts with malformed JSON.",
  );
  expect(files.length).toBeGreaterThanOrEqual(2);

  const numbered = titles(
    "Use subagents in parallel: (1) rewrite README split-check, (2) fuzz parseSubTasks, (3) audit dispatch.ts for handle leaks.",
  );
  expect(numbered).toHaveLength(3);

  const dosing = titles(
    "Explain gentamicin once-daily dosing, and also add JSDoc to answerInline in src/router.ts.",
  );
  expect(dosing).toHaveLength(2);
  expect(dosing[0]).toContain("gentamicin");
  expect(dosing[1]).toContain("jsdoc");

  const reviews = titles(
    "Review src/split.ts, src/dispatch.ts, and src/router.ts independently for bugs; do not share findings until the end.",
  );
  expect(reviews).toHaveLength(3);

  expect(splitLocally("State the three Sylow theorems, define a normal subgroup, and give one example of a non-abelian group of order 8.")).toEqual([]);
  expect(
    splitLocally(
      "First measure Jev latency for 10 classify calls, then use those numbers to write a short delay report in README, then add a test that the report file exists.",
    ),
  ).toEqual([]);
  expect(splitLocally("audit the api and the ui, use subagents")).toEqual([]);
});

test("the splitter prompt stays provider-agnostic and asks for JSON only", () => {
  const system = buildSplitSystemPrompt();
  expect(system).toContain(`at most ${MAX_SUBTASKS} tasks`);
  expect(system).toContain("Return a single task");
  expect(system).toContain("pipeline");
  expect(system).toContain("Keep a cheap question");
  expect(system).toContain("Return JSON only");
  expect(system).not.toMatch(/provider|anthropic|openai/i);
  expect(buildSplitUserPrompt("x".repeat(20), 5)).toContain("[truncated]");
});
