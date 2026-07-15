import { App, Modal, Notice, Setting, debounce } from "obsidian";
import type { DisplayField, DisplaySection, FieldSpec } from "./engine/types";
import type VaultWardenPlugin from "./main";
import { TextPromptModal } from "./modals";
import { appendToSeq, deletePath, removeFromSeq, renameKey, setPath } from "./schemawrite";

/** The raw manifest type string for a post-load spec ("select:Areas" etc.). */
function rawType(spec: FieldSpec): string {
  return spec.source ? `${spec.type}:${spec.source}` : spec.type;
}

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** A debounced text input that writes without re-rendering (keeps focus). */
function debouncedText(
  setting: Setting,
  value: string,
  placeholder: string,
  onWrite: (value: string) => void
): void {
  setting.addText((text) => {
    text.setPlaceholder(placeholder).setValue(value);
    const write = debounce((v: string) => onWrite(v), 1200, true);
    text.onChange(write);
  });
}

/** Chip list with an inline add box. Add/remove refresh the section. */
function chips(
  container: HTMLElement,
  name: string,
  desc: string,
  values: string[],
  onAdd: (value: string) => void,
  onRemove: (value: string) => void
): void {
  const setting = new Setting(container).setName(name).setDesc(desc);
  const wrap = setting.controlEl.createEl("div", { cls: "vault-warden-chips" });
  for (const value of values) {
    const chip = wrap.createEl("span", { cls: "vault-warden-chip" });
    chip.createEl("span", { text: value });
    const x = chip.createEl("span", { text: "×", cls: "vault-warden-chip-x" });
    x.addEventListener("click", () => onRemove(value));
  }
  const input = wrap.createEl("input", { type: "text", attr: { placeholder: "Add…" } });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim() !== "") {
      e.preventDefault();
      onAdd(input.value.trim());
    }
  });
}

/** Manual/Automatic dropdown for one fix-capable rule, inline with its config. */
function fixModeDropdown(
  container: HTMLElement,
  plugin: VaultWardenPlugin,
  ruleId: string,
  desc: string
): void {
  new Setting(container)
    .setName(ruleId)
    .setDesc(desc)
    .setClass("vault-warden-fix-row")
    .addDropdown((dd) =>
      dd
        .addOption("manual", "Manual")
        .addOption("auto", "Automatic")
        .setValue(plugin.settings.autoFix[ruleId] ? "auto" : "manual")
        .onChange(async (value) => {
          plugin.settings.autoFix[ruleId] = value === "auto";
          await plugin.saveSettings();
          await plugin.validateActiveFile();
        })
    );
}

function sectionCard(container: HTMLElement, title: string): HTMLElement {
  const card = container.createDiv({ cls: "vault-warden-card" });
  card.createEl("div", { text: title, cls: "vault-warden-card-title" });
  return card;
}

// --------------------------------------------------------------------------
// Rules tab: tags, dates, base fields — detection config + fix mode together.
// --------------------------------------------------------------------------

