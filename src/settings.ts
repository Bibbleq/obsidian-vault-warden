import {
  AbstractInputSuggest,
  App,
  Notice,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import type VaultWardenPlugin from "./main";
import {
  renderActiveRules,
  renderClassesTab,
  renderExceptionsTab,
  renderRulesTab,
  renderTitleSyncTab,
} from "./schemaeditor";
import {
  STARTER_BASE_YAML,
  STARTER_CLASS_FILENAME,
  STARTER_CLASS_YAML,
  STARTER_LOCATIONS_FILENAME,
  STARTER_LOCATIONS_YAML,
} from "./starter";

export interface VaultWardenSettings {
  schemaPath: string;
  /** Rule ID -> apply its mechanical fix automatically (default: manual). */
  autoFix: Record<string, boolean>;
  /** Last-open settings tab. */
  settingsTab: string;
  /** Pane group key -> collapsed (true) / expanded (false). Absent = default. */
  collapsedSections: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: VaultWardenSettings = {
  schemaPath: "_vault/Metadata Sources/Schemas/Vault.yaml",
  autoFix: {},
  settingsTab: "Overview",
  collapsedSections: {},
};

const TABS = ["Overview", "Rules", "Classes", "Title sync", "Exceptions"] as const;

/** Which tab owns each fix-capable rule (for the Overview audit chips). */
export const FIX_RULE_TAB: Record<string, string> = {
  "FM-AREA-MISSING": "Rules",
  "NOTETYPE-CASE": "Rules",
  "TAG-FORMAT": "Rules",
  "TAG-CASE": "Rules",
  "TAG-RETIRED": "Rules",
  "TAG-DUPLICATE": "Rules",
  "DATE-FORMAT": "Rules",
  "CREATED-MISSING": "Rules",
  "CLASS-EXPECTED": "Classes",
  "STATUS-STALE": "Classes",
  "H1-MISSING": "Title sync",
  "H1-WHITESPACE": "Title sync",
  "H1-DEGENERATE": "Title sync",
  "FILENAME-SYNC": "Title sync",
  "TITLE-PROPERTY": "Title sync",
};

/** Suggests schema-capable files (.yaml/.yml/.md) while typing the schema path. */
class SchemaFileSuggest extends AbstractInputSuggest<TFile> {
  private onPick: (file: TFile) => void;

  constructor(app: App, input: HTMLInputElement, onPick: (file: TFile) => void) {
    super(app, input);
    this.onPick = onPick;
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.app.vault
      .getFiles()
      .filter(
        (f) =>
          (f.extension === "yaml" || f.extension === "yml" || f.extension === "md") &&
          f.path.toLowerCase().includes(q)
      )
      .slice(0, 20);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.onPick(file);
    this.close();
  }
}

export class VaultWardenSettingTab extends PluginSettingTab {
  plugin: VaultWardenPlugin;

  constructor(app: App, plugin: VaultWardenPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderHeader(containerEl);
    this.renderTabBar(containerEl);

    const body = containerEl.createDiv({ cls: "vault-warden-tab-body" });
    const refresh = () => this.display();
    switch (this.plugin.settings.settingsTab) {
      case "Rules":
        renderRulesTab(body, this.plugin, refresh);
        break;
      case "Classes":
        renderClassesTab(body, this.plugin, refresh);
        break;
      case "Title sync":
        renderTitleSyncTab(body, this.plugin, refresh);
        break;
      case "Exceptions":
        renderExceptionsTab(body, this.plugin, refresh);
        break;
      default:
        this.renderOverview(body);
    }
  }

  private renderHeader(containerEl: HTMLElement): void {
    const loader = this.plugin.loader;
    const card = containerEl.createDiv({ cls: "vault-warden-header" });
    const top = card.createDiv({ cls: "vault-warden-header-top" });
    top.createDiv({ cls: "vault-warden-header-icon", text: "🛡" });
    const titleWrap = top.createDiv({ cls: "vault-warden-header-title" });
    const nameLine = titleWrap.createDiv();
    nameLine.createEl("strong", { text: "Vault Warden " });
    nameLine.createEl("span", {
      text: `v${this.plugin.manifest.version}`,
      cls: "vault-warden-header-version",
    });
    titleWrap.createDiv({
      text: this.plugin.settings.schemaPath,
      cls: "vault-warden-header-path",
    });
    const link = top.createEl("a", {
      text: "GitHub",
      href: "https://github.com/Bibbleq/obsidian-vault-warden",
    });
    link.addClass("vault-warden-header-link");

    const chipsRow = card.createDiv({ cls: "vault-warden-status-chips" });
    const chip = (text: string, cls = "") => {
      chipsRow.createEl("span", { text, cls: `vault-warden-status-chip ${cls}` });
    };
    if (!loader.baseFileExists()) {
      chip("no schema", "is-error");
      return;
    }
    chip("schema loaded", "is-ok");
    chip(`${Object.keys(loader.manifests).length} classes`);
    chip(`${loader.classLocations.length} mapped folders`);
    chip(`${loader.exceptions.length} exceptions`);
    chip(
      `${loader.loadErrors.length} problem${loader.loadErrors.length === 1 ? "" : "s"}`,
      loader.loadErrors.length > 0 ? "is-error" : ""
    );
  }

  private renderTabBar(containerEl: HTMLElement): void {
    const bar = containerEl.createDiv({ cls: "vault-warden-tabbar" });
    for (const tab of TABS) {
      const btn = bar.createEl("button", { text: tab, cls: "vault-warden-tab" });
      if (tab === this.plugin.settings.settingsTab) btn.addClass("is-active");
      btn.addEventListener("click", () => this.switchTab(tab));
    }
  }

  switchTab(tab: string): void {
    this.plugin.settings.settingsTab = tab;
    void this.plugin.saveSettings();
    this.display();
  }

  private renderOverview(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Vault schema file")
      .setDesc(
        "Vault-relative path to the vault-wide schema. Class manifests, class_locations, " +
          "and exceptions are the other YAML (or YAML-as-.md) files in the same folder; " +
          "select-source notes live in the folder above it."
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.schemaPath)
          .setValue(this.plugin.settings.schemaPath)
          .onChange(async (value) => {
            this.plugin.settings.schemaPath = normalizePath(value.trim());
            await this.plugin.saveSettings();
            await this.plugin.reloadSchemas();
          });
        new SchemaFileSuggest(this.app, text.inputEl, async (file) => {
          text.setValue(file.path);
          this.plugin.settings.schemaPath = file.path;
          await this.plugin.saveSettings();
          await this.plugin.reloadSchemas();
          this.display();
        });
      });

    if (!this.plugin.loader.baseFileExists()) {
      new Setting(containerEl)
        .setName("Create starter schema")
        .setDesc(
          "Scaffolds a commented vault schema, an example class manifest, and an empty class_locations file at the configured path."
        )
        .addButton((btn) =>
          btn
            .setButtonText("Create starter schema")
            .setCta()
            .onClick(async () => {
              await this.scaffoldStarter();
              this.display();
            })
        );
      return;
    }

    // Audit surface: everything allowed to change the vault without asking.
    const auto = Object.entries(this.plugin.settings.autoFix)
      .filter(([, on]) => on)
      .map(([rule]) => rule)
      .sort();
    const auditSetting = new Setting(containerEl)
      .setName("Automatic fixes")
      .setDesc(
        auto.length === 0
          ? "None — every fix is a button in the pane. Enable per rule in its own section."
          : "Applied silently on detection. Click a rule to open its section."
      );
    if (auto.length > 0) {
      const wrap = auditSetting.controlEl.createDiv({ cls: "vault-warden-chips" });
      for (const rule of auto) {
        const chipEl = wrap.createEl("span", {
          text: rule,
          cls: "vault-warden-chip vault-warden-chip-link",
        });
        chipEl.addEventListener("click", () => this.switchTab(FIX_RULE_TAB[rule] ?? "Rules"));
      }
    }

    const errors = this.plugin.loader.loadErrors;
    if (errors.length > 0) {
      const box = containerEl.createDiv({ cls: "vault-warden-settings-status" });
      box.createEl("p", { text: "Schema problems:" });
      const list = box.createEl("ul");
      for (const err of errors) list.createEl("li", { text: err });
    }

    const details = containerEl.createEl("details", { cls: "vault-warden-overview-rules" });
    details.createEl("summary", { text: "Active rules" });
    renderActiveRules(details, this.plugin);
  }

  private async scaffoldStarter(): Promise<void> {
    const basePath = normalizePath(this.plugin.settings.schemaPath);
    if (!/\.(yaml|yml|md)$/.test(basePath)) {
      new Notice("Schema path must point at a .yaml (or .md) file.");
      return;
    }

    // Create parent folders one segment at a time (createFolder is not recursive
    // on all platforms).
    const segments = basePath.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (e) {
          if (!this.app.vault.getAbstractFileByPath(current)) {
            new Notice(`Could not create folder "${current}": ${String(e)}`);
            return;
          }
        }
      }
    }

    const folder = segments.join("/");
    const inFolder = (name: string) => (folder === "" ? name : `${folder}/${name}`);

    if (!this.app.vault.getFileByPath(basePath)) {
      await this.app.vault.create(basePath, STARTER_BASE_YAML);
    }
    if (!this.app.vault.getAbstractFileByPath(inFolder(STARTER_CLASS_FILENAME))) {
      await this.app.vault.create(inFolder(STARTER_CLASS_FILENAME), STARTER_CLASS_YAML);
    }
    if (!this.app.vault.getAbstractFileByPath(inFolder(STARTER_LOCATIONS_FILENAME))) {
      await this.app.vault.create(
        inFolder(STARTER_LOCATIONS_FILENAME),
        STARTER_LOCATIONS_YAML
      );
    }

    await this.plugin.reloadSchemas();
    new Notice("Vault Warden: starter schema created.");
  }
}
