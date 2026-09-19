import { expect, test } from "bun:test";
import { runConfigUI } from "../src/config-ui.ts";
import { activeTiers, defaultConfig, type RouterConfig } from "../src/logic.ts";

function setup(initial: RouterConfig, pickerResults: (string | null | undefined)[] = [], inputs: string[] = []) {
  let editor: any;
  let customCalls = 0;
  let pickerIndex = 0;
  let inputIndex = 0;
  const notifications: string[] = [];
  let statuses = 0;
  let saved = 0;
  const config: RouterConfig = JSON.parse(JSON.stringify(initial));
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx: any = {
    hasUI: true,
    ui: {
      input: async () => inputs[inputIndex++],
      custom: async (render: any) => {
        customCalls++;
        if (customCalls === 1) {
          return new Promise(resolve => {
            editor = render({ requestRender: () => {} }, fakeTheme, {}, resolve);
          });
        }
        return pickerResults[pickerIndex++];
      },
      notify: (message: string) => notifications.push(message),
      setStatus: () => {
        statuses++;
      },
    },
    modelRegistry: {
      getAvailable: () => [
        { provider: "p", id: "a", name: "A" },
        { provider: "p", id: "b", name: "B" },
      ],
    },
  };
  const hooks = {
    getConfig: () => config,
    save: (next: RouterConfig) => {
      saved++;
      Object.assign(config, next);
    },
    updateStatus: (_ctx: unknown) => {
      statuses++;
    },
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  return {
    ctx,
    hooks,
    config,
    notifications,
    editor: () => editor,
    savedCount: () => saved,
    statusCount: () => statuses,
    tick,
  };
}

function base(): RouterConfig {
  return {
    ...defaultConfig(),
    enabled: true,
    profiles: { default: { tiers: { low: { enabled: true, models: [{ ref: "p/low" }] } } } },
  };
}

function tiers(config: RouterConfig) {
  return activeTiers(config);
}

function down(editor: any, count: number): void {
  for (let i = 0; i < count; i++) editor.handleInput("\x1b[B");
}

const ROW = {
  enabled: 0,
  judgeModel: 1,
  judgeThinking: 2,
  splitCheckEnabled: 3,
  thinkingUltraEnabled: 4,
  debug: 5,
  overrideModel: 6,
  overrideThinking: 7,
  none: 8,
  minimal: 9,
  low: 10,
  medium: 11,
  high: 12,
  xhigh: 13,
  max: 14,
  ultra: 15,
};

test("Esc saves without changes", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.savedCount()).toBe(1);
  expect(tiers(t.config).low?.models[0]?.ref).toBe("p/low");
});

test("Ctrl+C cancels without saving", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  t.editor().handleInput("\x1b[C"); // any edit
  t.editor().handleInput("\x03");
  await pending;
  expect(t.savedCount()).toBe(0);
});

test("enabled toggles with Left/Right or Enter", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.enabled);
  t.editor().handleInput("\x1b[C");
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.enabled).toBe(false);
});

test("judge model cycles current -> heuristic -> picked, and Enter opens the picker", async () => {
  const t = setup(base(), ["p/a"]);
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.judgeModel);
  t.editor().handleInput("\x1b[C"); // current (the default) -> heuristic
  t.editor().handleInput("\n"); // Enter opens picker (overrides cycle position)
  await t.tick();
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.profiles[t.config.activeProfile]?.judgeModel).toBe("p/a");
});

test("an unset judge starts on the default (current model) and cycles to the heuristic", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.judgeModel);
  t.editor().handleInput("\x1b[C");
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.profiles[t.config.activeProfile]?.judgeModel).toBe("heuristic");
});

test("thinking Ultra toggle warns once when turned on", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.thinkingUltraEnabled);
  t.editor().handleInput("\x1b[C");
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.thinkingUltraEnabled).toBe(true);
  expect(t.notifications.some(n => n.includes("synthetic"))).toBe(true);
});

test("split check toggles without warning", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.splitCheckEnabled);
  t.editor().handleInput("\n");
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.splitCheckEnabled).toBe(false);
  expect(t.notifications.some(n => n.includes("synthetic"))).toBe(false);
});

test("debug toggles independently of thinking Ultra", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.debug);
  t.editor().handleInput("\n");
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.debug).toBe(true);
  expect(t.config.thinkingUltraEnabled).toBe(false);
});

test("model override cycles auto -> picked forced model via the picker", async () => {
  const t = setup(base(), ["p/a"]);
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.overrideModel);
  t.editor().handleInput("\n");
  await t.tick();
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.overrideModel).toEqual({ kind: "model", ref: "p/a" });
});

test("thinking override cycles through auto/inherit/levels", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.overrideThinking);
  t.editor().handleInput("\x1b[C"); // auto -> inherit
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.overrideThinking).toEqual({ kind: "inherit" });
});

test("tier row: toggle cell disables an existing tier", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.low);
  t.editor().handleInput("\n"); // cell 0 = toggle
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).low?.enabled).toBe(false);
});

test("tier row: toggling an empty tier warns instead of creating a bogus entry", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.medium);
  t.editor().handleInput("\n"); // cell 0 = toggle, but "medium" has no tier yet
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).medium).toBeUndefined();
  expect(t.notifications.some(n => n.includes("Add a model"))).toBe(true);
});

