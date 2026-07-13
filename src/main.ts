import { Plugin, TAbstractFile, TFile, debounce } from "obsidian";
import { validate } from "./engine/validate";
import { applyAllFixes, applyFixToFrontmatter } from "./engine/fixops";
import type { FieldSpec, ValidationInput, Violation } from "./engine/types";
import { SchemaLoader } from "./loader";
import { TextPromptModal, ValueSuggestModal } from "./modals";
import {
  DEFAULT_SETTINGS,
  VaultWardenSettings,
  VaultWardenSettingTab,
} from "./settings";
import { VIEW_TYPE_WARDEN, WardenView } from "./view";

export default class VaultWardenPlugin extends Plugin {
  settings: VaultWardenSettings = DEFAULT_SETTINGS;
  loader!: SchemaLoader;

  /** Violations for the active file from the most recent validation. */
  violations: Violation[] = [];
  /** The file the current `violations` belong to (fix buttons target this). */
  validatedFile: TFile | null = null;

  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.loader = new SchemaLoader(this.app, () => this.settings.schemaPath);
    this.addSettingTab(new VaultWardenSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_WARDEN, (leaf) => new WardenView(leaf, this));

    // Status bar is a no-op container on mobile; harmless to create there.
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.onClickEvent(() => void this.activateView());
    this.updateBadge(null);