export function renderRulesTab(
  container: HTMLElement,
  plugin: VaultWardenPlugin,
  refresh: () => void
): void {
  const loader = plugin.loader;
  const basePath = loader.baseFilePath;
  const base = loader.base;
  if (!basePath || !base) {
    container.createEl("p", { text: "No schema loaded — nothing to edit yet." });
    return;
  }
  const editBase = (t: (s: string) => string) => plugin.editSchemaFile(basePath, t);

  const tags = sectionCard(container, "Tags");
  debouncedText(
    new Setting(tags).setName("Max depth").setDesc("Maximum / levels per tag."),
    String(base.tags.max_depth),
    "2",
    (v) => {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) void editBase((s) => setPath(s, ["tags", "max_depth"], n));
    }
  );
  chips(
    tags,
    "Retired tags",
    "Removed on sight (case-insensitive).",
    base.tags.retired,
    async (tag) => {
      await editBase((s) => appendToSeq(s, ["tags", "retired"], tag));
      refresh();
    },
    async (tag) => {
      await editBase((s) => removeFromSeq(s, ["tags", "retired"], tag));
      refresh();
    }
  );
  fixModeDropdown(tags, plugin, "TAG-FORMAT", "Split comma-joined tags; re-case malformed tags");
  fixModeDropdown(tags, plugin, "TAG-CASE", "Re-case miscased tags (PascalCase)");
  fixModeDropdown(tags, plugin, "TAG-RETIRED", "Remove retired tags");
  fixModeDropdown(tags, plugin, "TAG-DUPLICATE", "De-duplicate the tags list");

  const dates = sectionCard(container, "Dates");
  chips(
    dates,
    "Date-named suffixes",
    "ISO checking applies to any field ending with these, classed or not.",
    base.date_name_suffixes,
    async (v) => {
      await editBase((s) => appendToSeq(s, ["dates", "name_suffixes"], v));
      refresh();
    },
    async (v) => {
      await editBase((s) => removeFromSeq(s, ["dates", "name_suffixes"], v));
      refresh();
    }
  );
  chips(
    dates,
    "Presence-only fields",
    "Never format-checked (e.g. created).",
    base.presence_only,
    async (v) => {
      await editBase((s) => appendToSeq(s, ["dates", "presence_only"], v));
      refresh();
    },
    async (v) => {
      await editBase((s) => removeFromSeq(s, ["dates", "presence_only"], v));
      refresh();
    }
  );
  fixModeDropdown(dates, plugin, "DATE-FORMAT", "Convert space-separated datetimes to ISO (T) form");
  fixModeDropdown(
    dates,
    plugin,
    "CREATED-MISSING",
    "Stamp created from the file's creation timestamp"
  );

  const fields = sectionCard(container, "Base fields");
  fields.createEl("p", {
    cls: "vault-warden-rules-note",
    text: "Checked on every note. Type examples: select:Areas, multi:Note Types.",
  });
  for (const name of ["area", "notetype", "origin"]) {
    const spec = base.fields[name];
    const row = new Setting(fields).setName(name);
    if (!spec) {
      row.setDesc("Not configured — its FM-* rules are inactive.").addButton((btn) =>
        btn.setButtonText("Add").onClick(async () => {
          await editBase((s) => setPath(s, ["fields", name], { type: "text", required: true }));
          refresh();
        })
      );
      continue;
    }
    row.setDesc("Type · optional-when field · remove");
    debouncedText(row, rawType(spec), "type", (v) => {
      if (v.trim() !== "") void editBase((s) => setPath(s, ["fields", name, "type"], v.trim()));
    });
    debouncedText(row, spec.required_unless ?? "", "required_unless", (v) => {
      void editBase((s) =>
        v.trim() === ""
          ? deletePath(s, ["fields", name, "required_unless"])
          : setPath(s, ["fields", name, "required_unless"], v.trim())
      );
    });
    row.addExtraButton((btn) =>
      btn.setIcon("trash").setTooltip("Remove field").onClick(async () => {
        await editBase((s) => deletePath(s, ["fields", name]));
        refresh();
      })
    );
  }
  fixModeDropdown(fields, plugin, "FM-AREA-MISSING", "Derive the area from the note's folder path");
  fixModeDropdown(fields, plugin, "NOTETYPE-CASE", "Fix a notetype's casing to the canonical value");
}

// --------------------------------------------------------------------------
// Classes tab: class editors, folder map, creation stamp.
// --------------------------------------------------------------------------

