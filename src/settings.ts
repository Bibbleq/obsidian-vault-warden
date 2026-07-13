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
} from "./starter";

export interface VaultWardenSettings {
  schemaPath: string;
}

export const DEFAULT_SETTINGS: VaultWardenSettings = {
  schemaPath: "_vault/Metadata Sources/Schemas/base.yaml",
};

/** Suggests YAML files from the vault while typing in the schema-path field. */
class YamlFileSuggest extends AbstractInputSuggest<TFile> {
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
          (f.extension === "yaml" || f.extension === "yml") &&
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
      .setName("Base schema file")
      .setDesc(
        "Vault-relative path to base.yaml. Class manifests are every other YAML file in the same folder."
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
        new YamlFileSuggest(this.app, text.inputEl, async (file) => {
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
      const warn = el.createEl("p");
      warn.setText(
        `No schema found at "${loader.basePath}". Vault Warden is idle until a base schema exists.`
      );
      new Setting(el)
        .setName("Create starter schema")
        .setDesc(
          "Scaffolds a commented base.yaml plus an example class manifest at the configured path."
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

    const info = el.createEl("p");
    const classCount = Object.keys(loader.classes).length;
    info.setText(
      `Schema loaded: ${classCount} class manifest${classCount === 1 ? "" : "s"}.`
    );
    if (loader.loadErrors.length > 0) {
      const list = el.createEl("ul");
      for (const err of loader.loadErrors) {
        list.createEl("li", { text: err });
      }
    }
  }

  private async scaffoldStarter(): Promise<void> {
    const basePath = normalizePath(this.plugin.settings.schemaPath);
    if (!basePath.endsWith(".yaml") && !basePath.endsWith(".yml")) {
      new Notice("Schema path must point at a .yaml file.");
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

    if (!this.app.vault.getFileByPath(basePath)) {
      await this.app.vault.create(basePath, STARTER_BASE_YAML);
    }
    const folder = segments.join("/");
    const examplePath =
      folder === "" ? STARTER_CLASS_FILENAME : `${folder}/${STARTER_CLASS_FILENAME}`;
    if (!this.app.vault.getAbstractFileByPath(examplePath)) {
      await this.app.vault.create(examplePath, STARTER_CLASS_YAML);
    }

    await this.plugin.reloadSchemas();
    new Notice("Vault Warden: starter schema created.");
  }
}
