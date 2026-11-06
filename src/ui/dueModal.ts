import { App, setIcon, SuggestModal } from "obsidian";
import { quickDates } from "../sync/dates";

/** What the picker sets the due date to. */
export type DuePick = { date: string } | { words: string } | null;

type Choice =
  | { kind: "date"; name: string; date: string; icon: string }
  | { kind: "words"; words: string }
  | { kind: "none" };

const ICONS: Record<string, string> = {
  Today: "calendar-check",
  Tomorrow: "sun",
  "This weekend": "sofa",
  "Next weekend": "sofa",
  "Next week": "calendar-days",
};

/**
 * Pick a task's due date, from the date on its chip, like Todoist's scheduler: today, tomorrow,
 * the weekend, next week or no date. Or type a date in words, such as `next friday`, `20 nov` or
 * `every month`, for Todoist to work out.
 */
export class DueModal extends SuggestModal<Choice> {
  constructor(
    app: App,
    private current: string | null,
    private recurring: boolean,
    private onChoose: (pick: DuePick) => void,
  ) {
    super(app);
    this.setPlaceholder("Type a date, such as next friday or every month…");
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "set due date" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  getSuggestions(query: string): Choice[] {
    const q = query.trim().replace(/\s+/g, " ");
    const quick: Choice[] = quickDates(new Date()).map((d) => ({ kind: "date", ...d, icon: ICONS[d.name] ?? "calendar" }));
    if (this.current) quick.push({ kind: "none" });
    if (!q) return quick;
    // Typed: the quick choices whose names match, then the words themselves for Todoist to read.
    const matching = quick.filter((c) => (c.kind === "date" ? c.name : "No date").toLowerCase().includes(q.toLowerCase()));
    return [...matching, { kind: "words", words: q }];
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest", "inline-tasks-due-choice");
    const icon = el.createSpan({ cls: "inline-tasks-due-icon" });
    if (choice.kind === "words") {
      setIcon(icon, "calendar");
      el.createSpan({ text: `Set to “${choice.words}”` });
      el.createSpan({ text: "Todoist works out the date", cls: "inline-tasks-suggest-path inline-tasks-suggest-note" });
      return;
    }
    if (choice.kind === "none") {
      setIcon(icon, "calendar-x");
      el.createSpan({ text: this.recurring ? "No date (ends the repeat)" : "No date" });
      return;
    }
    setIcon(icon, choice.icon);
    el.createSpan({ text: choice.name });
    const day = new Date(choice.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const note = [day, choice.date === this.current ? "Current" : "", this.recurring ? "ends the repeat" : ""].filter(Boolean).join(" · ");
    el.createSpan({ text: note, cls: "inline-tasks-suggest-path inline-tasks-suggest-note" });
  }

  onChooseSuggestion(choice: Choice): void {
    if (choice.kind === "none") this.onChoose(null);
    else if (choice.kind === "words") this.onChoose({ words: choice.words });
    else if (choice.date !== this.current) this.onChoose({ date: choice.date });
  }
}