export function renderClassesTab(
  container: HTMLElement,
  plugin: VaultWardenPlugin,
  refresh: () => void
): void {
  const loader = plugin.loader;
  const basePath = loader.baseFilePath;
  if (!basePath || !loader.base) {
    container.createEl("p", { text: "No schema loaded — nothing to edit yet." });
    return;
  }
  const editBase = (t: (s: string) => string) => plugin.editSchemaFile(basePath, t);

  const classes = sectionCard(container, "Classes");
  for (const name of Object.keys(loader.manifests).sort()) {
    const manifest = loader.manifests[name];
    const count = Object.keys(manifest.fields ?? {}).length;
    new Setting(classes)
      .setName(name)
      .setDesc(
        `${count} field${count === 1 ? "" : "s"}` +
          (manifest.body_template ? ` · scaffold: ${manifest.body_template}` : "")
      )
      .addButton((btn) =>
        btn.setButtonText("Edit").onClick(() => {
          new ClassEditorModal(plugin.app, plugin, name, refresh).open();
        })
      );
  }
  new Setting(classes).addButton((btn) =>
    btn.setButtonText("New class").onClick(() => {
      new TextPromptModal(plugin.app, "Class name (PascalCase)", "", async (raw) => {
        const name = raw.trim();
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
          new Notice("Class names are alphanumeric, starting with a letter.");
          return;
        }
        if (plugin.loader.manifests[name]) {
          new Notice(`Class ${name} already exists.`);
          return;
        }
        await plugin.createSchemaFile(
          `${name}.yaml`,
          `manifest_version: 1\nclass: ${name}\nfields: {}\n`
        );
        refresh();
      }).open();
    })
  );
  fixModeDropdown(classes, plugin, "STATUS-STALE", "Advance status when a lifecycle date has passed");

  const map = sectionCard(container, "Folder → class map");
  renderLocations(map, plugin, refresh);
  fixModeDropdown(map, plugin, "CLASS-EXPECTED", "Stamp the class mapped to the note's folder");

  const stamp = sectionCard(container, "Creation stamp");
  stamp.createEl("p", {
    cls: "vault-warden-rules-note",
    text: "Extra frontmatter stamped on new notes in mapped folders. Values may use {{today}} / {{now}}.",
  });
  for (const [key, value] of Object.entries(loader.creationStamp)) {
    const row = new Setting(stamp).setName(key);
    debouncedText(row, value, "value", (v) => {
      void editBase((s) => setPath(s, ["creation_stamp", key], v));
    });
    row.addExtraButton((btn) =>
      btn.setIcon("trash").onClick(async () => {
        await editBase((s) => deletePath(s, ["creation_stamp", key]));
        refresh();
      })
    );
  }
  new Setting(stamp).addButton((btn) =>
    btn.setButtonText("Add stamp key").onClick(() => {
      new TextPromptModal(plugin.app, "Frontmatter key", "", (key) => {
        if (key.trim() === "") return;
        void editBase((s) => setPath(s, ["creation_stamp", key.trim()], "value")).then(refresh);
      }).open();
    })
  );
}

function renderLocations(container: HTMLElement, plugin: VaultWardenPlugin, refresh: () => void): void {
  const loader = plugin.loader;
  const path = loader.classLocationsPath;
  if (!path) {
    new Setting(container)
      .setDesc("No class_locations file yet.")
      .addButton((btn) =>
        btn.setButtonText("Create it").onClick(async () => {
          await plugin.createSchemaFile("class_locations.yaml", "locations: []\n");
          refresh();
        })
      );
    return;
  }
  const edit = (t: (s: string) => string) => plugin.editSchemaFile(path, t);
  const classNames = Object.keys(loader.manifests).sort();

  loader.classLocations.forEach((loc, i) => {
    const row = new Setting(container).setName(loc.class);
    debouncedText(row, loc.prefix, "Folder/prefix/", (v) => {
      if (v.trim() !== "") void edit((s) => setPath(s, ["locations", i, "prefix"], v));
    });
    row.addDropdown((dd) => {
      for (const name of classNames) dd.addOption(name, name);
      if (!classNames.includes(loc.class)) dd.addOption(loc.class, `${loc.class} (no manifest)`);
      dd.setValue(loc.class).onChange((v) => {
        void edit((s) => setPath(s, ["locations", i, "class"], v));
      });
    });
    row.addExtraButton((btn) =>
      btn.setIcon("trash").onClick(async () => {
        await edit((s) => deletePath(s, ["locations", i]));
        refresh();
      })
    );
  });
  new Setting(container).addButton((btn) =>
    btn.setButtonText("Add mapping").onClick(async () => {
      await edit((s) =>
        appendToSeq(s, ["locations"], { prefix: "Folder/", class: classNames[0] ?? "Class" })
      );
      refresh();
    })
  );
}

