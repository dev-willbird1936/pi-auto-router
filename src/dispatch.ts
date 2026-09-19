import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ConversationTurn } from "./jev.ts";
import { keepWithParent, type RouteDecision } from "./router.ts";
import type { SubTask } from "./split.ts";

export const USER_HEAD = 2000;
export const USER_TAIL = 2000;
export const ASSISTANT_HEAD = 2000;
export const ASSISTANT_TAIL = 4000;
export const HISTORY_PAIRS = 5;
export const CURRENT_PROMPT_HEAD = 6000;
export const CURRENT_PROMPT_TAIL = 6000;

export function clipEnds(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n…[truncated ${omitted} chars]…\n${text.slice(-tail)}`;
}

export function lastUserAssistantPairs(
  turns: ConversationTurn[],
  count: number,
  currentPrompt?: string,
): { user: string; assistant: string }[] {
  const pairs: { user: string; assistant: string }[] = [];
  let pendingUser: string | undefined;
  const current = currentPrompt?.trim();
  for (const turn of turns) {
    if (turn.role === "user") pendingUser = turn.text;
    else if (turn.role === "assistant" && pendingUser !== undefined) {
      pairs.push({ user: pendingUser, assistant: turn.text });
      pendingUser = undefined;
    }
  }
  if (current && pendingUser?.trim() === current) {
    // Current user turn is not yet a completed pair.
  }
  return pairs.slice(-count);
}

export function resourceNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item) names.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = row.path ?? row.name ?? row.filePath;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

export function childThinkingLevel(decision: RouteDecision): string {
  if (decision.nativeThinking) return decision.nativeThinking;
  const level = decision.debug.canonical_thinking_level;
  if (level === "none") return "off";
  if (level === "ultra") return "xhigh";
  return level;
}

export function shouldDispatch(parentRef: string | undefined, decision: RouteDecision, parentThinking: string): boolean {
  if (parentRef !== decision.model.ref) return true;
  if (!decision.nativeThinking) return false;
  return decision.nativeThinking !== parentThinking;
}

export interface DispatchSnapshot {
  cwd: string;
  sessionName?: string;
  parentModel?: string;
  parentThinking?: string;
  profile: string;
  prompt: string;
  imageCount: number;
  contextFiles: string[];
  skills: string[];
  history: ConversationTurn[];
  orchestration?: string;
  /** Set when the request was split: this worker owns one task of several. */
  subtask?: { index: number; total: number; title: string; fullRequest: string };
}

export function buildWorkerTask(decision: RouteDecision, snapshot: DispatchSnapshot): string {
  const pairs = lastUserAssistantPairs(snapshot.history, HISTORY_PAIRS, snapshot.prompt);
  const history =
    pairs.length === 0
      ? "(none)"
      : pairs
          .map((pair, index) => {
            const n = index + 1;
            return [
              `### ${n} user`,
              clipEnds(pair.user, USER_HEAD, USER_TAIL),
              `### ${n} assistant`,
              clipEnds(pair.assistant, ASSISTANT_HEAD, ASSISTANT_TAIL),
            ].join("\n");
          })
          .join("\n\n");
  const lines = [
    "You are a routed worker. Do the current request. End with a concise summary of what you achieved: files changed, result, and anything left. The parent will only restate that summary.",
    "",
    "## Route",
    `model: ${decision.model.ref}`,
    `thinking: ${childThinkingLevel(decision)}`,
    `tier: ${decision.debug.resolved_model_level}`,
    `profile: ${snapshot.profile}`,
    `model_score: ${decision.debug.model_score}`,
    `thinking_score: ${decision.debug.thinking_score}`,
    "",
    "## Workspace",
    `dir: ${basename(snapshot.cwd) || snapshot.cwd}`,
    `cwd: ${snapshot.cwd}`,
    snapshot.sessionName ? `session: ${snapshot.sessionName}` : undefined,
    `parent: ${snapshot.parentModel ?? "(none)"} [${snapshot.parentThinking ?? "unknown"}]`,
    `images: ${snapshot.imageCount}`,
    snapshot.contextFiles.length ? `context_files: ${snapshot.contextFiles.join(", ")}` : "context_files: (none listed)",
    snapshot.skills.length ? `skills: ${snapshot.skills.join(", ")}` : "skills: (none listed)",
    "",
    "## Recent conversation (oldest first)",
    history,
  ];
  if (snapshot.subtask) {
    const { index, total, title, fullRequest } = snapshot.subtask;
    lines.push(
      "",
      `## Split request (task ${index} of ${total}: ${title})`,
      "Other workers own the other tasks. Do only yours; do not redo or review theirs.",
      "",
      "### Full user request",
      clipEnds(fullRequest, CURRENT_PROMPT_HEAD, CURRENT_PROMPT_TAIL),
    );
  }
  lines.push("", "## Current request", clipEnds(snapshot.prompt, CURRENT_PROMPT_HEAD, CURRENT_PROMPT_TAIL));
  if (snapshot.orchestration) lines.push("", "## Orchestration", snapshot.orchestration);
  return lines.filter(line => line !== undefined).join("\n");
}

export const TASK_HANDLE_PREFIX = "pi-auto-router:task:";
const TASK_HANDLE_RE =
  /pi-auto-router:task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_PENDING_TASKS = 16;
const LAST_TASK_FILE = "last.txt";
const pendingTasks = new Map<string, string>();
let lastWorkerTask: string | undefined;
let taskStoreDir: string | undefined;

export function extractTaskHandle(text: string): string | undefined {
  return text.match(TASK_HANDLE_RE)?.[0];
}

