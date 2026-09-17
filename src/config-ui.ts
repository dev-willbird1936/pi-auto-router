import {
  activeProfile,
  CANONICAL_LEVELS,
  DEFAULT_PROFILE_NAME,
  JUDGE_CURRENT,
  PI_LEVELS,
  type CanonicalLevel,
  type ModelEntry,
  type ModelOverride,
  type PiThinking,
  type RouterConfig,
  type RouterProfile,
  type TierConfig,
  type ThinkingOverride,
} from "./logic.ts";
import { pickModelRef } from "./model-picker.ts";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

export interface StatusCtx {
  hasUI: boolean;
  ui: {
    setStatus: (key: string, value: string | undefined) => void;
    notify: (message: string, level: "info" | "warning" | "error") => void;
  };
}

export interface ConfigUIHooks {
  getConfig: () => RouterConfig;
  save: (config: RouterConfig) => void;
  updateStatus: (ctx: StatusCtx) => void;
}

const TOP_ROWS = [
  "enabled",
  "judgeModel",
  "judgeThinking",
  "thinkingUltraEnabled",
  "debug",
  "overrideModel",
  "overrideThinking",
] as const;
type TopRow = (typeof TOP_ROWS)[number];
const ROWS = [...TOP_ROWS, ...CANONICAL_LEVELS] as const;
type Row = (typeof ROWS)[number];

const JUDGE_THINKING_CHOICES: (PiThinking | "inherit")[] = ["inherit", ...PI_LEVELS];
const OVERRIDE_THINKING_CHOICES: ("auto" | "inherit" | PiThinking)[] = ["auto", "inherit", ...PI_LEVELS];

export type ConfigCommandCtx = StatusCtx & {
  modelRegistry: {
    getAvailable: () => { provider: string; id: string; name?: string }[];
  };
  ui: StatusCtx["ui"] & {
    select?: (title: string, options: string[], opts?: unknown) => Promise<unknown>;
    input: (title: string, placeholder: string) => Promise<unknown>;
    custom: <T>(component: unknown, opts?: unknown) => Promise<T | undefined>;
  };
};

type CommandCtx = ConfigCommandCtx;

function isTierRow(row: Row): row is CanonicalLevel {
  return (CANONICAL_LEVELS as readonly string[]).includes(row);
}

async function askInput(ctx: CommandCtx, title: string, placeholder: string): Promise<string | undefined> {
  const result: unknown = await ctx.ui.input(title, placeholder);
  return typeof result === "string" ? result : undefined;
}

/** Model picker with live /model-style search. Returns ref, null for clear, undefined for cancel. */
async function pickModel(
  ctx: CommandCtx,
  title: string,
  clearLabel?: string,
  selectedRef?: string,
): Promise<string | null | undefined> {
  return pickModelRef(ctx, ctx.modelRegistry.getAvailable(), {
    title,
    clearLabel,
    selectedRef,
  });
}

function cloneProfile(profile: RouterProfile): RouterProfile {
  return {
    judgeModel: profile.judgeModel,
    judgeThinking: profile.judgeThinking,
    tiers: Object.fromEntries(
      Object.entries(profile.tiers).map(([level, tier]) => [level, { enabled: tier!.enabled, models: tier!.models.map(m => ({ ...m })) }]),
    ) as RouterProfile["tiers"],
  };
}

function cloneConfig(config: RouterConfig): RouterConfig {
  return {
    ...config,
    profiles: Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, cloneProfile(profile)])),
  };
}

/** Drop any tier left with zero models (created but never filled while editing), in every profile. */
function finalizeConfig(config: RouterConfig): RouterConfig {
  const profiles: RouterConfig["profiles"] = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    const tiers: RouterProfile["tiers"] = {};
    for (const [level, tier] of Object.entries(profile.tiers)) {
      if (tier && tier.models.length > 0) tiers[level as CanonicalLevel] = tier;
    }
    profiles[name] = { ...profile, tiers };
  }
  return { ...config, profiles };
}

function isEnter(data: string): boolean {
  return data === "\n" || matchesKey(data, "enter") || matchesKey(data, "return");
}

function isClear(data: string): boolean {
  return matchesKey(data, "backspace") || matchesKey(data, "delete");
}

/**
 * Keyboard-first router editor. Each tier row exposes an enabled toggle plus
 * up to three ordered model slots as horizontally selectable cells.
 */
