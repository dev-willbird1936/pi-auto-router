import { expect, test } from "bun:test";
import { pickModelRef } from "../src/model-picker.ts";

const theme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const tui = { requestRender: () => {} };

function harness(
  models: { provider: string; id: string; name?: string }[],
  opts?: { clearLabel?: string },
) {
  let component: any;
  const notifications: string[] = [];
  const ctx: any = {
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: (render: any) =>
        new Promise(resolve => {
          component = render(tui, theme, {}, (value: string | undefined) => resolve(value));
        }),
    },
  };
  const pending = pickModelRef(ctx, models, { title: "Choose model", ...opts });
  return {
    pending,
    notifications,
    component: () => {
      if (!component) throw new Error("picker not constructed");
      return component as { handleInput: (data: string) => void; render: (width: number) => string[] };
    },
  };
}

test("typing filters live and Enter picks best match", async () => {
  const h = harness([
    { provider: "p", id: "beta" },
    { provider: "q", id: "alpha" },
  ]);
  h.component().handleInput("a");
  h.component().handleInput("l");
  h.component().handleInput("p");
  h.component().handleInput("\n");
  expect(await h.pending).toBe("q/alpha");
});

test("provider-prefixed query ranks the exact provider first", async () => {
  const h = harness([
    { provider: "openrouter/anthropic", id: "claude-opus-4-6" },
    { provider: "anthropic", id: "claude-opus-4-6" },
  ]);
  for (const char of "anthropic opus") h.component().handleInput(char);
  h.component().handleInput("\n");
  expect(await h.pending).toBe("anthropic/claude-opus-4-6");
});

test("Escape cancels without picking", async () => {
  const h = harness([{ provider: "p", id: "a" }]);
  h.component().handleInput("\x1b");
  expect(await h.pending).toBeUndefined();
});

test("arrow key reaches the clear row", async () => {
  const h = harness([{ provider: "p", id: "a" }], { clearLabel: "(clear)" });
  h.component().handleInput("\x1b[B");
  h.component().handleInput("\n");
  expect(await h.pending).toBeNull();
});

test("empty model list warns and picks nothing", async () => {
  const h = harness([]);
  expect(await h.pending).toBeUndefined();
  expect(h.notifications.join("\n")).toContain("No models");
});