// --------------------------------------------------------------------------
// Title sync tab.
// --------------------------------------------------------------------------

export function renderTitleSyncTab(
  container: HTMLElement,
  plugin: VaultWardenPlugin,
  refresh: () => void
): void {
  const loader = plugin.loader;
  const basePath = loader.baseFilePath;
  if (!basePath || !loader.base) {
    container.createEl("p", { text: "No schema loaded — nothing to edit yet." });
    return;
  }
  const editBase = (t: (s: string) => string) => plugin.editSchemaFile(basePath, t);
  const ts = loader.titleSync;

  const card = sectionCard(container, "Filename ↔ H1 sync");
  if (!ts) {
    new Setting(card)
      .setDesc("Off (no title_sync block in the vault schema).")
      .addButton((btn) =>
        btn.setButtonText("Enable title sync").onClick(async () => {
          await editBase((s) =>
            setPath(s, ["title_sync"], {
              strip: '\\/:*?"<>|#^[]',
              replacement: "",
              ignore: ["(^|/)[_.]"],
              frontmatter_title: "",
              add_old_alias: true,
            })
          );
          refresh();
        })
      );
    return;
  }

  debouncedText(
    new Setting(card).setName("Strip characters").setDesc("Removed when projecting H1 → filename."),
    ts.strip,
    "",
    (v) => void editBase((s) => setPath(s, ["title_sync", "strip"], v))
  );
  debouncedText(
    new Setting(card).setName("Replacement").setDesc("What each stripped character becomes."),
    ts.replacement,
    "",
    (v) => void editBase((s) => setPath(s, ["title_sync", "replacement"], v))
  );
  debouncedText(
    new Setting(card)
      .setName("Frontmatter title property")
      .setDesc("Third sync leg; empty = disabled."),
    ts.frontmatter_title,
    "",
    (v) => void editBase((s) => setPath(s, ["title_sync", "frontmatter_title"], v.trim()))
  );
  new Setting(card)
    .setName("Add old filename as alias")
    .addToggle((toggle) =>
      toggle.setValue(ts.add_old_alias).onChange((v) => {
        void editBase((s) => setPath(s, ["title_sync", "add_old_alias"], v));
      })
    );
  chips(
    card,
    "Ignore patterns",
    "Regexes; any match on the path exempts the note.",
    ts.ignore,
    async (v) => {
      await editBase((s) => appendToSeq(s, ["title_sync", "ignore"], v));
      refresh();
    },
    async (v) => {
      await editBase((s) => removeFromSeq(s, ["title_sync", "ignore"], v));
      refresh();
    }
  );

  const remap = card.createEl("details", { cls: "vault-warden-collapse" });
  remap.createEl("summary", { text: `Remappings (${Object.keys(ts.remap).length})` });
  for (const [from, to] of Object.entries(ts.remap)) {
    const row = new Setting(remap).setName(`${from} →`);
    debouncedText(row, to, "replacement", (v) => {
      void editBase((s) => setPath(s, ["title_sync", "remap", from], v));
    });
    row.addExtraButton((btn) =>
      btn.setIcon("trash").onClick(async () => {
        await editBase((s) => deletePath(s, ["title_sync", "remap", from]));
        refresh();
      })
    );
  }
  new Setting(remap).addButton((btn) =>
    btn.setButtonText("Add remapping").onClick(() => {
      new TextPromptModal(plugin.app, "Character(s) to remap", "", (from) => {
        if (from === "") return;
        void editBase((s) => setPath(s, ["title_sync", "remap", from], "")).then(refresh);
      }).open();
    })
  );

  const fixes = sectionCard(container, "Fix application");
  fixModeDropdown(fixes, plugin, "H1-MISSING", "Insert an H1 from the filename");
  fixModeDropdown(fixes, plugin, "H1-WHITESPACE", "Trim cosmetic whitespace in the H1");
  fixModeDropdown(fixes, plugin, "H1-DEGENERATE", "Restore an empty/punctuation-only H1 from the filename");
  fixModeDropdown(fixes, plugin, "FILENAME-SYNC", "Rename the file to follow the H1 (backlinks update)");
  fixModeDropdown(fixes, plugin, "TITLE-PROPERTY", "Keep the configured title property equal to the H1");
}