export function configureTaskStore(dir: string | undefined): void {
  taskStoreDir = dir;
  if (dir) mkdirSync(dir, { recursive: true });
}

export function forgetMemoryHandles(): void {
  pendingTasks.clear();
  lastWorkerTask = undefined;
}

function handleId(handle: string): string {
  return handle.slice(TASK_HANDLE_PREFIX.length);
}

function persistTask(handle: string, task: string): void {
  if (!taskStoreDir) return;
  try {
    writeFileSync(join(taskStoreDir, `${handleId(handle)}.txt`), task, "utf8");
    writeFileSync(join(taskStoreDir, LAST_TASK_FILE), task, "utf8");
    const files = readdirSync(taskStoreDir).filter(name => name.endsWith(".txt") && name !== LAST_TASK_FILE);
    if (files.length <= MAX_PENDING_TASKS) return;
    const ranked = files
      .map(name => ({ name, mtime: statSync(join(taskStoreDir!, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    for (const file of ranked.slice(0, files.length - MAX_PENDING_TASKS)) {
      unlinkSync(join(taskStoreDir, file.name));
    }
  } catch {
    // Memory still holds the brief for this process.
  }
}

function readPersistedTask(handle: string): string | undefined {
  if (!taskStoreDir) return undefined;
  try {
    const path = join(taskStoreDir, `${handleId(handle)}.txt`);
    if (existsSync(path)) return readFileSync(path, "utf8");
    const last = join(taskStoreDir, LAST_TASK_FILE);
    if (existsSync(last)) return readFileSync(last, "utf8");
  } catch {
    return undefined;
  }
  return undefined;
}

export function rememberWorkerTask(task: string): string {
  lastWorkerTask = task;
  const handle = `${TASK_HANDLE_PREFIX}${randomUUID()}`;
  pendingTasks.set(handle, task);
  persistTask(handle, task);
  while (pendingTasks.size > MAX_PENDING_TASKS) {
    const oldest = pendingTasks.keys().next().value;
    if (!oldest) break;
    pendingTasks.delete(oldest);
  }
  return handle;
}

export function resolveWorkerTask(taskOrHandle: string): string {
  const handle = extractTaskHandle(taskOrHandle);
  if (!handle) return taskOrHandle;
  const stored = pendingTasks.get(handle) ?? readPersistedTask(handle) ?? lastWorkerTask;
  if (stored === undefined) return taskOrHandle;
  pendingTasks.delete(handle);
  return stored;
}

function workerCall(decision: RouteDecision, snapshot: DispatchSnapshot, handle: string, async: boolean): string[] {
  return [
    "agent: worker",
    `model: ${decision.model.ref}`,
    `thinking: ${childThinkingLevel(decision)}`,
    `async: ${async}`,
    `cwd: ${snapshot.cwd}`,
    "context: fresh",
    `task: ${handle}`,
  ];
}

export function buildParentDispatch(decision: RouteDecision, snapshot: DispatchSnapshot): string {
  const thinking = childThinkingLevel(decision);
  const handle = rememberWorkerTask(buildWorkerTask(decision, snapshot));
  return [
    `pi-auto-router: stay. worker ${decision.model.ref}:${thinking}. do not answer.`,
    ...workerCall(decision, snapshot, handle, false),
  ].join("\n");
}

export interface RoutedSubTask {
  task: SubTask;
  decision: RouteDecision;
  /** Ultra orchestration text for this task alone. */
  orchestration?: string;
  /** Jev kind when available: chat/lookup pieces stay with the parent. */
  kind?: string;
}

export function partitionRoutedTasks(routed: RoutedSubTask[]): { inline: RoutedSubTask[]; workers: RoutedSubTask[] } {
  const inline: RoutedSubTask[] = [];
  const workers: RoutedSubTask[] = [];
  for (const entry of routed) {
    if (keepWithParent(entry.decision, entry.kind)) inline.push(entry);
    else workers.push(entry);
  }
  return { inline, workers };
}

/** One `subagent` call per worker task. Cheap split pieces stay listed for the parent to answer. Two or more workers run in parallel. */
export function buildSplitDispatch(
  routed: RoutedSubTask[],
  snapshot: DispatchSnapshot,
  inline: RoutedSubTask[] = [],
): string {
  const parallel = routed.length > 1;
  const answered = inline.map(entry => entry.task.title).join(", ");
  const header = parallel
    ? answered
      ? `pi-auto-router: stay. Answer: ${answered}. ${routed.length} parallel workers, wait, synthesize.`
      : `pi-auto-router: stay. ${routed.length} parallel workers, wait, synthesize. do not answer.`
    : answered
      ? `pi-auto-router: stay. Answer: ${answered}. worker ${routed[0]!.decision.model.ref}:${childThinkingLevel(routed[0]!.decision)} for ${routed[0]!.task.title}.`
      : `pi-auto-router: stay. worker ${routed[0]!.decision.model.ref}:${childThinkingLevel(routed[0]!.decision)}. do not answer.`;
  const lines = [header];
  if (answered) {
    for (const entry of inline) {
      lines.push(`inline: ${entry.task.title}: ${clipEnds(entry.task.prompt, 200, 80)}`);
    }
  }
  routed.forEach((entry, index) => {
    const handle = rememberWorkerTask(
      buildWorkerTask(entry.decision, {
        ...snapshot,
        prompt: entry.task.prompt,
        orchestration: entry.orchestration,
        subtask: { index: index + 1, total: routed.length, title: entry.task.title, fullRequest: snapshot.prompt },
      }),
    );
    lines.push("", `${index + 1}/${routed.length} ${entry.task.title}`, ...workerCall(entry.decision, snapshot, handle, parallel));
  });
  return lines.join("\n");
}
