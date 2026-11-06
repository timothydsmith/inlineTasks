import { App, setIcon, SuggestModal } from "obsidian";

interface Choice {
  /** As written on a line: 1 is urgent, 4 is none. */
  p: number;
  name: string;
}

const CHOICES: Choice[] = [
  { p: 1, name: "Priority 1" },
  { p: 2, name: "Priority 2" },
  { p: 3, name: "Priority 3" },
  { p: 4, name: "Priority 4" },
];

/**
 * Pick a task's priority, from the priority on its chip, like Todoist's priority menu. Type a
 * number to jump to it. The current priority is marked, and choosing it does nothing.
 */
export class PriorityModal extends SuggestModal<Choice> {
  constructor(
    app: App,
    private current: number,
    private onChoose: (p: number) => void,
  ) {
    super(app);
    this.setPlaceholder("Priority…");
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "set priority" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  getSuggestions(query: string): Choice[] {
    const q = query.trim().toLowerCase().replace(/^p(riority)?\s*/, "");
    return q ? CHOICES.filter((c) => String(c.p).startsWith(q)) : CHOICES;
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest", "inline-tasks-priority-choice");
    const flag = el.createSpan({ cls: `inline-tasks-priority-flag p${choice.p}` });
    setIcon(flag, "flag");
    el.createSpan({ text: choice.name });
    if (choice.p === this.current) el.createSpan({ text: "Current", cls: "inline-tasks-suggest-path" });
  }

  onChooseSuggestion(choice: Choice): void {
    if (choice.p !== this.current) this.onChoose(choice.p);
  }
}
