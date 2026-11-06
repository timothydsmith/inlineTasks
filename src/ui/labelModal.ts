import { App, prepareFuzzySearch, SuggestModal } from "obsidian";
import { labelKey } from "../sync/engine";
import type { SyncState } from "../sync/state";

type Choice = { kind: "label"; name: string; score: number; order: number } | { kind: "create"; name: string };

/** What the picker changed, when it closed. */
export interface LabelPick {
  /** Labels ticked that weren't at the start, by name. New ones are created by whoever applies them. */
  add: string[];
  /** Labels unticked that were ticked at the start. */
  remove: string[];
  /** What was left in the search box, if nothing was ticked or unticked; otherwise empty. */
  query: string;
}

/**
 * Pick a task's labels, like Todoist's label menu: every label with a tick box, the task's own
 * labels ticked. Type to filter; Enter or a click ticks or unticks the highlighted label, and
 * offers to create one when nothing matches. The picker stays open until Esc or a click outside,
 * and the changes are applied then.
 */
export class LabelModal extends SuggestModal<Choice> {
  /** Ticked labels: key → name. */
  private ticked = new Map<string, string>();
  private initial: Map<string, string>;
  /** Labels created in this picker, so they stay listed once the search box is cleared. */
  private created: string[] = [];
  /** Tick boxes on screen, by label key, to update in place. */
  private boxes = new Map<string, HTMLInputElement>();

  constructor(
    app: App,
    private state: SyncState,
    current: string[],
    private onDone: (pick: LabelPick) => void,
  ) {
    super(app);
    for (const l of current) this.ticked.set(labelKey(l), l);
    this.initial = new Map(this.ticked);
    this.limit = 100;
    this.setPlaceholder("Labels…");
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "tick or untick" },
      { command: "esc", purpose: "done" },
    ]);
    this.modalEl.addClass("inline-tasks-label-modal");
  }

  getSuggestions(query: string): Choice[] {
    this.boxes.clear();
    const q = query.trim();
    const search = q ? prepareFuzzySearch(q) : null;
    const out: Extract<Choice, { kind: "label" }>[] = [];
    const seen = new Set<string>();
    const consider = (name: string, order: number) => {
      const key = labelKey(name);
      if (seen.has(key)) return;
      seen.add(key);
      const score = search ? search(name)?.score : 0;
      if (score !== undefined) out.push({ kind: "label", name, score, order });
    };
    for (const l of Object.values(this.state.labels)) consider(l.name, l.order ?? 0);
    // The task's labels and ones created here, even if this device hasn't pulled them yet.
    for (const name of [...this.ticked.values(), ...this.created]) consider(name, Number.MAX_SAFE_INTEGER);
    out.sort((a, b) => b.score - a.score || a.order - b.order || a.name.localeCompare(b.name));
    const choices: Choice[] = out;
    if (q && !seen.has(labelKey(q))) choices.push({ kind: "create", name: q.replace(/\s+/g, " ") });
    return choices;
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest", "inline-tasks-label-choice");
    if (choice.kind === "create") {
      el.createDiv({ text: `Create label “${choice.name}”`, cls: "inline-tasks-suggest-create" });
      return;
    }
    const key = labelKey(choice.name);
    const box = el.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
    box.checked = this.ticked.has(key);
    box.tabIndex = -1;
    this.boxes.set(key, box);
    el.createSpan({ text: `@${choice.name}` });
  }

  /** Tick or untick, and stay open: unlike a normal picker, choosing doesn't close it. */
  selectSuggestion(choice: Choice): void {
    const key = labelKey(choice.name);
    if (choice.kind === "create") {
      this.created.push(choice.name);
      this.ticked.set(key, choice.name);
    } else if (this.ticked.has(key)) {
      this.ticked.delete(key);
    } else {
      this.ticked.set(key, choice.name);
    }
    if (this.inputEl.value.trim()) {
      // Clear the search, ready to find the next label.
      this.inputEl.value = "";
      this.inputEl.dispatchEvent(new Event("input"));
    } else {
      const box = this.boxes.get(key);
      if (box) box.checked = this.ticked.has(key);
    }
  }

  onChooseSuggestion(): void {
    // Not used: selectSuggestion handles choosing.
  }

  onClose(): void {
    super.onClose();
    const add = [...this.ticked].filter(([k]) => !this.initial.has(k)).map(([, n]) => n);
    const remove = [...this.initial].filter(([k]) => !this.ticked.has(k)).map(([, n]) => n);
    const query = add.length || remove.length ? "" : this.inputEl.value.trim();
    this.onDone({ add, remove, query });
  }
}
