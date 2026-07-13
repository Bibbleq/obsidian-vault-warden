import { App, Modal, Setting, SuggestModal, TFile } from "obsidian";

/** Pick a note from the vault; resolves to "[[basename]]" link text. */
export class FileLinkSuggestModal extends SuggestModal<TFile> {
  private onPick: (linkText: string) => void;

  constructor(app: App, onPick: (linkText: string) => void) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder("Link to note…");
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.toLowerCase().includes(q))
      .slice(0, 50);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.basename);
    el.createEl("small", { text: ` ${file.path}`, cls: "vault-warden-suggest-path" });
  }

  onChooseSuggestion(file: TFile): void {
    this.onPick(`[[${file.basename}]]`);
  }
}

interface ValueSuggestion {
  value: string;
  create?: boolean;
}

/**
 * Pick one value from a closed list (select/multi-backed fields). When
 * `onCreate` is provided and the typed query matches no existing option, an
 * "Add option" entry appears — choosing it persists the new option (via
 * onCreate, which writes it into the schema/source list) AND applies it.
 */
export class ValueSuggestModal extends SuggestModal<ValueSuggestion> {
  private values: string[];
  private onPick: (value: string) => void;
  private onCreate?: (value: string) => void;

  constructor(
    app: App,
    values: string[],
    placeholder: string,
    onPick: (value: string) => void,
    onCreate?: (value: string) => void
  ) {
    super(app);
    this.values = values;
    this.onPick = onPick;
    this.onCreate = onCreate;
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): ValueSuggestion[] {
    const q = query.toLowerCase();
    const items: ValueSuggestion[] = this.values
      .filter((v) => v.toLowerCase().includes(q))
      .map((value) => ({ value }));
    const typed = query.trim();
    if (
      this.onCreate &&
      typed !== "" &&
      !this.values.some((v) => v.toLowerCase() === typed.toLowerCase())
    ) {
      items.push({ value: typed, create: true });
    }
    return items;
  }

  renderSuggestion(item: ValueSuggestion, el: HTMLElement): void {
    if (item.create) {
      el.setText(`＋ Add option: ${item.value}`);
      el.addClass("vault-warden-suggest-create");
    } else {
      el.setText(item.value);
    }
  }

  onChooseSuggestion(item: ValueSuggestion): void {
    if (item.create && this.onCreate) this.onCreate(item.value);
    this.onPick(item.value);
  }
}

/**
 * Date/datetime prompt for date-typed fields. Defaults to now; offers the
 * value with time (YYYY-MM-DDTHH:mm) or as a plain date (YYYY-MM-DD).
 */
export class DatePromptModal extends Modal {
  private promptTitle: string;
  private initial: string;
  private onSubmit: (value: string) => void;

  constructor(app: App, title: string, initial: string | null, onSubmit: (value: string) => void) {
    super(app);
    this.promptTitle = title;
    this.initial = initial ?? DatePromptModal.nowLocal();
    this.onSubmit = onSubmit;
  }

  /** Current local time as YYYY-MM-DDTHH:mm (datetime-local input format). */
  static nowLocal(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `T${pad(now.getHours())}:${pad(now.getMinutes())}`
    );
  }

  onOpen(): void {
    this.titleEl.setText(this.promptTitle);
    const input = this.contentEl.createEl("input", {
      type: "datetime-local",
      cls: "vault-warden-date-input",
    });
    input.value = this.initial;

    const submit = (dateOnly: boolean) => {
      if (!input.value) return;
      this.close();
      this.onSubmit(dateOnly ? input.value.slice(0, 10) : input.value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit(false);
      }
    });

    new Setting(this.contentEl)
      .addButton((btn) => btn.setButtonText("Apply").setCta().onClick(() => submit(false)))
      .addButton((btn) => btn.setButtonText("Date only").onClick(() => submit(true)));
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Free-text value prompt, prefilled with the current (offending) value. */
export class TextPromptModal extends Modal {
  private promptTitle: string;
  private initial: string;
  private onSubmit: (value: string) => void;

  constructor(app: App, title: string, initial: string, onSubmit: (value: string) => void) {
    super(app);
    this.promptTitle = title;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText(this.promptTitle);
    let value = this.initial;
    const submit = () => {
      this.close();
      this.onSubmit(value);
    };
    new Setting(this.contentEl).addText((text) => {
      text.setValue(this.initial).onChange((v) => (value = v));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText("Apply").setCta().onClick(submit)
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
