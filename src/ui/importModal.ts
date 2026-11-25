import { App, prepareFuzzySearch, setIcon, SuggestModal } from "obsidian";
import type { SyncState } from "../sync/state";
import { dueDate, type TodoistItem } from "../todoist/client";
import { rankMatches, type Searchable } from "./importSearch";

interface Candidate extends Searchable {
  item: TodoistItem;
  /** Project, with parent projects, e.g. "Work / Clients". */
  project: string;
  subtasks: number;
  /** The note it's already linked in, its home, or null if it's in no note yet. */
  home: string | null;
}

/** How many tasks the list shows; more are reached by typing. */
const LIMIT = 100;

/**
 * Pick an open Todoist task to insert at the cursor. Searches the task's title, project, labels and
 * due date, by words in any order (see rankMatches); with nothing typed, lists tasks by due date,
 * soonest first. A task already linked in a note shows which, and is inserted as a copy of it.
 */
export class ImportModal extends SuggestModal<Candidate> {
  private candidates: Candidate[];

  constructor(
    app: App,
    state: SyncState,
    items: TodoistItem[],
    homeOf: (id: string) => string | null,
    private onChoose: (item: TodoistItem, home: string | null) => void,
  ) {
    super(app);
    this.limit = LIMIT;
    const kids = new Map<string, number>();
    for (const i of items) if (i.parent_id) kids.set(i.parent_id, (kids.get(i.parent_id) ?? 0) + 1);
    this.candidates = items.map((item) => {
      const project = projectPath(state, item.project_id);
      const due = dueDate(item.due);
      const labels = (item.labels ?? []).map((l) => `@${l}`).join(" ");
      return { item, project, due, subtasks: kids.get(item.id) ?? 0, home: homeOf(item.id), title: item.content, rest: `${project} ${labels} ${due ?? ""}` };
    });
    const n = this.candidates.length;
    this.setPlaceholder(n > LIMIT ? `Search ${n} Todoist tasks by title, project or label…` : "Import a Todoist task…");
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "insert it, or a copy if it's in a note already" },
      { command: "esc", purpose: "dismiss" },
    ]);
    this.emptyStateText = n ? "No matching task" : "No open Todoist tasks";
  }

  getSuggestions(query: string): Candidate[] {
    const q = query.trim();
    const fuzzy = q ? prepareFuzzySearch(q) : null;
    return rankMatches(this.candidates, q, fuzzy ? (text) => fuzzy(text)?.score ?? null : undefined);
  }

  renderSuggestion(c: Candidate, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest");
    el.createDiv({ text: c.item.content });
    const labels = (c.item.labels ?? []).map((l) => `@${l}`).join(" ");
    // A copy brings only the task's line, so its subtask count isn't shown.
    const subtasks = !c.home && c.subtasks ? `${c.subtasks} subtask${c.subtasks > 1 ? "s" : ""}` : "";
    const details = [c.project, labels, c.due ? `⏳ ${c.due}` : "", subtasks];
    const row = el.createDiv({ cls: "inline-tasks-suggest-path" });
    if (c.home) {
      const where = row.createSpan({ cls: "inline-tasks-suggest-home" });
      setIcon(where.createSpan(), "home");
      where.createSpan({ text: ` In ${c.home.replace(/\.md$/, "")}: inserts a copy` });
      if (details.some(Boolean)) row.createSpan({ text: " · " });
    }
    row.createSpan({ text: details.filter(Boolean).join(" · ") });
  }

  onChooseSuggestion(c: Candidate): void {
    this.onChoose(c.item, c.home);
  }
}

function projectPath(state: SyncState, id: string): string {
  const names: string[] = [];
  for (let p = id, guard = 0; p && state.projects[p] && guard < 10; p = state.projects[p].parentId ?? "", guard++) {
    names.unshift(state.projects[p].name);
  }
  return names.join(" / ");
}
