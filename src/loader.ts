import { App, TFile, TFolder, parseYaml } from "obsidian";
import type { BaseSchema, ClassManifest } from "./engine/types";

/**
 * Loads and caches the base schema, class manifests, and select-source line lists
 * from the vault. Pure state holder — event wiring (hot reload triggers) lives in
 * main.ts, which calls reload()/invalidateSource() as vault events arrive.
 */
export class SchemaLoader {
  private app: App;
  private getSchemaPath: () => string;

  base: BaseSchema | null = null;
  classes: Record<string, ClassManifest> = {};
  /** Human-readable problems from the last load (bad YAML, missing class key…). */
  loadErrors: string[] = [];

  private sourceCache = new Map<string, string[]>();

  constructor(app: App, getSchemaPath: () => string) {
    this.app = app;
    this.getSchemaPath = getSchemaPath;
  }

  /** Vault-relative path of the configured base schema file. */
  get basePath(): string {
    return this.getSchemaPath();
  }

  /** Folder containing the base schema (class manifests live alongside). */
  get schemasFolder(): string {
    const path = this.basePath;
    const idx = path.lastIndexOf("/");
    return idx === -1 ? "" : path.slice(0, idx);
  }

  /** Folder the base schema points select: sources at. */
  get sourcesFolder(): string {
    return this.base?.metadata_sources ?? "";
  }

  /** True when the configured base schema file exists in the vault. */
  baseFileExists(): boolean {
    return this.app.vault.getFileByPath(this.basePath) !== null;
  }

  /** True if a vault path change should trigger a schema reload. */
  isSchemaPath(path: string): boolean {
    const folder = this.schemasFolder;
    return (
      path === this.basePath ||
      (folder !== "" &&
        path.startsWith(folder + "/") &&
        (path.endsWith(".yaml") || path.endsWith(".yml")))
    );
  }

  /** True if a vault path change should invalidate the source-list cache. */
  isSourcePath(path: string): boolean {
    const folder = this.sourcesFolder;
    return folder !== "" && path.startsWith(folder + "/") && path.endsWith(".md");
  }

  /** Re-read base.yaml and all sibling class manifests. */
  async reload(): Promise<void> {
    this.base = null;
    this.classes = {};
    this.loadErrors = [];
    this.sourceCache.clear();

    const baseFile = this.app.vault.getFileByPath(this.basePath);
    if (!baseFile) {
      this.loadErrors.push(`Base schema not found: ${this.basePath}`);
      return;
    }

    const parsedBase = await this.parseFile(baseFile);
    if (parsedBase === null) return;
    this.base = parsedBase as BaseSchema;

    const folder = this.app.vault.getFolderByPath(this.schemasFolder);
    if (!(folder instanceof TFolder)) return;

    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      if (child.path === this.basePath) continue;
      if (child.extension !== "yaml" && child.extension !== "yml") continue;
      const parsed = await this.parseFile(child);
      if (parsed === null) continue;
      const manifest = parsed as ClassManifest;
      if (typeof manifest.class !== "string" || manifest.class.trim() === "") {
        this.loadErrors.push(`${child.path}: missing top-level "class" key`);
        continue;
      }
      if (this.classes[manifest.class]) {
        this.loadErrors.push(`${child.path}: duplicate class "${manifest.class}"`);
        continue;
      }
      this.classes[manifest.class] = manifest;
    }
  }

  /**
   * Resolve every source list the loaded schema can reference: select: types across
   * all class manifests plus any rule-configured source. Missing source notes are
   * simply absent from the result (the engine fails open).
   */
  async resolveSources(): Promise<Record<string, string[]>> {
    const names = new Set<string>();
    for (const manifest of Object.values(this.classes)) {
      for (const spec of Object.values(manifest.fields ?? {})) {
        const type = spec?.type;
        if (typeof type === "string" && type.startsWith("select:")) {
          const name = type.slice("select:".length).trim();
          if (name) names.add(name);
        }
      }
    }
    const areaRule = this.base?.rules?.["FM-AREA-INVALID"];
    if (areaRule?.source) names.add(areaRule.source);

    const out: Record<string, string[]> = {};
    for (const name of names) {
      const values = await this.readSource(name);
      if (values !== null) out[name] = values;
    }
    return out;
  }

  /** Drop one cached source list (call when its note changes). */
  invalidateSource(path: string): void {
    for (const [name, _] of this.sourceCache) {
      if (this.sourcePathFor(name) === path) this.sourceCache.delete(name);
    }
  }

  private sourcePathFor(name: string): string {
    const folder = this.sourcesFolder;
    return folder === "" ? `${name}.md` : `${folder}/${name}.md`;
  }

  /** Read a line-list source note: one value per line, '#' lines and blanks skipped. */
  private async readSource(name: string): Promise<string[] | null> {
    const cached = this.sourceCache.get(name);
    if (cached) return cached;

    const file = this.app.vault.getFileByPath(this.sourcePathFor(name));
    if (!file) return null;

    const raw = await this.app.vault.cachedRead(file);
    const lines = raw.split(/\r?\n/);
    let start = 0;
    if (lines[0]?.trim() === "---") {
      const end = lines.indexOf("---", 1);
      if (end !== -1) start = end + 1;
    }
    const values: string[] = [];
    for (let i = start; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "" || line.startsWith("#")) continue;
      values.push(line);
    }
    this.sourceCache.set(name, values);
    return values;
  }

  private async parseFile(file: TFile): Promise<unknown | null> {
    try {
      const raw = await this.app.vault.cachedRead(file);
      const parsed = parseYaml(raw);
      if (parsed === null || typeof parsed !== "object") {
        this.loadErrors.push(`${file.path}: not a YAML mapping`);
        return null;
      }
      return parsed;
    } catch (e) {
      this.loadErrors.push(`${file.path}: YAML parse error (${String(e)})`);
      return null;
    }
  }
}