// --------------------------------------------------------------------------
// Exceptions tab.
// --------------------------------------------------------------------------

export function renderExceptionsTab(
  container: HTMLElement,
  plugin: VaultWardenPlugin,
  refresh: () => void
): void {
  const loader = plugin.loader;
  if (!loader.base) {
    container.createEl("p", { text: "No schema loaded — nothing to edit yet." });
    return;
  }
  const card = sectionCard(container, "Exceptions");
  card.createEl("p", {
    cls: "vault-warden-rules-note",
    text:
      "Notes deliberately outside the rules. With rule IDs listed, matching notes get those " +
      "violations suppressed-but-reported; with none, the note is fully skipped.",
  });
  const path = loader.exceptionsPath;
  if (!path) {
    new Setting(card)
      .setDesc("No exceptions file yet.")
      .addButton((btn) =>
        btn.setButtonText("Create it").onClick(async () => {
          await plugin.createSchemaFile("exceptions.yaml", "exceptions: []\n");
          refresh();
        })
      );
    return;
  }
  const edit = (t: (s: string) => string) => plugin.editSchemaFile(path, t);

  loader.exceptions.forEach((entry, i) => {
    const isPattern = entry.pattern != null;
    const row = new Setting(card)
      .setName(isPattern ? "pattern" : "path")
      .setDesc(entry.reason ?? "");
    debouncedText(row, entry.path ?? entry.pattern ?? "", "vault path or glob", (v) => {
      if (v.trim() !== "") {
        void edit((s) => setPath(s, ["exceptions", i, isPattern ? "pattern" : "path"], v));
      }
    });
    debouncedText(row, (entry.rules ?? []).join(", "), "rules (empty = full skip)", (v) => {
      const rules = splitCsv(v);
      void edit((s) =>
        rules.length === 0
          ? deletePath(s, ["exceptions", i, "rules"])
          : setPath(s, ["exceptions", i, "rules"], rules)
      );
    });
    row.addExtraButton((btn) =>
      btn.setIcon("trash").onClick(async () => {
        await edit((s) => deletePath(s, ["exceptions", i]));
        refresh();
      })
    );
  });
  new Setting(card)
    .addButton((btn) =>
      btn.setButtonText("Add path exception").onClick(async () => {
        await edit((s) => appendToSeq(s, ["exceptions"], { path: "Note.md", reason: "why" }));
        refresh();
      })
    )
    .addButton((btn) =>
      btn.setButtonText("Add pattern exception").onClick(async () => {
        await edit((s) => appendToSeq(s, ["exceptions"], { pattern: "*.excalidraw.md", reason: "why" }));
        refresh();
      })
    );
}

// --------------------------------------------------------------------------
// Active-rules summary (Overview tab, read-only).
// --------------------------------------------------------------------------

