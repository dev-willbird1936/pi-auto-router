import {
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import * as piTuiNamespace from "@earendil-works/pi-tui";
import {
  fuzzyFilterModels,
  modelSearchText,
  type ModelSearchItem,
} from "./logic.ts";

export interface PickerModel extends ModelSearchItem {}

export interface PickerContext {
  hasUI: boolean;
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
    custom: <T>(component: unknown, opts?: unknown) => Promise<T | undefined>;
  };
}

// The host Pi's fuzzy matcher when it exports one, otherwise the vendored
// mirror in logic.ts (same /model semantics either way).
const hostFuzzyFilter =
  (
    piTuiNamespace as unknown as {
      fuzzyFilter?: <T>(items: T[], query: string, getText: (item: T) => string) => T[];
    }
  ).fuzzyFilter ?? null;

function filterModels(models: PickerModel[], query: string): PickerModel[] {
  if (!query.trim()) return models;
  if (hostFuzzyFilter) return hostFuzzyFilter(models, query, modelSearchText);
  return fuzzyFilterModels(models, query, modelSearchText);
}

function isEnter(data: string): boolean {
  return data === "\n" || matchesKey(data, "enter") || matchesKey(data, "return");
}

function isClear(data: string): boolean {
  return matchesKey(data, "backspace") || matchesKey(data, "delete");
}

interface PickerItem {
  ref: string;
  label: string;
  description?: string;
  clear?: boolean;
}

/** Live-filter model picker: same search behavior as Pi's /model selector. */
class ModelPicker implements Component {
  private readonly tui: { requestRender(): void };
  private readonly theme: any;
  private readonly done: (ref: string | undefined) => void;
  private readonly search = new Input();
  private readonly title: string;
  private readonly models: PickerModel[];
  private readonly clearLabel?: string;
  private readonly selectedRef: string | undefined;
  private list: SelectList;
  private searchFocused = true;
  private _focused = false;

  constructor(
    tui: { requestRender(): void },
    theme: any,
    title: string,
    models: PickerModel[],
    selectedRef: string | undefined,
    clearLabel: string | undefined,
    done: (ref: string | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.models = models;
    this.selectedRef = selectedRef;
    this.clearLabel = clearLabel;
    this.done = done;
    this.list = this.buildList("");
    this.search.onSubmit = () => this.selectCurrent();
    this.syncFocus();
  }

  private toItems(visible: PickerModel[]): PickerItem[] {
    const items = visible.map((model): PickerItem => {
      const ref = `${model.provider}/${model.id}`;
      return {
        ref,
        label: ref,
        description: model.name && model.name !== model.id ? model.name : undefined,
      };
    });
    if (this.clearLabel && !this.search.getValue().trim()) {
      items.push({ ref: this.clearLabel, label: this.clearLabel, description: "Clear", clear: true });
    }
    return items;
  }

  private buildList(query: string): SelectList {
    const visible = filterModels(this.models, query);
    const selectItems: SelectItem[] = this.toItems(visible).map(item => ({
      value: item.ref,
      label: item.label,
      description: item.description,
    }));
    const list = new SelectList(selectItems, Math.min(12, Math.max(1, selectItems.length)), {
      selectedPrefix: text => this.theme.fg("accent", text),
      selectedText: text => this.theme.fg("accent", text),
      description: text => this.theme.fg("muted", text),
      scrollInfo: text => this.theme.fg("dim", text),
      noMatch: text => this.theme.fg("warning", text),
    });
    const selectedIndex = visible.findIndex(model => `${model.provider}/${model.id}` === this.selectedRef);
    list.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    list.onSelect = item => this.done(item.value);
    list.onCancel = () => this.done(undefined);
    return list;
  }

  private refreshFilter(): void {
    this.list = this.buildList(this.search.getValue());
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncFocus();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "tab")) {
      this.searchFocused = !this.searchFocused;
      this.syncFocus();
      this.tui.requestRender();
      return;
    }
    if (this.searchFocused) {
      if (
        matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "pageUp") ||
        matchesKey(data, "pageDown")
      ) {
        this.searchFocused = false;
        this.syncFocus();
        this.list.handleInput(data);
      } else if (isEnter(data)) {
        this.selectCurrent();
        return;
      } else {
        if (isClear(data) && this.search.getValue().length === 0) {
          this.done(undefined);
          return;
        }
        this.search.handleInput(data);
        this.refreshFilter();
      }
    } else {
      this.list.handleInput(data);
    }
    this.tui.requestRender();
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
    const searchLine = this.search.render(contentWidth)[0] ?? "";
    return [
      top,
      frame(` ${this.theme.fg("accent", this.theme.bold(this.title))}`),
      frame(` ${this.theme.fg("dim", this.searchFocused ? "Type to filter; Tab moves to the list" : "Tab returns to search")}`),
      frame(`${this.theme.fg("muted", " Search: ")}${searchLine}`),
      divider,
      ...this.list.render(contentWidth).map(line => frame(line)),
      divider,
      frame(` ${this.theme.fg("dim", "↑↓ navigate · Enter choose · Tab search/list · Esc cancel")}`),
      bottom,
    ];
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }

  private syncFocus(): void {
    this.search.focused = this._focused && this.searchFocused;
  }

  private selectCurrent(): void {
    const selected = this.list.getSelectedItem();
    if (selected) this.done(selected.value);
  }
}

export async function pickModelRef(
  ctx: PickerContext,
  models: PickerModel[],
  options?: { title?: string; selectedRef?: string; clearLabel?: string },
): Promise<string | null | undefined> {
  if (models.length === 0) {
    ctx.ui.notify("No models are available in Pi's model list. Configure a provider first.", "warning");
    return undefined;
  }
  const unique = new Map<string, PickerModel>();
  for (const model of models) unique.set(`${model.provider}/${model.id}`, model);
  const ref = await ctx.ui.custom<string | undefined>(
    (
      tui: { requestRender(): void },
      theme: any,
      _keybindings: unknown,
      done: (ref: string | undefined) => void,
    ) =>
      new ModelPicker(
        tui,
        theme,
        options?.title ?? "Choose model",
        [...unique.values()],
        options?.selectedRef,
        options?.clearLabel,
        done,
      ),
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", minWidth: 64 } },
  );
  if (ref === undefined) return undefined;
  if (options?.clearLabel && ref === options.clearLabel) return null;
  return ref;
}

// ponytail: mirrors pi-fallback's picker (same /model keys + fuzzy); add scoped-model tabs only if slot editing needs them.