    this.addRibbonIcon("shield-alert", "Vault Warden: open violations", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-violations",
      name: "Open violations pane",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "validate-current-note",
      name: "Validate current note",
      callback: async () => {
        await this.validateActiveFile();
        await this.activateView();
      },
    });

    const debouncedValidate = debounce(
      () => void this.validateActiveFile(),
      400,
      true
    );
    const debouncedReload = debounce(() => void this.reloadSchemas(), 400, true);

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path === this.app.workspace.getActiveFile()?.path) {
          debouncedValidate();
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => debouncedValidate())
    );

    const onVaultChange = (file: TAbstractFile, oldPath?: string) => {
      const paths = oldPath === undefined ? [file.path] : [file.path, oldPath];
      if (paths.some((p) => this.loader.isSchemaPath(p))) {
        debouncedReload();
      }
    };
    this.registerEvent(this.app.vault.on("modify", (f) => onVaultChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => onVaultChange(f)));
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => onVaultChange(f, oldPath))
    );

    this.app.workspace.onLayoutReady(() => {
      // Registered here so the initial vault index doesn't fire the creation hook.
      this.registerEvent(
        this.app.vault.on("create", (file) => this.onFileCreated(file))
      );
      void this.reloadSchemas();
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async reloadSchemas(): Promise<void> {
    await this.loader.reload();
    await this.validateActiveFile();
  }

  /** Validate the active markdown file and refresh badge + pane. */
  async validateActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md" || !this.loader.base) {
      this.violations = [];
      this.validatedFile = null;
      this.updateBadge(null);
      this.refreshView();
      return;
    }
    this.validatedFile = file;
    this.violations = validate(this.buildInput(file));
    this.updateBadge(this.violations.filter((v) => !v.suppressed).length);
    this.refreshView();
  }

  private buildInput(file: TFile): ValidationInput {
    const cache = this.app.metadataCache.getFileCache(file);
    let frontmatter: Record<string, unknown> | null = null;
    if (cache?.frontmatter) {
      frontmatter = { ...cache.frontmatter };
      delete (frontmatter as Record<string, unknown>)["position"];
    }
    return {
      // buildInput is only called when loader.base is set.
      base: this.loader.base!,
      manifests: this.loader.manifests,
      class_locations: this.loader.classLocations,
      exceptions: this.loader.exceptions,
      file: { path: file.path, frontmatter },
    };
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_WARDEN);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_WARDEN, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  refreshView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WARDEN)) {
      if (leaf.view instanceof WardenView) leaf.view.render();
    }
  }

  /** Apply the mechanical suggested_fix of the given violations in ONE frontmatter write. */
  async applyFixes(violations: Violation[]): Promise<void> {
    const file = this.validatedFile;
    if (!file) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      applyAllFixes(fm, violations);
    });
    // metadataCache 'changed' re-validates; nothing else to do.
  }

  /** Manual override: prompt for a value (schema-fed picker where possible), then set it. */
  openManualFix(violationToFix: Violation): void {
    const file = this.validatedFile;
    const field = violationToFix.field;
    if (!file || !field) return;

    const apply = (value: string) => void this.applyManualValue(violationToFix, value);
    const allowed = this.allowedValuesFor(file, field);
    if (allowed && allowed.length > 0) {
      new ValueSuggestModal(this.app, allowed, `Value for ${field}…`, apply).open();
    } else {
      new TextPromptModal(
        this.app,
        `Set ${field}`,
        violationToFix.found ?? "",
        apply
      ).open();
    }
  }

  private async applyManualValue(violationToFix: Violation, raw: string): Promise<void> {
    const file = this.validatedFile;
    const field = violationToFix.field;
    if (!file || !field || raw.trim() === "") return;

    const spec = this.fieldSpecFor(file, field);
    const value: unknown = spec?.type === "number" && raw.trim() !== "" && !isNaN(Number(raw))
      ? Number(raw)
      : raw;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (field === "tags" && violationToFix.found) {
        applyFixToFrontmatter(
          fm,
          { op: "replace_tag", field: "tags", found: violationToFix.found, value },
          violationToFix.found
        );
      } else {
        // List-aware: replaces the offending item when the field holds a list.
        applyFixToFrontmatter(
          fm,
          { op: "set_field", field, value },
          violationToFix.found ?? null
        );
      }
    });
  }

  /** The schema's FieldSpec for a field on this file: class manifest first, then base. */
  private fieldSpecFor(file: TFile, field: string): FieldSpec | null {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const classValue = fm?.["class"];
    const className = Array.isArray(classValue) ? classValue[0] : classValue;
    if (typeof className === "string") {
      const spec = this.loader.manifests[className]?.fields?.[field];
      if (spec) return spec;
    }
    return this.loader.base?.fields?.[field] ?? null;
  }

  /** Allowed values for a field, if it's backed by a closed list. Special case: class. */
  private allowedValuesFor(file: TFile, field: string): string[] | null {
    if (field === "class") return Object.keys(this.loader.manifests).sort();
    const spec = this.fieldSpecFor(file, field);
    return spec?.values && spec.values.length > 0 ? spec.values : null;
  }

  private updateBadge(count: number | null): void {
    const el = this.statusBarEl;
    if (!el) return;
    if (count === null) {
      el.setText("");
      el.hide();
      return;
    }
    el.show();
    el.setText(count === 0 ? "Warden ✓" : `Warden ${count}`);
    el.toggleClass("vault-warden-has-violations", count > 0);
  }

  /** Creation hook: stamp class + creation_stamp keys on notes born in mapped folders. */
  private onFileCreated(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const locations = this.loader.classLocations;
    if (locations.length === 0) return;

    let match: string | null = null;
    let matchLen = -1;
    for (const loc of locations) {
      if (loc.prefix !== "" && file.path.startsWith(loc.prefix) && loc.prefix.length > matchLen) {
        match = loc.class;
        matchLen = loc.prefix.length;
      }
    }
    if (!match) return;
    const stampClass = match;
    const stamp = this.loader.creationStamp;

    // Let template plugins finish writing first; skip if a class appeared meanwhile.
    window.setTimeout(() => {
      const current = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (current && current["class"] != null && current["class"] !== "") return;
      void this.app.fileManager.processFrontMatter(file, (fm) => {
        if (fm["class"] != null && fm["class"] !== "") return;
        fm["class"] = stampClass;
        for (const [key, value] of Object.entries(stamp)) {
          if (fm[key] == null || fm[key] === "") fm[key] = value;
        }
      });
    }, 800);
  }
}