export function renderActiveRules(el: HTMLElement, plugin: VaultWardenPlugin): void {
  const loader = plugin.loader;
  const base = loader.base;
  if (!base) return;

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
      (base.presence_only.length > 0 ? `; exempt: ${base.presence_only.join(", ")}` : "")
  );
  rule("CREATED-MISSING", true, "created must be present on every note");

  const classCount = Object.keys(loader.manifests).length;
  category("Classes");
  rule(
    "CLASS-UNKNOWN · CLASS-FIELD-MISSING · CLASS-FIELD-TYPE · CLASS-FIELD-VALUE",
    classCount > 0,
    classCount > 0 ? `${classCount} class manifest(s)` : "no class manifests loaded"
  );
  rule(
    "STATUS-STALE",
    Object.values(loader.manifests).some((m) => (m.lifecycle ?? []).length > 0),
    "lifecycle-driven status suggestions"
  );

  category("Folder locations");
  rule(
    "CLASS-EXPECTED · CLASS-MISFILED",
    loader.classLocations.length > 0,
    loader.classLocations.length > 0
      ? `${loader.classLocations.length} mapped folder prefix(es)`
      : "no class_locations file"
  );

  category("Title sync");
  rule(
    "H1-MISSING · H1-WHITESPACE · H1-DEGENERATE · FILENAME-SYNC",
    loader.titleSync !== null,
    loader.titleSync !== null ? "filename follows H1; cosmetic H1 defects repaired" : "no title_sync block"
  );
}

// --------------------------------------------------------------------------
// Per-class manifest editor modal.
// --------------------------------------------------------------------------

/** Per-class manifest editor: fields, lifecycle, body template. */
export class ClassEditorModal extends Modal {
  private plugin: VaultWardenPlugin;
  private className: string;
  private onDone: () => void;

  constructor(app: App, plugin: VaultWardenPlugin, className: string, onDone: () => void) {
    super(app);
    this.plugin = plugin;
    this.className = className;
    this.onDone = onDone;
  }

