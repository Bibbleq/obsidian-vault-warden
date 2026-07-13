import { App, Modal, Notice, Setting, debounce } from "obsidian";
import type { FieldSpec } from "./engine/types";
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

/** Render the full schema editor into the settings tab. */
export function renderSchemaEditor(
  container: HTMLElement,
  plugin: VaultWardenPlugin,
  refresh: () => void
): void {
  const loader = plugin.loader;
  container.createEl("h3", { text: "Schema editor" });
  container.createEl("p", {
    cls: "vault-warden-rules-note",
    text:
      "Edits write straight into the schema YAML files, preserving your comments " +
      "and formatting. Text boxes save ~1s after you stop typing; everything is " +
      "also still hand-editable in the files themselves.",
  });

  const basePath = loader.baseFilePath;
  const base = loader.base;
  if (!basePath || !base) {
    container.createEl("p", { text: "No schema loaded — nothing to edit yet." });
    return;
  }
  const editBase = (t: (s: string) => string) => plugin.editSchemaFile(basePath, t);

  // ---- Tags ----------------------------------------------------------------
  new Setting(container).setName("Tags").setHeading();
  debouncedText(
    new Setting(container).setName("Max depth").setDesc("TAG-DEPTH: maximum / levels per tag."),
    String(base.tags.max_depth),
    "2",
    (v) => {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) void editBase((s) => setPath(s, ["tags", "max_depth"], n));
    }
  );
  chips(
    container,
    "Retired tags",
    "TAG-RETIRED: removed on sight (case-insensitive).",
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

  // ---- Dates ---------------------------------------------------------------
  new Setting(container).setName("Dates").setHeading();
  chips(
    container,
    "Date-named suffixes",
    "DATE-FORMAT applies to any field ending with these, classed or not.",
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
    container,
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

  // ---- Base fields -----------------------------------------------------------
  new Setting(container).setName("Base fields").setHeading();
  for (const name of ["area", "notetype", "origin"]) {
    const spec = base.fields[name];
    const row = new Setting(container).setName(name);
    if (!spec) {
      row.setDesc("Not configured — its FM-* rules are inactive.").addButton((btn) =>
        btn.setButtonText("Add").onClick(async () => {
          await editBase((s) => setPath(s, ["fields", name], { type: "text", required: true }));
          refresh();
        })
      );
      continue;
    }
    row.setDesc("Type (e.g. select:Areas, multi:Note Types) · optional-when field · remove");
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

  // ---- Creation stamp --------------------------------------------------------
  new Setting(container).setName("Creation stamp").setHeading();
  container.createEl("p", {
    cls: "vault-warden-rules-note",
    text: "Extra frontmatter stamped on new notes in mapped folders. Values may use {{today}} / {{now}}.",
  });
  for (const [key, value] of Object.entries(loader.creationStamp)) {
    const row = new Setting(container).setName(key);
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
  new Setting(container).addButton((btn) =>
    btn.setButtonText("Add stamp key").onClick(() => {
      new TextPromptModal(plugin.app, "Frontmatter key", "", (key) => {
        if (key.trim() === "") return;
        void editBase((s) => setPath(s, ["creation_stamp", key.trim()], "value")).then(refresh);
      }).open();
    })
  );

  // ---- Title sync --------------------------------------------------------------
  new Setting(container).setName("Title sync").setHeading();
  const ts = loader.titleSync;
  if (!ts) {
    new Setting(container)
      .setDesc("Filename↔H1 sync is off (no title_sync block).")
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
  } else {
    debouncedText(
      new Setting(container).setName("Strip characters").setDesc("Removed when projecting H1 → filename."),
      ts.strip,
      "",
      (v) => void editBase((s) => setPath(s, ["title_sync", "strip"], v))
    );
    debouncedText(
      new Setting(container).setName("Replacement").setDesc("What each stripped character becomes."),
      ts.replacement,
      "",
      (v) => void editBase((s) => setPath(s, ["title_sync", "replacement"], v))
    );
    debouncedText(
      new Setting(container)
        .setName("Frontmatter title property")
        .setDesc("Third sync leg; empty = disabled."),
      ts.frontmatter_title,
      "",
      (v) => void editBase((s) => setPath(s, ["title_sync", "frontmatter_title"], v.trim()))
    );
    new Setting(container)
      .setName("Add old filename as alias")
      .addToggle((toggle) =>
        toggle.setValue(ts.add_old_alias).onChange((v) => {
          void editBase((s) => setPath(s, ["title_sync", "add_old_alias"], v));
        })
      );
    chips(
      container,
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
    for (const [from, to] of Object.entries(ts.remap)) {
      const row = new Setting(container).setName(`Remap ${from}`);
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
    new Setting(container).addButton((btn) =>
      btn.setButtonText("Add remapping").onClick(() => {
        new TextPromptModal(plugin.app, "Character(s) to remap", "", (from) => {
          if (from === "") return;
          void editBase((s) => setPath(s, ["title_sync", "remap", from], "")).then(refresh);
        }).open();
      })
    );
  }

  // ---- Folder → class map -------------------------------------------------------
  new Setting(container).setName("Folder → class map").setHeading();
  renderLocations(container, plugin, refresh);

  // ---- Exceptions ------------------------------------------------------------------
  new Setting(container).setName("Exceptions").setHeading();
  renderExceptions(container, plugin, refresh);

  // ---- Classes ---------------------------------------------------------------------
  new Setting(container).setName("Classes").setHeading();
  for (const name of Object.keys(loader.manifests).sort()) {
    const manifest = loader.manifests[name];
    const count = Object.keys(manifest.fields ?? {}).length;
    new Setting(container)
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
  new Setting(container).addButton((btn) =>
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

function renderExceptions(container: HTMLElement, plugin: VaultWardenPlugin, refresh: () => void): void {
  const loader = plugin.loader;
  const path = loader.exceptionsPath;
  if (!path) {
    new Setting(container)
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
    const row = new Setting(container)
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
  new Setting(container)
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
}
