import {
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  debounce,
} from "obsidian";
import { validate } from "./engine/validate";
import type { ValidationInput, Violation } from "./engine/types";
import { SchemaLoader } from "./loader";
import {
  DEFAULT_SETTINGS,
  VaultWardenSettings,
  VaultWardenSettingTab,
} from "./settings";

export default class VaultWardenPlugin extends Plugin {
  settings: VaultWardenSettings = DEFAULT_SETTINGS;
  loader!: SchemaLoader;

  /** Violations for the active file from the most recent validation. */
  violations: Violation[] = [];

  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.loader = new SchemaLoader(this.app, () => this.settings.schemaPath);
    this.addSettingTab(new VaultWardenSettingTab(this.app, this));

    // Status bar is a no-op container on mobile; harmless to create there.
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.onClickEvent(() => this.showViolationsNotice());
    this.updateBadge(null);

    this.addCommand({
      id: "validate-current-note",
      name: "Validate current note",
      callback: async () => {
        await this.validateActiveFile();
        this.showViolationsNotice();
      },
    });

    const debouncedValidate = debounce(
      () => void this.validateActiveFile(),
      400,
      true
    );
    const debouncedReload = debounce(
      () => void this.reloadSchemas(),
      400,
      true
    );

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
      for (const p of paths) {
        if (this.loader.isSourcePath(p)) this.loader.invalidateSource(p);
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

  /** Validate the active markdown file and refresh the badge. */
  async validateActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md" || !this.loader.base) {
      this.violations = [];
      this.updateBadge(null);
      return;
    }
    this.violations = validate(await this.buildInput(file));
    this.updateBadge(this.violations.length);
  }

  private async buildInput(file: TFile): Promise<ValidationInput> {
    const cache = this.app.metadataCache.getFileCache(file);
    let frontmatter: Record<string, unknown> | null = null;
    if (cache?.frontmatter) {
      frontmatter = { ...cache.frontmatter };
      delete (frontmatter as Record<string, unknown>)["position"];
    }
    return {
      config: this.loader.base ?? {},
      classes: this.loader.classes,
      sources: await this.loader.resolveSources(),
      file: { path: file.path, frontmatter },
    };
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

  /** Interim violation display until the sidebar pane ships. */
  private showViolationsNotice(): void {
    if (!this.loader.base) {
      new Notice("Vault Warden: no schema loaded (see plugin settings).");
      return;
    }
    if (this.violations.length === 0) {
      new Notice("Vault Warden: no violations.");
      return;
    }
    const lines = this.violations
      .slice(0, 8)
      .map((v) => `${v.rule}${v.field ? ` (${v.field})` : ""}: ${v.message}`);
    if (this.violations.length > 8) {
      lines.push(`…and ${this.violations.length - 8} more`);
    }
    new Notice(lines.join("\n"), 8000);
  }

  /** Creation hook: stamp class + creation_stamp keys on notes born in mapped folders. */
  private onFileCreated(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const base = this.loader.base;
    if (!base?.class_locations) return;

    const classKey = base.class_key ?? "class";
    let match: string | null = null;
    let matchLen = -1;
    for (const [folder, cls] of Object.entries(base.class_locations)) {
      if (folder !== "" && file.path.startsWith(folder + "/") && folder.length > matchLen) {
        match = cls;
        matchLen = folder.length;
      }
    }
    if (!match) return;
    const stampClass = match;

    // Let template plugins finish writing first; skip if a class appeared meanwhile.
    window.setTimeout(() => {
      const current = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (current && current[classKey] != null && current[classKey] !== "") return;
      void this.app.fileManager.processFrontMatter(file, (fm) => {
        if (fm[classKey] != null && fm[classKey] !== "") return;
        fm[classKey] = stampClass;
        for (const [key, value] of Object.entries(base.creation_stamp ?? {})) {
          if (fm[key] == null || fm[key] === "") fm[key] = value;
        }
      });
    }, 800);
  }
}