  onOpen(): void {
    this.modalEl.addClass("vault-warden-class-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDone();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const manifest = this.plugin.loader.manifests[this.className];
    const path = this.plugin.loader.manifestPaths[this.className];
    this.titleEl.setText(`Class: ${this.className}`);
    if (!manifest || !path) {
      contentEl.createEl("p", { text: "Manifest not loaded." });
      return;
    }
    const edit = async (t: (s: string) => string) => {
      await this.plugin.editSchemaFile(path, t);
    };
    const rerender = () => this.render();

    debouncedText(
      new Setting(contentEl)
        .setName("Body template")
        .setDesc("Markdown file whose body scaffolds new notes; empty = none."),
      manifest.body_template ?? "",
      "_vault/Templates/….md",
      (v) =>
        void edit((s) =>
          v.trim() === "" ? deletePath(s, ["body_template"]) : setPath(s, ["body_template"], v.trim())
        )
    );

    new Setting(contentEl).setName("Fields").setHeading();
    for (const [name, spec] of Object.entries(manifest.fields ?? {})) {
      const row = new Setting(contentEl).setName(name).setDesc(rawType(spec));
      debouncedText(row, rawType(spec), "type", (v) => {
        if (v.trim() !== "") void edit((s) => setPath(s, ["fields", name, "type"], v.trim()));
      });
      if (!spec.source) {
        debouncedText(row, (spec.values ?? []).join(", "), "values (comma)", (v) => {
          const values = splitCsv(v);
          void edit((s) =>
            values.length === 0
              ? deletePath(s, ["fields", name, "values"])
              : setPath(s, ["fields", name, "values"], values)
          );
        });
      }
      debouncedText(row, spec.default !== undefined ? String(spec.default) : "", "default", (v) => {
        void edit((s) =>
          v.trim() === ""
            ? deletePath(s, ["fields", name, "default"])
            : setPath(s, ["fields", name, "default"], v)
        );
      });
      debouncedText(
        row,
        spec.required_when ? `${spec.required_when.field}=${spec.required_when.equals}` : "",
        "required when (field=value)",
        (v) => {
          const raw = v.trim();
          if (raw === "") {
            void edit((s) => deletePath(s, ["fields", name, "required_when"]));
            return;
          }
          const eq = raw.indexOf("=");
          if (eq <= 0 || eq === raw.length - 1) return; // incomplete — wait for valid input
          const condField = raw.slice(0, eq).trim();
          const equals = raw.slice(eq + 1).trim();
          void edit((s) =>
            setPath(s, ["fields", name, "required_when"], { field: condField, equals })
          );
        }
      );
      row.addToggle((toggle) =>
        toggle
          .setValue(Boolean(spec.required))
          .setTooltip("Required")
          .onChange((v) => {
            void edit((s) =>
              v ? setPath(s, ["fields", name, "required"], true) : deletePath(s, ["fields", name, "required"])
            );
          })
      );
      row.addExtraButton((btn) =>
        btn.setIcon("pencil").setTooltip("Rename field").onClick(() => {
          new TextPromptModal(this.app, `Rename ${name} to`, name, async (next) => {
            const newName = next.trim();
            if (newName === "" || newName === name) return;
            await edit((s) => renameKey(s, ["fields"], name, newName));
            rerender();
          }).open();
        })
      );
      row.addExtraButton((btn) =>
        btn.setIcon("trash").setTooltip("Delete field").onClick(async () => {
          await edit((s) => deletePath(s, ["fields", name]));
          rerender();
        })
      );
    }
    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Add field").onClick(() => {
        new TextPromptModal(this.app, "Field name", "", async (raw) => {
          const name = raw.trim();
          if (name === "" || manifest.fields?.[name]) return;
          await edit((s) => setPath(s, ["fields", name], { type: "text" }));
          rerender();
        }).open();
      })
    );

    this.renderDisplayEditor(contentEl, edit, rerender);

    new Setting(contentEl).setName("Lifecycle (STATUS-STALE)").setHeading();
    (manifest.lifecycle ?? []).forEach((rule, i) => {
      const row = new Setting(contentEl).setName(`${rule.date_field || "?"} → ${rule.suggest || "?"}`);
      debouncedText(row, rule.date_field, "date field", (v) => {
        if (v.trim() !== "") void edit((s) => setPath(s, ["lifecycle", i, "date_field"], v.trim()));
      });
      debouncedText(row, rule.when_status.join(", "), "when status (comma)", (v) => {
        void edit((s) => setPath(s, ["lifecycle", i, "when_status"], splitCsv(v)));
      });
      debouncedText(row, rule.suggest, "suggest", (v) => {
        if (v.trim() !== "") void edit((s) => setPath(s, ["lifecycle", i, "suggest"], v.trim()));
      });
      debouncedText(row, rule.age_days != null ? String(rule.age_days) : "", "age days", (v) => {
        const n = Number(v);
        void edit((s) =>
          v.trim() === "" || isNaN(n)
            ? deletePath(s, ["lifecycle", i, "age_days"])
            : setPath(s, ["lifecycle", i, "age_days"], n)
        );
      });
      row.addExtraButton((btn) =>
        btn.setIcon("trash").onClick(async () => {
          await edit((s) => deletePath(s, ["lifecycle", i]));
          rerender();
        })
      );
    });
    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Add lifecycle rule").onClick(async () => {
        await edit((s) =>
          appendToSeq(s, ["lifecycle"], { date_field: "", when_status: [], suggest: "" })
        );
        rerender();
      })
    );
  }

  /**
   * Editor for the plugin-only `display:` block. Since it is GUI-managed (no
   * meaningful hand-comments inside it), edits mutate an in-memory copy and
   * write the whole array back with setPath — which touches only the `display`
   * node, leaving every other comment in the manifest intact. Reordering is an
   * array swap; no reorder primitive needed in the write layer.
   */
  private renderDisplayEditor(
    contentEl: HTMLElement,
    edit: (t: (s: string) => string) => Promise<void>,
    rerender: () => void
  ): void {
    const PALETTE = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];
    const manifest = this.plugin.loader.manifests[this.className];
    // Deep working copy so text edits accumulate before each whole-array write.
    const display: DisplaySection[] = JSON.parse(JSON.stringify(manifest?.display ?? []));

    const clean = (sections: DisplaySection[]): unknown =>
      sections.map((s) => {
        const out: Record<string, unknown> = { section: s.section };
        if (s.icon) out.icon = s.icon;
        if (s.color) out.color = s.color;
        out.fields = (s.fields ?? []).map((f) => {
          const fo: Record<string, unknown> = { field: f.field };
          if (f.label) fo.label = f.label;
          if (f.icon) fo.icon = f.icon;
          return fo;
        });
        return out;
      });
    const write = () => edit((s) => setPath(s, ["display"], clean(display)));
    const writeAnd = async (fn: () => void) => {
      fn();
      await write();
      rerender();
    };

    new Setting(contentEl).setName("Display layout (pane)").setHeading();
    if (display.length === 0) {
      new Setting(contentEl)
        .setDesc("No layout — the pane shows a flat field list. Add one for sections, icons, and labels.")
        .addButton((btn) =>
          btn.setButtonText("Add display layout").onClick(() =>
            void writeAnd(() => display.push({ section: "Details", fields: [] }))
          )
        );
      return;
    }

    display.forEach((section, si) => {
      const head = new Setting(contentEl).setClass("vault-warden-display-section");
      debouncedText(head.setName("Section"), section.section, "heading", (v) => {
        section.section = v;
        void write();
      });
      debouncedText(head, section.icon ?? "", "lucide icon", (v) => {
        section.icon = v.trim() || null;
        void write();
      });
      head.addDropdown((dd) => {
        dd.addOption("", "no colour");
        for (const c of PALETTE) dd.addOption(c, c);
        dd.setValue(section.color ?? "").onChange((v) => {
          section.color = v || null;
          void write();
        });
      });
      head.addExtraButton((b) =>
        b.setIcon("chevron-up").setTooltip("Move up").setDisabled(si === 0).onClick(() =>
          void writeAnd(() => display.splice(si - 1, 0, display.splice(si, 1)[0]))
        )
      );
      head.addExtraButton((b) =>
        b
          .setIcon("chevron-down")
          .setTooltip("Move down")
          .setDisabled(si === display.length - 1)
          .onClick(() => void writeAnd(() => display.splice(si + 1, 0, display.splice(si, 1)[0])))
      );
      head.addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Delete section").onClick(() =>
          void writeAnd(() => display.splice(si, 1))
        )
      );

      section.fields ??= [];
      section.fields.forEach((f, fi) => {
        const row = new Setting(contentEl).setClass("vault-warden-display-field");
        debouncedText(row.setName("Field"), f.field, "frontmatter key", (v) => {
          f.field = v.trim();
          void write();
        });
        debouncedText(row, f.label ?? "", "label", (v) => {
          f.label = v.trim() || null;
          void write();
        });
        debouncedText(row, f.icon ?? "", "icon", (v) => {
          f.icon = v.trim() || null;
          void write();
        });
        row.addExtraButton((b) =>
          b.setIcon("chevron-up").setDisabled(fi === 0).onClick(() =>
            void writeAnd(() => section.fields.splice(fi - 1, 0, section.fields.splice(fi, 1)[0]))
          )
        );
        row.addExtraButton((b) =>
          b
            .setIcon("chevron-down")
            .setDisabled(fi === section.fields.length - 1)
            .onClick(() =>
              void writeAnd(() => section.fields.splice(fi + 1, 0, section.fields.splice(fi, 1)[0]))
            )
        );
        row.addExtraButton((b) =>
          b.setIcon("trash").onClick(() => void writeAnd(() => section.fields.splice(fi, 1)))
        );
      });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Add field").onClick(() =>
          void writeAnd(() => section.fields.push({ field: "" }))
        )
      );
    });

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Add section").onClick(() =>
        void writeAnd(() => display.push({ section: "Section", fields: [] }))
      )
    );
  }
}
