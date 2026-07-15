import { App, TFile, TFolder, parseYaml } from "obsidian";
import type {
  BaseSchema,
  ClassLocation,
  DisplaySection,
  ExceptionRule,
  FieldSpec,
  FieldType,
  LifecycleRule,
  Manifest,
  TitleSyncConfig,
} from "./engine/types";

const BASE_TYPES: FieldType[] = [
  "date",
  "datetime",
  "select",
  "multi",
  "list",
  "wikilink",
  "text",
  "number",
  "url",
];

/** Stems in the schemas folder that are not class manifests. */
const NON_MANIFEST_STEMS = ["Vault", "vault", "base", "exceptions", "class_locations"];

/** Schema files may travel as .yaml or .md (Obsidian Sync transport); .yaml wins. */
const SCHEMA_EXTENSIONS = ["yaml", "yml", "md"];

/**
 * Loads the schema set from the vault, mirroring the reference validator's
 * loader semantics: base + class manifests + class_locations + exceptions in
 * one folder, `select:<Source>` / `multi:<Source>` values resolved at load
 * time from line-list notes in the folder ABOVE the schemas folder.
 */
export class SchemaLoader {
  private app: App;
  private getSchemaPath: () => string;

  base: BaseSchema | null = null;
  manifests: Record<string, Manifest> = {};
  classLocations: ClassLocation[] = [];
  exceptions: ExceptionRule[] = [];
  /** Extra keys the creation hook stamps alongside class (plugin-only config). */
  creationStamp: Record<string, string> = {};
  /** Filename<->H1 sync config; null = feature off (no title_sync block). */
  titleSync: TitleSyncConfig | null = null;
  /** Human-readable problems from the last load. */
  loadErrors: string[] = [];

  /** Resolved file paths from the last load (for the settings GUI's writes). */
  baseFilePath: string | null = null;
  manifestPaths: Record<string, string> = {};
  classLocationsPath: string | null = null;
  exceptionsPath: string | null = null;

  constructor(app: App, getSchemaPath: () => string) {
    this.app = app;
    this.getSchemaPath = getSchemaPath;
  }

  /** Folder containing the base schema file. */
  get schemasFolder(): string {
    const path = this.getSchemaPath();
    const idx = path.lastIndexOf("/");
    return idx === -1 ? "" : path.slice(0, idx);
  }

  /** Folder holding the line-list source notes (parent of the schemas folder). */
  get sourcesFolder(): string {
    const folder = this.schemasFolder;
    const idx = folder.lastIndexOf("/");
    return idx === -1 ? "" : folder.slice(0, idx);
  }

  baseFileExists(): boolean {
    return this.findSchemaFile(this.baseStem()) !== null;
  }

  /** The configured base file's stem (usually "base"). */
  private baseStem(): string {
    const path = this.getSchemaPath();
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot === -1 ? name : name.slice(0, dot);
  }

  /** True if a changed vault path should trigger a schema reload. */
  isSchemaPath(path: string): boolean {
    const schemas = this.schemasFolder;
    if (schemas !== "" && path.startsWith(schemas + "/")) {
      return SCHEMA_EXTENSIONS.some((ext) => path.endsWith("." + ext));
    }
    // Source line-list notes feed resolved values, so they reload too.
    const sources = this.sourcesFolder;
    return (
      sources !== "" &&
      path.startsWith(sources + "/") &&
      path.endsWith(".md") &&
      !(schemas !== "" && path.startsWith(schemas + "/"))
    );
  }

  /** Prefer <stem>.yaml, then .yml, then .md — extension is transport, not format. */
  private findSchemaFile(stem: string): TFile | null {
    const folder = this.schemasFolder;
    for (const ext of SCHEMA_EXTENSIONS) {
      const path = folder === "" ? `${stem}.${ext}` : `${folder}/${stem}.${ext}`;
      const file = this.app.vault.getFileByPath(path);
      if (file) return file;
    }
    return null;
  }

  async reload(): Promise<void> {
    this.base = null;
    this.manifests = {};
    this.classLocations = [];
    this.exceptions = [];
    this.creationStamp = {};
    this.titleSync = null;
    this.loadErrors = [];

    this.baseFilePath = null;
    this.manifestPaths = {};
    this.classLocationsPath = this.findSchemaFile("class_locations")?.path ?? null;
    this.exceptionsPath = this.findSchemaFile("exceptions")?.path ?? null;

    const baseFile = this.findSchemaFile(this.baseStem());
    if (!baseFile) {
      this.loadErrors.push(`Base schema not found: ${this.getSchemaPath()}`);
      return;
    }
    this.baseFilePath = baseFile.path;

    const baseData = await this.parseFile(baseFile);
    if (baseData === null) return;
    this.base = await this.parseBase(baseData);
    this.creationStamp = this.parseCreationStamp(baseData);
    this.titleSync = this.parseTitleSync(baseData);

    const folder = this.app.vault.getFolderByPath(this.schemasFolder);
    if (folder instanceof TFolder) {
      const seenStems = new Set<string>();
      const children = folder.children
        .filter((c): c is TFile => c instanceof TFile)
        .filter((f) => SCHEMA_EXTENSIONS.includes(f.extension))
        // .yaml before .yml before .md so the preferred transport wins per stem
        .sort(
          (a, b) =>
            SCHEMA_EXTENSIONS.indexOf(a.extension) -
              SCHEMA_EXTENSIONS.indexOf(b.extension) ||
            a.path.localeCompare(b.path)
        );
      for (const child of children) {
        const stem = child.basename;
        if (stem === this.baseStem() || NON_MANIFEST_STEMS.includes(stem)) continue;
        if (seenStems.has(stem)) continue;
        seenStems.add(stem);
        const data = await this.parseFile(child);
        if (data === null) continue;
        const manifest = await this.parseManifest(stem, data, child.path);
        if (manifest) {
          this.manifests[manifest.name] = manifest;
          this.manifestPaths[manifest.name] = child.path;
        }
      }
    }

    this.classLocations = await this.loadClassLocations();
    this.exceptions = await this.loadExceptions();
  }

