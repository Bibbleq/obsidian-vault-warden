import { App, Modal, Setting, SuggestModal } from "obsidian";

/** Pick one value from a closed list (select/multi-backed fields). */
export class ValueSuggestModal extends SuggestModal<string> {
  private values: string[];
  private onPick: (value: string) => void;

  constructor(app: App, values: string[], placeholder: string, onPick: (value: string) => void) {
    super(app);
    this.values = values;
    this.onPick = onPick;
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.values.filter((v) => v.toLowerCase().includes(q));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  onChooseSuggestion(value: string): void {
    this.onPick(value);
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