class RouterEditor implements Component {
  private readonly ctx: CommandCtx;
  private readonly tui: { requestRender(): void };
  private readonly theme: any;
  private readonly done: (config: RouterConfig | undefined) => void;
  private config: RouterConfig;
  private selectedRow = 0;
  /** For tier rows: 0 = enabled toggle, 1..3 = model slots. */
  private selectedCell = 0;
  private busy = false;
  private pickedJudge: string | undefined;
  private pickedForcedModel: string | undefined;

  constructor(
    ctx: CommandCtx,
    tui: { requestRender(): void },
    theme: any,
    config: RouterConfig,
    done: (config: RouterConfig | undefined) => void,
  ) {
    this.ctx = ctx;
    this.tui = tui;
    this.theme = theme;
    this.config = cloneConfig(config);
    const judge = activeProfile(this.config).judgeModel;
    this.pickedJudge = judge === JUDGE_CURRENT ? undefined : judge;
    this.pickedForcedModel = config.overrideModel.kind === "model" ? config.overrideModel.ref : undefined;
    this.done = done;
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+s")) {
      this.done(finalizeConfig(this.config));
      return;
    }
    if (matchesKey(data, "up")) {
      this.selectedRow = Math.max(0, this.selectedRow - 1);
      this.selectedCell = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedRow = Math.min(ROWS.length - 1, this.selectedRow + 1);
      this.selectedCell = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "left")) {
      this.changeOption(-1);
      return;
    }
    if (matchesKey(data, "right")) {
      this.changeOption(1);
      return;
    }
    if (matchesKey(data, "tab")) {
      this.switchProfile(1);
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.switchProfile(-1);
      return;
    }
    if (matchesKey(data, "ctrl+n")) {
      void this.createProfile();
      return;
    }
    if (isClear(data)) {
      this.clearSelected();
      return;
    }
    if (data === "t" || data === "T") {
      this.cycleModelThinking(data === "t" ? 1 : -1);
      return;
    }
    if (isEnter(data)) {
      void this.activateSelected();
    }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const border = this.theme.fg("border", "│");
    const horizontal = this.theme.fg("border", "─".repeat(contentWidth));
    const frame = (text: string): string => {
      const safe = truncateToWidth(text, contentWidth, "…");
      return `${border}${safe}${" ".repeat(Math.max(0, contentWidth - visibleWidth(safe)))}${border}`;
    };
    const divider = `${this.theme.fg("border", "├")}${horizontal}${this.theme.fg("border", "┤")}`;
    const top = `${this.theme.fg("border", "┌")}${horizontal}${this.theme.fg("border", "┐")}`;
    const bottom = `${this.theme.fg("border", "└")}${horizontal}${this.theme.fg("border", "┘")}`;

    const lines: string[] = [
      top,
      frame(` ${this.theme.fg("accent", this.theme.bold("Auto-router v2"))}`),
      frame(` ${this.renderProfileTabs()}`),
      divider,
      frame(`${this.rowMarker("enabled")}Enabled: ${this.value(this.config.enabled ? "on" : "off", "enabled")}`),
      frame(`${this.rowMarker("judgeModel")}Judge model: ${this.value(this.judgeModelLabel(), "judgeModel")}`),
      frame(`${this.rowMarker("judgeThinking")}Judge thinking: ${this.value(this.profile().judgeThinking ?? "high", "judgeThinking")}`),
      frame(
        `${this.rowMarker("thinkingUltraEnabled")}Ultra thinking: ${this.value(
          this.config.thinkingUltraEnabled ? "on (synthetic xhigh + orchestration)" : "off (resolves to Max)",
          "thinkingUltraEnabled",
        )}`,
      ),
      frame(`${this.rowMarker("debug")}Debug: ${this.value(this.config.debug ? "on" : "off", "debug")}`),
      frame(`${this.rowMarker("overrideModel")}Model override: ${this.value(this.overrideModelLabel(), "overrideModel")}`),
      frame(`${this.rowMarker("overrideThinking")}Thinking override: ${this.value(this.overrideThinkingLabel(), "overrideThinking")}`),
      divider,
    ];

    for (const level of CANONICAL_LEVELS) {
      lines.push(frame(this.renderTierRow(level)));
    }

    lines.push(
      divider,
      frame(` ${this.theme.fg("dim", "↑↓ row · ←→ option/cell · Enter edit · Backspace clear · t/T model thinking")}`),
      frame(` ${this.theme.fg("dim", "Tab/Shift+Tab switch profile · Ctrl+N new profile · Esc/Ctrl+S save · Ctrl+C cancel")}`),
      bottom,
    );
    return lines;
  }

  private renderProfileTabs(): string {
    const names = Object.keys(this.config.profiles);
    const tabs = names
      .map(name =>
        name === this.config.activeProfile
          ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${name} `))
          : this.theme.fg("muted", ` ${name} `),
      )
      .join(" ");
    return `${this.theme.fg("dim", "Profile:")} ${tabs}`;
  }

  invalidate(): void {
    // Rendered strings are derived from local state and the current theme.
  }

  private rowMarker(row: Row): string {
    return row === ROWS[this.selectedRow] ? this.theme.fg("accent", "▶ ") : "  ";
  }

  private value(text: string, row: TopRow): string {
    return row === ROWS[this.selectedRow] ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${text} `)) : this.theme.fg("text", text);
  }

  /** Judge and tiers live on the active profile; everything else on the row list is global. */
  private profile(): RouterProfile {
    return activeProfile(this.config);
  }

  private judgeModelLabel(): string {
    const judge = this.profile().judgeModel;
    if (!judge) return "heuristic";
    return judge === JUDGE_CURRENT ? "current model" : judge;
  }

  private overrideModelLabel(): string {
    const override = this.config.overrideModel;
    if (override.kind === "auto") return "auto";
    if (override.kind === "model") return override.ref;
    return `tier:${override.tier}`;
  }

  private overrideThinkingLabel(): string {
    const override = this.config.overrideThinking;
    if (override.kind === "level") return override.level;
    return override.kind;
  }

  private currentTiers(): Partial<Record<CanonicalLevel, TierConfig>> {
    return (this.config.profiles[this.config.activeProfile] ??= { tiers: {} }).tiers;
  }

  private switchProfile(direction: -1 | 1): void {
    const names = Object.keys(this.config.profiles);
    const index = names.indexOf(this.config.activeProfile);
    this.config.activeProfile = names[(Math.max(0, index) + direction + names.length) % names.length]!;
    this.selectedCell = 0;
    this.tui.requestRender();
  }

  private async createProfile(): Promise<void> {
    this.busy = true;
    this.tui.requestRender();
    try {
      const name = (await askInput(this.ctx, "New profile name:", DEFAULT_PROFILE_NAME))?.trim();
      if (!name) return;
      if (this.config.profiles[name]) {
        this.ctx.ui.notify(`Profile ${JSON.stringify(name)} already exists.`, "warning");
        return;
      }
      this.config.profiles[name] = { tiers: {} };
      this.config.activeProfile = name;
      this.selectedCell = 0;
      this.ctx.ui.notify(`Created and switched to profile ${name}.`, "info");
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  /** Filled slots plus exactly one spare "+ add" slot, capped at 3 models total. */
  private slotCount(level: CanonicalLevel): number {
    const models = this.currentTiers()[level]?.models ?? [];
    return Math.min(models.length + 1, 3);
  }

  private modelSlotLabel(model: ModelEntry): string {
    return model.thinkingOverride ? `${model.ref} ·${model.thinkingOverride}` : model.ref;
  }

  private renderTierRow(level: CanonicalLevel): string {
    const tier = this.currentTiers()[level];
    const models = tier?.models ?? [];
    const selectedRow = ROWS[this.selectedRow] === level;
    const cellText = (index: number, text: string): string => {
      const selected = selectedRow && this.selectedCell === index;
      return selected ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${text} `)) : this.theme.fg("muted", ` ${text} `);
    };
    const toggle = cellText(0, tier ? (tier.enabled ? "on" : "off") : "off");
    const slots = Array.from({ length: this.slotCount(level) }, (_, i) =>
      cellText(i + 1, models[i] ? this.modelSlotLabel(models[i]!) : "+ add"),
    );
    return `${this.rowMarker(level)}${level.padEnd(7)}${toggle} ${slots.join(" ")}`;
  }

  private cycleValue<T>(choices: readonly T[], current: T, direction: -1 | 1): T {
    const index = choices.indexOf(current);
    return choices[(Math.max(0, index) + direction + choices.length) % choices.length]!;
  }

  private changeOption(direction: -1 | 1): void {
    const row = ROWS[this.selectedRow]!;
    if (isTierRow(row)) {
      const cellCount = 1 + this.slotCount(row);
      this.selectedCell = (this.selectedCell + direction + cellCount) % cellCount;
      this.tui.requestRender();
      return;
    }
    switch (row) {
      case "enabled":
        this.config.enabled = !this.config.enabled;
        break;
      case "judgeModel":
        this.cycleJudgeModel(direction);
        break;
      case "judgeThinking":
        this.profile().judgeThinking = this.cycleValue(JUDGE_THINKING_CHOICES, this.profile().judgeThinking ?? "high", direction);
        break;
      case "thinkingUltraEnabled":
        this.toggleUltraThinking();
        break;
      case "debug":
        this.config.debug = !this.config.debug;
        break;
      case "overrideModel":
        this.cycleModelOverride(direction);
        break;
      case "overrideThinking": {
        const current = this.config.overrideThinking.kind === "level" ? this.config.overrideThinking.level : this.config.overrideThinking.kind;
        const next = this.cycleValue(OVERRIDE_THINKING_CHOICES, current, direction);
        this.config.overrideThinking = next === "auto" || next === "inherit" ? { kind: next } : { kind: "level", level: next };
        break;
      }
    }
    this.tui.requestRender();
  }

  private toggleUltraThinking(): void {
    this.config.thinkingUltraEnabled = !this.config.thinkingUltraEnabled;
    if (this.config.thinkingUltraEnabled) {
      this.ctx.ui.notify(
        "Ultra Thinking is synthetic: it uses XHigh reasoning plus workflow/subagent orchestration, not a native provider thinking level.",
        "warning",
      );
    }
  }

  /** heuristic -> current model -> the picked model (when one is remembered). */
  private cycleJudgeModel(direction: -1 | 1): void {
    const options: (string | undefined)[] = [undefined, JUDGE_CURRENT];
    if (this.pickedJudge) options.push(this.pickedJudge);
    const profile = this.profile();
    const index = options.indexOf(profile.judgeModel);
    const next = options[(Math.max(0, index) + direction + options.length) % options.length];
    profile.judgeModel = next;
    if (next && !profile.judgeThinking) profile.judgeThinking = "high";
  }

  /** auto -> the picked forced model (when one is remembered). Forced tiers are command-only (`/auto-router-override`). */
  private cycleModelOverride(direction: -1 | 1): void {
    const options: ModelOverride[] = [{ kind: "auto" }];
    if (this.pickedForcedModel) options.push({ kind: "model", ref: this.pickedForcedModel });
    const current = this.config.overrideModel.kind === "model" ? 1 : 0;
    const next = options[(current + direction + options.length) % options.length]!;
    this.config.overrideModel = next;
  }

  private async activateSelected(): Promise<void> {
    const row = ROWS[this.selectedRow]!;
    if (isTierRow(row)) {
      if (this.selectedCell === 0) {
        this.toggleTierEnabled(row);
      } else {
        await this.editTierSlot(row, this.selectedCell - 1);
      }
      return;
    }
    switch (row) {
      case "enabled":
        this.config.enabled = !this.config.enabled;
        this.tui.requestRender();
        return;
      case "judgeModel":
        await this.editJudgeModel();
        return;
      case "judgeThinking":
        this.changeOption(1);
        return;
      case "thinkingUltraEnabled":
        this.toggleUltraThinking();
        this.tui.requestRender();
        return;
      case "debug":
        this.config.debug = !this.config.debug;
        this.tui.requestRender();
        return;
      case "overrideModel":
        await this.editModelOverride();
        return;
      case "overrideThinking":
        this.changeOption(1);
        return;
    }
  }

  private toggleTierEnabled(level: CanonicalLevel): void {
    const tier = this.currentTiers()[level];
    if (!tier) {
      this.ctx.ui.notify(`Add a model to ${level} first.`, "warning");
      return;
    }
    tier.enabled = !tier.enabled;
    this.tui.requestRender();
  }

  private async editTierSlot(level: CanonicalLevel, index: number): Promise<void> {
    const tier: TierConfig = (this.currentTiers()[level] ??= { enabled: true, models: [] });
    const existing: ModelEntry | undefined = tier.models[index];
    this.busy = true;
    this.tui.requestRender();
    try {
      const picked = await pickModel(this.ctx, `Model for ${level} slot ${index + 1}:`, existing ? "(clear slot)" : undefined, existing?.ref);
      if (picked === undefined) return;
      if (picked === null) {
        tier.models.splice(index, 1);
        this.ctx.ui.notify(`${level} slot ${index + 1} cleared.`, "info");
      } else if (existing) {
        tier.models[index] = { ...existing, ref: picked };
        this.ctx.ui.notify(`${level} slot ${index + 1} -> ${picked}.`, "info");
      } else {
        tier.models.push({ ref: picked });
        this.ctx.ui.notify(`${level} slot ${index + 1} -> ${picked}.`, "info");
      }
      this.selectedCell = Math.min(this.selectedCell, this.slotCount(level));
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  /** Cycle the selected model slot's fixed thinking override: auto -> off..max -> auto. */
  private cycleModelThinking(direction: -1 | 1): void {
    const row = ROWS[this.selectedRow]!;
    if (!isTierRow(row) || this.selectedCell === 0) return;
    const tier = this.currentTiers()[row];
    const index = this.selectedCell - 1;
    const model = tier?.models[index];
    if (!model) {
      this.ctx.ui.notify(`${row} slot ${index + 1} has no model yet; press Enter to pick one.`, "warning");
      return;
    }
    const choices = ["auto", ...PI_LEVELS] as const;
    const current = model.thinkingOverride ?? "auto";
    const next = this.cycleValue(choices, current, direction);
    model.thinkingOverride = next === "auto" ? undefined : next;
    this.ctx.ui.notify(`${row} slot ${index + 1} thinking -> ${next}.`, "info");
    this.tui.requestRender();
  }

  private async editJudgeModel(): Promise<void> {
    const profile = this.profile();
    const pick = await pickModel(
      this.ctx,
      "Judge model (scores each prompt; ←→ for heuristic/current):",
      "(clear → heuristic)",
      profile.judgeModel === JUDGE_CURRENT ? undefined : profile.judgeModel,
    );
    if (pick === undefined) return;
    if (pick === null) {
      profile.judgeModel = undefined;
      this.ctx.ui.notify("Judge cleared; using local heuristic.", "info");
    } else {
      profile.judgeModel = pick;
      this.pickedJudge = pick;
      profile.judgeThinking ??= "high";
      this.ctx.ui.notify(`Judge -> ${pick}:${profile.judgeThinking}.`, "info");
    }
    this.tui.requestRender();
  }

  private async editModelOverride(): Promise<void> {
    const pick = await pickModel(this.ctx, "Force this exact model (←→ for auto):", "(clear → auto)", this.pickedForcedModel);
    if (pick === undefined) return;
    if (pick === null) {
      this.config.overrideModel = { kind: "auto" };
      this.ctx.ui.notify("Model override cleared; routing is automatic.", "info");
    } else {
      this.config.overrideModel = { kind: "model", ref: pick };
      this.pickedForcedModel = pick;
      this.ctx.ui.notify(`Model forced to ${pick}.`, "info");
    }
    this.tui.requestRender();
  }

  private clearSelected(): void {
    const row = ROWS[this.selectedRow]!;
    if (row === "judgeModel") {
      this.profile().judgeModel = undefined;
      this.ctx.ui.notify("Judge cleared; using local heuristic.", "info");
    } else if (row === "overrideModel") {
      this.config.overrideModel = { kind: "auto" };
    } else if (row === "overrideThinking") {
      this.config.overrideThinking = { kind: "auto" };
    } else if (isTierRow(row) && this.selectedCell > 0) {
      const tier = this.currentTiers()[row];
      const index = this.selectedCell - 1;
      if (!tier || index >= tier.models.length) return;
      tier.models.splice(index, 1);
      this.ctx.ui.notify(`${row} slot ${this.selectedCell} cleared.`, "info");
      this.selectedCell = Math.min(this.selectedCell, this.slotCount(row));
    } else {
      return;
    }
    this.tui.requestRender();
  }
}

/** Config menu with keyboard-editable tiers, judge, ultra thinking, debug and overrides. */
export async function runConfigUI(ctx: CommandCtx, hooks: ConfigUIHooks): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("pi-auto-router: config needs interactive mode.", "error");
    return;
  }

  const result = await ctx.ui.custom<RouterConfig | undefined>(
    (
      tui: { requestRender(): void },
      theme: any,
      _keybindings: unknown,
      done: (config: RouterConfig | undefined) => void,
    ) => new RouterEditor(ctx, tui, theme, hooks.getConfig(), done),
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", minWidth: 76 } },
  );
  if (!result) return;
  hooks.save(result);
  hooks.updateStatus(ctx);
  ctx.ui.notify("Auto-router settings saved.", "info");
}