  private async parseBase(data: Record<string, unknown>): Promise<BaseSchema> {
    const fields: Record<string, FieldSpec> = {};
    const rawFields = asRecord(data["fields"]);
    for (const [name, spec] of Object.entries(rawFields)) {
      const parsed = await this.parseField(name, asRecord(spec));
      if (parsed) fields[name] = parsed;
    }
    const tags = asRecord(data["tags"]);
    const dates = asRecord(data["dates"]);
    const presenceOnly =
      (dates["presence_only"] as unknown[]) ??
      (dates["linter_managed"] as unknown[]) ??
      ["created"];
    // Retired tags: the `Tags Retired.md` line-list is authoritative when it
    // exists; otherwise fall back to the legacy inline `tags.retired` block.
    const retiredFromFile = await this.retiredSourceValues("Tags Retired");
    return {
      version: Number(data["base_schema_version"] ?? 1),
      fields,
      tags: {
        max_depth: Number(tags["max_depth"] ?? 2),
        retired: retiredFromFile ?? stringList(tags["retired"]),
      },
      date_name_suffixes: Array.isArray(dates["name_suffixes"])
        ? stringList(dates["name_suffixes"])
        : ["_date", "_deadline"],
      presence_only: stringList(presenceOnly),
    };
  }

  private parseCreationStamp(data: Record<string, unknown>): Record<string, string> {
    const raw = asRecord(data["creation_stamp"]);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" || typeof value === "number") {
        out[key] = String(value);
      }
    }
    return out;
  }

  private parseTitleSync(data: Record<string, unknown>): TitleSyncConfig | null {
    if (data["title_sync"] == null) return null;
    const raw = asRecord(data["title_sync"]);
    const remap: Record<string, string> = {};
    for (const [key, value] of Object.entries(asRecord(raw["remap"]))) {
      if (typeof value === "string") remap[key] = value;
    }
    return {
      strip: typeof raw["strip"] === "string" ? raw["strip"] : "",
      replacement: typeof raw["replacement"] === "string" ? raw["replacement"] : "",
      remap,
      ignore: stringList(raw["ignore"]),
      frontmatter_title:
        typeof raw["frontmatter_title"] === "string" ? raw["frontmatter_title"] : "",
      add_old_alias: Boolean(raw["add_old_alias"] ?? false),
    };
  }

  private async parseManifest(
    stem: string,
    data: Record<string, unknown>,
    path: string
  ): Promise<Manifest | null> {
    const name = typeof data["class"] === "string" && data["class"].trim() !== ""
      ? (data["class"] as string)
      : stem;
    const fields: Record<string, FieldSpec> = {};
    const rawFields = asRecord(data["fields"]);
    for (const [fname, spec] of Object.entries(rawFields)) {
      const parsed = await this.parseField(fname, asRecord(spec));
      if (parsed) fields[fname] = parsed;
      else this.loadErrors.push(`${path}: unknown type on field "${fname}"`);
    }
    if (this.manifests[name]) {
      this.loadErrors.push(`${path}: duplicate class "${name}"`);
      return null;
    }
    return {
      name,
      version: Number(data["manifest_version"] ?? 1),
      fields,
      lifecycle: this.parseLifecycle(data["lifecycle"]),
      body_template:
        typeof data["body_template"] === "string" && data["body_template"].trim() !== ""
          ? data["body_template"]
          : null,
      display: this.parseDisplay(data["display"]),
    };
  }

  private parseDisplay(raw: unknown): DisplaySection[] | null {
    if (!Array.isArray(raw)) return null;
    const sections: DisplaySection[] = [];
    for (const entry of raw) {
      const rec = asRecord(entry);
      if (typeof rec["section"] !== "string") continue;
      const fields = [];
      for (const f of Array.isArray(rec["fields"]) ? rec["fields"] : []) {
        if (typeof f === "string") {
          fields.push({ field: f });
        } else {
          const fr = asRecord(f);
          if (typeof fr["field"] !== "string") continue;
          fields.push({
            field: fr["field"],
            label: typeof fr["label"] === "string" ? fr["label"] : null,
            icon: typeof fr["icon"] === "string" ? fr["icon"] : null,
          });
        }
      }
      sections.push({
        section: rec["section"],
        icon: typeof rec["icon"] === "string" ? rec["icon"] : null,
        color: typeof rec["color"] === "string" ? rec["color"] : null,
        fields,
      });
    }
    return sections.length > 0 ? sections : null;
  }

  private parseLifecycle(raw: unknown): LifecycleRule[] {
    if (!Array.isArray(raw)) return [];
    const rules: LifecycleRule[] = [];
    for (const entry of raw) {
      const rec = asRecord(entry);
      const dateField = rec["date_field"];
      const suggest = rec["suggest"];
      if (typeof dateField !== "string" || typeof suggest !== "string") continue;
      rules.push({
        date_field: dateField,
        when_status: stringList(rec["when_status"]),
        suggest,
        age_days: rec["age_days"] == null ? null : Number(rec["age_days"]),
      });
    }
    return rules;
  }

  /** Parse one field spec, resolving `select:<Source>` / `multi:<Source>` values. */
  private async parseField(
    name: string,
    spec: Record<string, unknown>
  ): Promise<FieldSpec | null> {
    const rawType = String(spec["type"] ?? "text").trim();
    let baseType = rawType;
    let source: string | null = null;
    let values: string[] | null = null;

    const colon = rawType.indexOf(":");
    if (colon !== -1) {
      baseType = rawType.slice(0, colon).trim();
      source = rawType.slice(colon + 1).trim();
      values = await this.loadSourceValues(source);
    }
    if (!BASE_TYPES.includes(baseType as FieldType)) return null;

    if (Array.isArray(spec["values"])) {
      values = (spec["values"] as unknown[]).map((v) => String(v));
    }

    const rawWhen = asRecord(spec["required_when"]);
    const requiredWhen =
      typeof rawWhen["field"] === "string" && rawWhen["equals"] != null
        ? { field: rawWhen["field"] as string, equals: String(rawWhen["equals"]) }
        : null;

    return {
      name,
      type: baseType as FieldType,
      required: Boolean(spec["required"] ?? false),
      required_unless:
        spec["required_unless"] != null ? String(spec["required_unless"]) : null,
      required_when: requiredWhen,
      values,
      source,
      default: spec["default"],
    };
  }

  /** Read a line-per-value source note (every non-empty trimmed line is a value). */
  private async loadSourceValues(sourceName: string): Promise<string[]> {
    const values = await this.retiredSourceValues(sourceName);
    if (values === null) {
      const folder = this.sourcesFolder;
      const path = folder === "" ? `${sourceName}.md` : `${folder}/${sourceName}.md`;
      this.loadErrors.push(`Metadata source note missing: ${path}`);
      return [];
    }
    return values;
  }

  /** Line-list values for a source note, or null when the note doesn't exist (quiet). */
  private async retiredSourceValues(sourceName: string): Promise<string[] | null> {
    const folder = this.sourcesFolder;
    const path = folder === "" ? `${sourceName}.md` : `${folder}/${sourceName}.md`;
    const file = this.app.vault.getFileByPath(path);
    if (!file) return null;
    const raw = await this.app.vault.cachedRead(file);
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  private async loadClassLocations(): Promise<ClassLocation[]> {
    const file = this.findSchemaFile("class_locations");
    if (!file) return [];
    const data = await this.parseFile(file);
    if (data === null) return [];
    const out: ClassLocation[] = [];
    for (const entry of Array.isArray(data["locations"]) ? data["locations"] : []) {
      const rec = asRecord(entry);
      if (typeof rec["prefix"] === "string" && typeof rec["class"] === "string") {
        out.push({ prefix: rec["prefix"], class: rec["class"] });
      } else {
        this.loadErrors.push(`${file.path}: entry needs prefix + class`);
      }
    }
    return out;
  }

  private async loadExceptions(): Promise<ExceptionRule[]> {
    const file = this.findSchemaFile("exceptions");
    if (!file) return [];
    const data = await this.parseFile(file);
    if (data === null) return [];
    const out: ExceptionRule[] = [];
    for (const entry of Array.isArray(data["exceptions"]) ? data["exceptions"] : []) {
      const rec = asRecord(entry);
      const hasPath = typeof rec["path"] === "string";
      const hasPattern = typeof rec["pattern"] === "string";
      if (hasPath === hasPattern) {
        this.loadErrors.push(
          `${file.path}: entry needs exactly one of path/pattern`
        );
        continue;
      }
      out.push({
        path: hasPath ? (rec["path"] as string) : null,
        pattern: hasPattern ? (rec["pattern"] as string) : null,
        rules: Array.isArray(rec["rules"]) ? stringList(rec["rules"]) : null,
        reason: typeof rec["reason"] === "string" ? rec["reason"] : null,
      });
    }
    return out;
  }

  private async parseFile(file: TFile): Promise<Record<string, unknown> | null> {
    try {
      const raw = await this.app.vault.cachedRead(file);
      const parsed = parseYaml(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.loadErrors.push(`${file.path}: not a YAML mapping`);
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      this.loadErrors.push(`${file.path}: YAML parse error (${String(e)})`);
      return null;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}
