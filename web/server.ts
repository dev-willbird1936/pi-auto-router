import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWithJev, buildRouteBoard, typesafeConfigured } from "../src/jev.ts";
import { normalizeConfig, type RouterConfig } from "../src/logic.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.JEV_ROUTER_PORT ?? 3847);

function configPath(): string {
  return process.env.PI_AUTO_ROUTER_CONFIG ?? join(homedir(), ".pi", "agent", "pi-auto-router.json");
}

function loadRouterConfig(): RouterConfig {
  const path = configPath();
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function mime(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}

async function handleConfig(): Promise<Response> {
  const config = loadRouterConfig();
  return json({
    activeProfile: config.activeProfile,
    profiles: Object.keys(config.profiles),
    jev: typesafeConfigured(),
    tiers: config.profiles[config.activeProfile]?.tiers ?? {},
  });
}

async function handleRoute(request: Request): Promise<Response> {
  if (!typesafeConfigured()) return json({ error: "TYPESAFE_API_KEY missing (expected env or ~/.brain/secrets/typesafe-api-key.txt)" }, 503);
  const body = (await request.json()) as {
    profile?: string;
    prompt?: string;
    history?: { role: "user" | "assistant"; text: string }[];
  };
  const prompt = body.prompt?.trim() ?? "";
  if (!prompt) return json({ error: "prompt required" }, 400);
  const config = loadRouterConfig();
  if (body.profile && config.profiles[body.profile]) config.activeProfile = body.profile;
  const classified = await classifyWithJev(prompt, body.history ?? []);
  const board = buildRouteBoard(config, classified.scores, classified.read);
  return json({
    profile: config.activeProfile,
    scores: classified.scores,
    read: classified.read,
    usage: classified.raw.usage,
    steps: board.steps,
    models: board.models,
    decision: board.decision
      ? {
          ref: board.decision.model.ref,
          thinking: board.decision.nativeThinking,
          debug: board.decision.debug,
        }
      : null,
  });
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/config") return await handleConfig();
      if (request.method === "POST" && url.pathname === "/api/route") return await handleRoute(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 502);
    }
    const path = url.pathname === "/" ? join(PUBLIC, "index.html") : join(PUBLIC, url.pathname.replace(/^\/+/, ""));
    if (!path.startsWith(PUBLIC) || !existsSync(path)) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(path), { headers: { "content-type": mime(path) } });
  },
});

console.log(`Jev router http://127.0.0.1:${PORT}`);
console.log(`config ${configPath()}`);
console.log(`TypeSafe key ${typesafeConfigured() ? "present" : "MISSING"}`);
