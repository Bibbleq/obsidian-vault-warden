import { Notice, Plugin, TAbstractFile, TFile, debounce } from "obsidian";
import { applySuppressions, validate } from "./engine/validate";
import { applyAllFixes, applyFixToFrontmatter } from "./engine/fixops";
import { analyzeTitle } from "./engine/titlesync";
import type { FieldSpec, ValidationInput, Violation } from "./engine/types";
import { isBodyEmpty, renderScaffold, setFirstH1, splitFrontmatter } from "./body";
import { SchemaLoader } from "./loader";
import {
  DatePromptModal,
  FileLinkSuggestModal,
  TextPromptModal,
  ValueSuggestModal,
} from "./modals";
import {
  DEFAULT_SETTINGS,
  VaultWardenSettings,
  VaultWardenSettingTab,
} from "./settings";
import { VIEW_TYPE_WARDEN, WardenView } from "./view";

/** Local date as YYYY-MM-DD (the engine's `today` injection). */
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Resolve {{today}} / {{now}} tokens in defaults and creation_stamp values. */
function resolveTokens(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "{{today}}") return localToday();
  if (value === "{{now}}") {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${localToday()}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  return value;
}

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
      id: "insert-class-scaffold",
      name: "Insert class scaffold",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const raw = fm?.["class"];
        const className = Array.isArray(raw) ? raw[0] : raw;
        if (typeof className !== "string" || className === "") {
          new Notice("Vault Warden: note has no class.");
          return;
        }
        await this.insertScaffold(file, className);
      },
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
        } else if (file instanceof TFile && file.extension === "md") {
          // The note was edited and then left before its save landed —
          // still run its automatic fixes.
          void this.autoFixInBackground(file);
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
    const data = (await this.loadData()) ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      autoFix: { ...DEFAULT_SETTINGS.autoFix, ...(data.autoFix ?? {}) },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async reloadSchemas(): Promise<void> {
    await this.loader.reload();
    await this.validateActiveFile();
  }

  /** Guards against auto-fix re-entrancy (fixes trigger change events). */
  private autoFixing = false;

  /** All violations (engine + title sync, suppression applied) for one file. */
  private computeViolations(file: TFile): Violation[] {
    const base = this.loader.base;
    if (!base) return [];

    const cache = this.app.metadataCache.getFileCache(file);
    let frontmatter: Record<string, unknown> | null = null;
    if (cache?.frontmatter) {
      frontmatter = { ...cache.frontmatter };
      delete (frontmatter as Record<string, unknown>)["position"];
    }

    const input: ValidationInput = {
      base,
      manifests: this.loader.manifests,
      class_locations: this.loader.classLocations,
      exceptions: this.loader.exceptions,
      file: { path: file.path, frontmatter },
      today: localToday(),
    };
    let all = validate(input);

    const titleConfig = this.loader.titleSync;
    if (titleConfig) {
      const h1 = cache?.headings?.find((h) => h.level === 1)?.heading ?? null;
      const titleViolations = analyzeTitle({
        path: file.path,
        basename: file.basename,
        h1,
        frontmatter,
        config: titleConfig,
      });
      all = all.concat(
        applySuppressions(frontmatter, file.path, this.loader.exceptions, titleViolations)
      );
    }
    return all;
  }

  private autoFixable(violations: Violation[]): Violation[] {
    return violations.filter(
      (v) => v.mechanical && !v.suppressed && v.suggested_fix && this.settings.autoFix[v.rule]
    );
  }

  /** Validate the active markdown file, auto-apply configured fixes, refresh UI. */
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
    const all = this.computeViolations(file);
    this.violations = all;
    this.updateBadge(all.filter((v) => !v.suppressed).length);
    this.refreshView();

    const auto = this.autoFixable(all);
    if (auto.length > 0 && !this.autoFixing) {
      this.autoFixing = true;
      try {
        await this.applyFixesFor(file, auto);
      } finally {
        this.autoFixing = false;
      }
    }
  }

  /**
   * Auto-fix pass for a file that is no longer active — Obsidian saves (and
   * fires metadataCache 'changed') shortly AFTER focus leaves a note, so the
   * just-edited note's automatic fixes must not depend on it being active.
   * UI state (pane/badge) is untouched; it tracks the active file only.
   */
  private async autoFixInBackground(file: TFile): Promise<void> {
    if (this.autoFixing || !this.loader.base) return;
    const auto = this.autoFixable(this.computeViolations(file));
    if (auto.length === 0) return;
    this.autoFixing = true;
    try {
      await this.applyFixesFor(file, auto);
    } finally {
      this.autoFixing = false;
    }
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

  /**
   * Apply the mechanical suggested_fix of the given violations: frontmatter
   * fixes in ONE processFrontMatter pass, then H1 body repairs, then a rename
   * last (it changes the path).
   */
  async applyFixes(violations: Violation[]): Promise<void> {
    if (this.validatedFile) await this.applyFixesFor(this.validatedFile, violations);
  }

  private async applyFixesFor(file: TFile, violations: Violation[]): Promise<void> {
    const eligible = violations.filter((v) => v.mechanical && !v.suppressed && v.suggested_fix);

    const frontmatterFixes = eligible.filter(
      (v) => v.suggested_fix!.op !== "set_h1" && v.suggested_fix!.op !== "rename_file"
    );
    const h1Fixes = eligible.filter((v) => v.suggested_fix!.op === "set_h1");
    const rename = eligible.find((v) => v.suggested_fix!.op === "rename_file");

    if (frontmatterFixes.length > 0) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        applyAllFixes(fm, frontmatterFixes);
      });
    }
    for (const fix of h1Fixes) {
      await this.applyH1(file, String(fix.suggested_fix!.value ?? ""));
    }
    if (rename) {
      await this.applyRename(file, String(rename.suggested_fix!.value ?? ""));
    }
    // Frontmatter/body writes re-validate via metadataCache 'changed'; a
    // rename doesn't, so re-validate explicitly (guarded, cheap no-op otherwise).
    if (rename) await this.validateActiveFile();
  }

  /** Repair or insert the note's first H1. */
  private async applyH1(file: TFile, title: string): Promise<void> {
    if (title.trim() === "") return;
    await this.app.vault.process(file, (data) => setFirstH1(data, title));
  }

  /** Rename the file to follow its H1, honouring the spec's hard guards. */
  private async applyRename(file: TFile, candidate: string): Promise<void> {
    const target = candidate.trim();
    if (target === "" || target === file.basename) return;
    // Never rename on a whitespace-only difference.
    if (target.replace(/\s+/g, "") === file.basename.replace(/\s+/g, "")) return;

    const parent = file.parent?.path ?? "";
    const newPath =
      (parent !== "" && parent !== "/" ? parent + "/" : "") + target + "." + file.extension;
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice(`Vault Warden: "${newPath}" already exists — not renaming.`);
      return;
    }

    const oldName = file.basename;
    await this.app.fileManager.renameFile(file, newPath);
    if (this.loader.titleSync?.add_old_alias) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const raw = fm["aliases"];
        const aliases = Array.isArray(raw)
          ? raw
          : typeof raw === "string" && raw !== ""
            ? [raw]
            : [];
        if (!aliases.includes(oldName)) {
          aliases.push(oldName);
          fm["aliases"] = aliases;
        }
      });
    }
  }

  /** Manual override: prompt for a value (schema-fed picker where possible), then set it. */
  openManualFix(violationToFix: Violation): void {
    const file = this.validatedFile;
    const field = violationToFix.field;
    if (!file || !field) return;

    // Title-sync violations edit the H1 or the filename, not frontmatter.
    const op = violationToFix.suggested_fix?.op;
    if (op === "set_h1" || op === "rename_file") {
      const initial =
        violationToFix.expected ?? String(violationToFix.suggested_fix?.value ?? "");
      new TextPromptModal(
        this.app,
        op === "set_h1" ? "Set H1" : "Rename file to",
        initial,
        (value) =>
          void (op === "set_h1" ? this.applyH1(file, value) : this.applyRename(file, value))
      ).open();
      return;
    }

    const apply = (value: string) => void this.applyManualValue(violationToFix, value);
    const allowed = this.allowedValuesFor(file, field);
    if (allowed && allowed.length > 0) {
      new ValueSuggestModal(this.app, allowed, `Value for ${field}…`, apply).open();
      return;
    }

    // Date-typed fields get a picker defaulting to now (e.g. CREATED-MISSING).
    const spec = this.fieldSpecFor(file, field);
    const isDateField =
      violationToFix.rule === "CREATED-MISSING" ||
      violationToFix.rule === "DATE-FORMAT" ||
      spec?.type === "date" ||
      spec?.type === "datetime";
    if (isDateField) {
      // Prefill from a parseable offending value; otherwise now.
      const found = (violationToFix.found ?? "").trim();
      let initial: string | null = null;
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(found)) {
        initial = found.slice(0, 16).replace(" ", "T");
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(found)) {
        initial = `${found}T00:00`;
      }
      new DatePromptModal(this.app, `Set ${field}`, initial, apply).open();
      return;
    }

    new TextPromptModal(this.app, `Set ${field}`, violationToFix.found ?? "", apply).open();
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

  // --- schema editing (settings GUI) ---------------------------------------

  /**
   * Apply a comment-preserving text transform to a schema file and reload
   * immediately (so the settings GUI re-renders against fresh state).
   */
  async editSchemaFile(filePath: string, transform: (text: string) => string): Promise<boolean> {
    const file = this.app.vault.getFileByPath(filePath);
    if (!file) {
      new Notice(`Vault Warden: schema file not found: ${filePath}`);
      return false;
    }
    await this.app.vault.process(file, transform);
    await this.reloadSchemas();
    return true;
  }

  /** Create a schema-folder file (class_locations/exceptions/new class) if absent. */
  async createSchemaFile(fileName: string, content: string): Promise<string | null> {
    const folder = this.loader.schemasFolder;
    const path = folder === "" ? fileName : `${folder}/${fileName}`;
    if (this.app.vault.getAbstractFileByPath(path)) return path;
    try {
      await this.app.vault.create(path, content);
    } catch (e) {
      new Notice(`Vault Warden: could not create ${path}: ${String(e)}`);
      return null;
    }
    await this.reloadSchemas();
    return path;
  }

  // --- field editor (properties section of the pane) -----------------------

  /** Set one frontmatter field (scalar). */
  async setField(file: TFile, field: string, value: unknown): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[field] = value;
    });
  }

  /** Append a value to a list field (creates/normalises the list). */
  async addToListField(file: TFile, field: string, value: unknown): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const current = fm[field];
      const list = Array.isArray(current)
        ? current.slice()
        : current == null || current === ""
          ? []
          : [current];
      if (!list.some((item) => item === value)) list.push(value);
      fm[field] = list;
    });
  }

  /** Remove a value from a list field. */
  async removeFromListField(file: TFile, field: string, value: unknown): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const current = fm[field];
      if (Array.isArray(current)) {
        fm[field] = current.filter((item) => item !== value);
      } else if (current === value) {
        delete fm[field];
      }
    });
  }

  /** Open the right editor widget for a field and write the chosen value. */
  editField(file: TFile, field: string, spec: FieldSpec | null): void {
    const isList = spec?.type === "multi" || spec?.type === "list";
    const write = (value: unknown) =>
      void (isList ? this.addToListField(file, field, value) : this.setField(file, field, value));

    if (spec?.values && spec.values.length > 0) {
      new ValueSuggestModal(this.app, spec.values, `Value for ${field}…`, write).open();
      return;
    }
    if (spec?.type === "date" || spec?.type === "datetime") {
      new DatePromptModal(this.app, `Set ${field}`, null, write).open();
      return;
    }
    if (spec?.type === "wikilink") {
      new FileLinkSuggestModal(this.app, (linkText) => write(linkText)).open();
      return;
    }
    new TextPromptModal(this.app, `Set ${field}`, "", (raw) => {
      const value =
        spec?.type === "number" && raw.trim() !== "" && !isNaN(Number(raw)) ? Number(raw) : raw;
      write(value);
    }).open();
  }

  /** Pick a class from the loaded manifests and stamp it. */
  pickClass(file: TFile): void {
    const names = Object.keys(this.loader.manifests).sort();
    if (names.length === 0) return;
    new ValueSuggestModal(this.app, names, "Class…", (name) =>
      void this.setField(file, "class", name)
    ).open();
  }

  /** Insert every missing manifest field that declares a default. */
  async applyClassDefaults(file: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const classValue = fm?.["class"];
    const className = Array.isArray(classValue) ? classValue[0] : classValue;
    if (typeof className !== "string") return;
    const manifest = this.loader.manifests[className];
    if (!manifest) return;
    await this.app.fileManager.processFrontMatter(file, (out) => {
      for (const [name, spec] of Object.entries(manifest.fields ?? {})) {
        if (spec.default === undefined) continue;
        const current = out[name];
        const missing =
          current == null ||
          current === "" ||
          (typeof current === "string" && current.trim() === "") ||
          (Array.isArray(current) && current.length === 0);
        if (missing) out[name] = resolveTokens(spec.default);
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

    // Let other plugins finish writing first; skip if a class appeared meanwhile.
    window.setTimeout(() => void this.setupNewNote(file, stampClass), 800);
  }

  /** Full new-note setup: class + creation_stamp + field defaults + body scaffold. */
  private async setupNewNote(file: TFile, className: string): Promise<void> {
    const current = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (current && current["class"] != null && current["class"] !== "") return;

    const manifest = this.loader.manifests[className];
    const stamp = this.loader.creationStamp;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (fm["class"] != null && fm["class"] !== "") return;
      fm["class"] = className;
      for (const [key, value] of Object.entries(stamp)) {
        if (fm[key] == null || fm[key] === "") fm[key] = resolveTokens(value);
      }
      for (const [name, spec] of Object.entries(manifest?.fields ?? {})) {
        if (spec.default === undefined) continue;
        const cur = fm[name];
        if (cur == null || cur === "" || (Array.isArray(cur) && cur.length === 0)) {
          fm[name] = resolveTokens(spec.default);
        }
      }
    });
    await this.insertScaffold(file, className, true);
  }

  /**
   * Write the class's body scaffold into the note. Only ever writes into an
   * empty body — pasted/imported content is never clobbered. Returns whether
   * anything was inserted.
   */
  async insertScaffold(file: TFile, className: string, silent = false): Promise<boolean> {
    const templatePath = this.loader.manifests[className]?.body_template;
    if (!templatePath) {
      if (!silent) new Notice(`Vault Warden: class ${className} has no body_template.`);
      return false;
    }
    const templateFile = this.app.vault.getFileByPath(templatePath);
    if (!templateFile) {
      if (!silent) new Notice(`Vault Warden: template not found: ${templatePath}`);
      return false;
    }
    const raw = await this.app.vault.cachedRead(templateFile);
    const scaffold = renderScaffold(raw, file.basename, localToday());
    if (scaffold.trim() === "") return false;

    let inserted = false;
    await this.app.vault.process(file, (data) => {
      if (!isBodyEmpty(data)) return data;
      inserted = true;
      const { frontmatter } = splitFrontmatter(data);
      return frontmatter + (frontmatter !== "" ? "\n" : "") + scaffold;
    });
    if (!inserted && !silent) {
      new Notice("Vault Warden: note body is not empty — scaffold not inserted.");
    }
    return inserted;
  }
}
