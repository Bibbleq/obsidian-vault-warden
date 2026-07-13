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
  STARTER_BASE_YAML,
  STARTER_CLASS_FILENAME,
  STARTER_CLASS_YAML,
  STARTER_LOCATIONS_FILENAME,
  STARTER_LOCATIONS_YAML,
} from "./starter";

export interface VaultWardenSettings {
  schemaPath: string;
}

export const DEFAULT_SETTINGS: VaultWardenSettings = {
  schemaPath: "_vault/Metadata Sources/Schemas/Vault.yaml",
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

    new Setting(containerEl)
      .setName("Vault schema file")
      .setDesc(
        "Vault-relative path to the vault-wide schema (e.g. Vault.yaml). Class " +
          "manifests, class_locations, and exceptions are the other YAML (or " +
          "YAML-as-.md) files in the same folder; select-source notes live in the " +
          "folder above it."
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.schemaPath)
          .setValue(this.plugin.settings.schemaPath)
          .onChange(async (value) => {
            this.plugin.settings.schemaPath = normalizePath(value.trim());
            await this.plugin.saveSettings();
            await this.plugin.reloadSchemas();
            this.updateStatus();
          });
        new SchemaFileSuggest(this.app, text.inputEl, async (file) => {
          text.setValue(file.path);
          this.plugin.settings.schemaPath = file.path;
          await this.plugin.saveSettings();
          await this.plugin.reloadSchemas();
          this.updateStatus();
        });
      });

    this.statusEl = containerEl.createDiv({ cls: "vault-warden-settings-status" });
    this.updateStatus();
  }

  private statusEl: HTMLElement | null = null;

  private updateStatus(): void {
    const el = this.statusEl;
    if (!el) return;
    el.empty();

    const loader = this.plugin.loader;
    if (!loader.baseFileExists()) {
      el.createEl("p", {
        text: `No schema found at "${this.plugin.settings.schemaPath}". Vault Warden is idle until a base schema exists.`,
      });
      new Setting(el)
        .setName("Create starter schema")
        .setDesc(
          "Scaffolds a commented base schema, an example class manifest, and an empty class_locations file at the configured path."
        )
        .addButton((btn) =>
          btn
            .setButtonText("Create starter schema")
            .setCta()
            .onClick(async () => {
              await this.scaffoldStarter();
              this.updateStatus();
            })
        );
      return;
    }

    const classCount = Object.keys(loader.manifests).length;
    const parts = [
      `${classCount} class manifest${classCount === 1 ? "" : "s"}`,
      `${loader.classLocations.length} mapped folder${loader.classLocations.length === 1 ? "" : "s"}`,
      `${loader.exceptions.length} exception${loader.exceptions.length === 1 ? "" : "s"}`,
    ];
    el.createEl("p", { text: `Schema loaded: ${parts.join(", ")}.` });
    if (loader.loadErrors.length > 0) {
      const list = el.createEl("ul");
      for (const err of loader.loadErrors) {
        list.createEl("li", { text: err });
      }
    }
    this.renderRules(el);
  }

  /** What the loaded schema activates, rule by rule, grouped by category. */
  private renderRules(el: HTMLElement): void {
    const loader = this.plugin.loader;
    const base = loader.base;
    if (!base) return;

    el.createEl("h3", { text: "Active rules" });
    const table = el.createEl("div", { cls: "vault-warden-rules" });

    const category = (title: string) =>
      table.createEl("div", { cls: "vault-warden-rules-category", text: title });
    const rule = (ids: string, active: boolean, detail: string) => {
      const row = table.createEl("div", { cls: "vault-warden-rules-row" });
      row.createEl("code", { text: ids });
      row.createEl("span", {
        text: active ? detail : `inactive — ${detail}`,
        cls: active ? "" : "vault-warden-rule-inactive",
      });
    };

    category("Base fields (every note)");
    for (const name of ["area", "notetype", "origin"]) {
      const spec = base.fields[name];
      const upper = name.toUpperCase();
      if (spec) {
        const source = spec.source ? ` from ${spec.source}` : "";
        const unless = spec.required_unless
          ? `; optional when ${spec.required_unless} is set`
          : "";
        rule(
          `FM-${upper}-MISSING · FM-${upper}-INVALID`,
          true,
          `${spec.values?.length ?? 0} allowed value(s)${source}${unless}`
        );
      } else {
        rule(`FM-${upper}-MISSING · FM-${upper}-INVALID`, false, "field not in the vault schema");
      }
    }

    category("Tags (every note)");
    rule("TAG-FORMAT · TAG-CASE", true, "PascalCase alphanumeric segments joined by /");
    rule("TAG-DEPTH", true, `at most ${base.tags.max_depth} level(s)`);
    rule(
      "TAG-RETIRED",
      base.tags.retired.length > 0,
      base.tags.retired.length > 0
        ? `${base.tags.retired.length} retired tag(s)`
        : "no retired tags listed"
    );
    rule("TAG-DUPLICATE", true, "no exact duplicate entries");

    category("Dates");
    rule(
      "DATE-FORMAT",
      true,
      `ISO check on class date fields and any field ending ${base.date_name_suffixes.join(" / ")}` +
        (base.presence_only.length > 0
          ? `; exempt: ${base.presence_only.join(", ")}`
          : "")
    );
    rule("CREATED-MISSING", true, "created must be present on every note");

    const classCount = Object.keys(loader.manifests).length;
    category("Classes");
    rule(
      "CLASS-UNKNOWN · CLASS-FIELD-MISSING · CLASS-FIELD-TYPE · CLASS-FIELD-VALUE",
      classCount > 0,
      classCount > 0 ? `${classCount} class manifest(s)` : "no class manifests loaded"
    );

    category("Folder locations");
    rule(
      "CLASS-EXPECTED · CLASS-MISFILED",
      loader.classLocations.length > 0,
      loader.classLocations.length > 0
        ? `${loader.classLocations.length} mapped folder prefix(es)`
        : "no class_locations file"
    );

    el.createEl("p", {
      cls: "vault-warden-rules-note",
      text:
        "Per-note opt-out: list rule IDs under validator_ignore in a note's frontmatter. " +
        `Vault-wide: ${loader.exceptions.length} exception entr${loader.exceptions.length === 1 ? "y" : "ies"} loaded from the exceptions file.`,
    });
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
          // Folder may have been created concurrently; only report other failures.
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
