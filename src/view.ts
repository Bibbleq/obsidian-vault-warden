import { ItemView, WorkspaceLeaf } from "obsidian";
import type { Violation } from "./engine/types";
import type VaultWardenPlugin from "./main";

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
      const label =
        violation.suggested_fix.op === "remove_tag"
          ? "Remove"
          : violation.suggested_fix.op === "set_field" &&
              violation.suggested_fix.value != null
            ? `Fix → ${String(violation.suggested_fix.value)}`
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