test("tier row: filling slot 1 on an unconfigured tier creates it enabled", async () => {
  const t = setup(base(), ["p/a"]);
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.medium);
  t.editor().handleInput("\x1b[C"); // move to slot 1
  t.editor().handleInput("\n");
  await t.tick();
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).medium).toEqual({ enabled: true, models: [{ ref: "p/a" }] });
});

test("tier row: only one spare slot is shown beyond the filled models, capped at 3", async () => {
  const t = setup(base(), ["p/a", "p/b"]);
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.low); // 1 model (p/low) -> cells: [toggle, p/low, +add]
  t.editor().handleInput("\x1b[C"); // cell 1: p/low
  t.editor().handleInput("\x1b[C"); // cell 2: the spare "+ add" cell
  t.editor().handleInput("\n");
  await t.tick(); // now 2 models -> cells: [toggle, p/low, p/a, +add]
  t.editor().handleInput("\x1b[C"); // cell 3: the new spare cell
  t.editor().handleInput("\n");
  await t.tick(); // now 3 models -> capped, no spare cell left
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).low?.models.map(m => m.ref)).toEqual(["p/low", "p/a", "p/b"]);
});

test("tier row: t/T sets a per-model thinking override, defaulting to auto", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.low);
  t.editor().handleInput("t"); // cell 0 is the enabled toggle, not a model slot: no-op
  t.editor().handleInput("\x1b[C"); // slot 1 (p/low)
  t.editor().handleInput("t"); // auto -> off
  t.editor().handleInput("t"); // off -> minimal
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).low?.models[0]?.thinkingOverride).toBe("minimal");
});

test("tier row: T cycles a model's thinking override backwards to auto", async () => {
  const config = base();
  config.profiles.default!.tiers.low!.models[0]!.thinkingOverride = "minimal";
  const t = setup(config);
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.low);
  t.editor().handleInput("\x1b[C"); // slot 1
  t.editor().handleInput("T"); // minimal -> off
  t.editor().handleInput("T"); // off -> auto
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).low?.models[0]?.thinkingOverride).toBeUndefined();
});

test("tier row: t on an empty spare slot warns instead of setting anything", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.low);
  t.editor().handleInput("\x1b[C"); // slot 1 (p/low)
  t.editor().handleInput("\x1b[C"); // spare "+ add" slot
  t.editor().handleInput("t");
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).low?.models).toHaveLength(1);
  expect(t.notifications.some(n => n.includes("no model yet"))).toBe(true);
});

test("tier row: Backspace clears a model slot", async () => {
  const t = setup(base());
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.low);
  t.editor().handleInput("\x1b[C"); // slot 1
  t.editor().handleInput("\x7f");
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).low).toBeUndefined(); // 0 models left -> finalizeConfig drops it
});

test("picker returning null clears an existing model slot", async () => {
  const t = setup(base(), [null]);
  const pending = runConfigUI(t.ctx, t.hooks);
  down(t.editor(), ROW.low);
  t.editor().handleInput("\x1b[C"); // slot 1 (has p/low)
  t.editor().handleInput("\n");
  await t.tick();
  t.editor().handleInput("\x1b");
  await pending;
  expect(tiers(t.config).low).toBeUndefined();
});

test("Tab/Shift+Tab switches between existing profiles", async () => {
  const config = base();
  config.profiles.other = { tiers: { high: { enabled: true, models: [{ ref: "p/high" }] } } };
  const t = setup(config);
  const pending = runConfigUI(t.ctx, t.hooks);
  t.editor().handleInput("\t");
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.activeProfile).toBe("other");

  const t2 = setup(config);
  const pending2 = runConfigUI(t2.ctx, t2.hooks);
  t2.editor().handleInput("\t");
  t2.editor().handleInput("\x1b[Z"); // Shift+Tab back to the first profile
  t2.editor().handleInput("\x1b");
  await pending2;
  expect(t2.config.activeProfile).toBe("default");
});

test("Ctrl+N creates a new profile, switches to it, and it starts empty", async () => {
  const t = setup(base(), [], ["power"]);
  const pending = runConfigUI(t.ctx, t.hooks);
  t.editor().handleInput("\x0e");
  await t.tick();
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.activeProfile).toBe("power");
  expect(t.config.profiles.power).toBeDefined();
  // "default" (with p/low) is untouched and still switchable back to.
  expect(t.config.profiles.default?.tiers.low?.models[0]?.ref).toBe("p/low");
});

test("Ctrl+N refuses to create a profile name that already exists", async () => {
  const t = setup(base(), [], ["default"]);
  const pending = runConfigUI(t.ctx, t.hooks);
  t.editor().handleInput("\x0e");
  await t.tick();
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.activeProfile).toBe("default");
  expect(t.notifications.some(n => n.includes("already exists"))).toBe(true);
});

test("editing a tier only affects the active profile, other profiles are untouched", async () => {
  const config = base();
  config.profiles.other = { tiers: {} };
  const t = setup(config);
  const pending = runConfigUI(t.ctx, t.hooks);
  t.editor().handleInput("\t"); // switch to "other"
  down(t.editor(), ROW.low);
  t.editor().handleInput("\x1b[C");
  t.editor().handleInput("\x7f"); // no-op, "other" has no low model to clear
  t.editor().handleInput("\x1b");
  await pending;
  expect(t.config.profiles.default?.tiers.low?.models[0]?.ref).toBe("p/low");
  expect(t.config.profiles.other?.tiers.low).toBeUndefined();
});
