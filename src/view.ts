import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { FieldSpec, Violation } from "./engine/types";
import type VaultWardenPlugin from "./main";

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Whether the field is required for THIS note, mirroring the engine's
 * semantics: `required_unless` waives the requirement when the named field is
 * present; `required_when` imposes it only when another field matches.
 */
function isEffectivelyRequired(spec: FieldSpec, fm: Record<string, unknown>): boolean {
  if (spec.required) {
    if (spec.required_unless && !isEmptyValue(fm[spec.required_unless])) return false;
    return true;
  }
  if (spec.required_when) {
    const actual = fm[spec.required_when.field];
    return !isEmptyValue(actual) && String(actual) === spec.required_when.equals;
  }
  return false;
}

export const VIEW_TYPE_WARDEN = "vault-warden-violations";

/** Right-sidebar violations panel for the active note. */
export class WardenView extends ItemView {
  private plugin: VaultWardenPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: VaultWardenPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_WARDEN;
  }

  getDisplayText(): string {
    return "Vault Warden";
  }

  getIcon(): string {
    return "shield-alert";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /** Re-render from the plugin's current validation state. */
  render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("vault-warden-view");

    const file = this.app.workspace.getActiveFile();

    if (!this.plugin.loader.base) {
      container.createEl("p", {
        text: "No schema loaded. Point Vault Warden at a base schema file in settings.",
        cls: "vault-warden-empty",
      });
      this.renderLoadErrors(container);
      return;
    }
    if (!file || file.extension !== "md") {
      container.createEl("p", {
        text: "No active note.",
        cls: "vault-warden-empty",
      });
      return;
    }

    container.createEl("div", { text: file.basename, cls: "vault-warden-note-name" });

    this.renderProperties(container, file);

    container.createEl("div", { text: "Violations", cls: "vault-warden-section-title" });

    const active = this.plugin.violations.filter((v) => !v.suppressed);
    const suppressed = this.plugin.violations.filter((v) => v.suppressed);
    const mechanical = active.filter((v) => v.mechanical && v.suggested_fix);

    if (mechanical.length > 1) {
      const bar = container.createEl("div", { cls: "vault-warden-toolbar" });
      const fixAll = bar.createEl("button", {
        text: `Fix all (${mechanical.length})`,
        cls: "mod-cta",
      });
      fixAll.addEventListener("click", () => void this.plugin.applyFixes(mechanical));
    }

    if (active.length === 0) {
      container.createEl("p", {
        text: "No violations.",
        cls: "vault-warden-clean",
      });
    } else {
      const list = container.createEl("div", { cls: "vault-warden-list" });
      for (const violation of active) {
        this.renderViolation(list, violation, true);
      }
    }

    if (suppressed.length > 0) {
      const details = container.createEl("details", { cls: "vault-warden-suppressed" });
      details.createEl("summary", {
        text: `${suppressed.length} suppressed`,
      });
      for (const violation of suppressed) {
        this.renderViolation(details, violation);
      }
    }

    this.renderLoadErrors(container);
  }

  /** Class-aware properties editor: base fields + the class manifest's fields. */
  private renderProperties(container: HTMLElement, file: TFile): void {
    const loader = this.plugin.loader;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const section = container.createEl("div", { cls: "vault-warden-props" });
    section.createEl("div", { text: "Properties", cls: "vault-warden-section-title" });

    // Class row.
    const rawClass = fm["class"];
    const className = Array.isArray(rawClass) ? rawClass[0] : rawClass;
    const classRow = section.createEl("div", { cls: "vault-warden-prop-row" });
    classRow.createEl("span", { text: "class", cls: "vault-warden-prop-name" });
    const classValue = classRow.createEl("span", {
      text: typeof className === "string" && className !== "" ? className : "Set class…",
      cls:
        typeof className === "string" && className !== ""
          ? "vault-warden-prop-value"
          : "vault-warden-prop-value vault-warden-prop-empty",
    });
    classValue.addEventListener("click", () => this.plugin.pickClass(file));

    // Base fields, then the class manifest's fields.
    for (const [name, spec] of Object.entries(loader.base?.fields ?? {})) {
      this.renderPropRow(section, file, fm, name, spec);
    }

    const manifest =
      typeof className === "string" ? loader.manifests[className] : undefined;
    if (manifest) {
      const fields = Object.entries(manifest.fields ?? {});
      if (fields.length > 0) section.createEl("div", { cls: "vault-warden-prop-divider" });
      for (const [name, spec] of fields) {
        this.renderPropRow(section, file, fm, name, spec);
      }

      const hasMissingDefaults = fields.some(
        ([name, spec]) => spec.default !== undefined && isEmptyValue(fm[name])
      );
      if (hasMissingDefaults) {
        const bar = section.createEl("div", { cls: "vault-warden-toolbar" });
        const btn = bar.createEl("button", { text: "Apply class defaults" });
        btn.addEventListener("click", () => void this.plugin.applyClassDefaults(file));
      }
    }
  }

  private renderPropRow(
    parent: HTMLElement,
    file: TFile,
    fm: Record<string, unknown>,
    name: string,
    spec: FieldSpec
  ): void {
    const value = fm[name];
    const missing = isEmptyValue(value);
    const requiredHere = isEffectivelyRequired(spec, fm);
    const row = parent.createEl("div", { cls: "vault-warden-prop-row" });
    row.createEl("span", {
      text: name,
      cls:
        requiredHere && missing
          ? "vault-warden-prop-name vault-warden-prop-required-missing"
          : "vault-warden-prop-name",
      attr: requiredHere ? { "aria-label": "required" } : {},
    });

    const valueEl = row.createEl("span", { cls: "vault-warden-prop-value" });
    const isList = spec.type === "multi" || spec.type === "list";

    if (isList && Array.isArray(value) && value.length > 0) {
      for (const item of value) {
        const chip = valueEl.createEl("span", { cls: "vault-warden-chip" });
        chip.createEl("span", { text: String(item) });
        const removeEl = chip.createEl("span", { text: "×", cls: "vault-warden-chip-x" });
        removeEl.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.plugin.removeFromListField(file, name, item);
        });
      }
      const add = valueEl.createEl("span", { text: "+", cls: "vault-warden-chip vault-warden-chip-add" });
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.editField(file, name, spec);
      });
    } else if (missing) {
      valueEl.createEl("span", { text: "—", cls: "vault-warden-prop-empty" });
      valueEl.addEventListener("click", () => this.plugin.editField(file, name, spec));
    } else {
      valueEl.createEl("span", { text: Array.isArray(value) ? value.map(String).join(", ") : String(value) });
      valueEl.addEventListener("click", () => this.plugin.editField(file, name, spec));
    }
  }

  private renderViolation(parent: HTMLElement, violation: Violation, fixable = false): void {
    const item = parent.createEl("div", { cls: "vault-warden-item" });
    const head = item.createEl("div", { cls: "vault-warden-item-head" });
    head.createEl("span", { text: violation.rule, cls: "vault-warden-rule" });
    if (violation.field) {
      head.createEl("span", { text: violation.field, cls: "vault-warden-field" });
    }
    const body = item.createEl("div", { cls: "vault-warden-item-body" });
    if (violation.found != null) {
      body.createEl("div", { text: `found: ${violation.found}` });
    }
    if (violation.expected != null) {
      body.createEl("div", { text: `expected: ${violation.expected}` });
    }
    if (!fixable) return;

    const actions = item.createEl("div", { cls: "vault-warden-item-actions" });
    if (violation.mechanical && violation.suggested_fix) {
      const op = violation.suggested_fix.op;
      const value = violation.suggested_fix.value;
      const label =
        op === "remove_tag"
          ? "Remove"
          : op === "rename_file"
            ? `Rename → ${String(value ?? "")}`
            : op === "set_h1"
              ? "Fix H1"
              : op === "set_field" && value != null
                ? `Fix → ${String(value)}`
                : "Fix";
      const fixBtn = actions.createEl("button", { text: label, cls: "mod-cta" });
      fixBtn.addEventListener("click", () => void this.plugin.applyFixes([violation]));
    }
    if (violation.field) {
      const setBtn = actions.createEl("button", { text: "Set…" });
      setBtn.addEventListener("click", () => this.plugin.openManualFix(violation));
    }
  }

  private renderLoadErrors(container: HTMLElement): void {
    const errors = this.plugin.loader.loadErrors;
    if (errors.length === 0) return;
    const details = container.createEl("details", { cls: "vault-warden-load-errors" });
    details.createEl("summary", { text: `${errors.length} schema problem(s)` });
    for (const err of errors) {
      details.createEl("div", { text: err });
    }
  }
}
