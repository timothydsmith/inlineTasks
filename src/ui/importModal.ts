import { App, prepareFuzzySearch, SuggestModal } from "obsidian";
import type { SyncState } from "../sync/state";
import { dueDate, type TodoistItem } from "../todoist/client";

interface Candidate {
  item: TodoistItem;
  /** Project, with parent projects, e.g. "Work / Clients". */
  project: string;
  due: string | null;
  subtasks: number;
  /** What the search matches against. */
  haystack: string;
  score: number;
}

/**
 * Pick an open Todoist task to insert at the cursor. Searches the task's title, project and due
 * date; with nothing typed, lists tasks by due date, soonest first.
 */
export class ImportModal extends SuggestModal<Candidate> {
  private candidates: Candidate[];

  constructor(
    app: App,
    state: SyncState,
    items: TodoistItem[],
    isLinked: (id: string) => boolean,
    private onChoose: (item: TodoistItem) => void,
  ) {
    super(app);
    this.limit = 100;
    this.setPlaceholder("Import a Todoist task…");
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "insert with its subtasks" },
      { command: "esc", purpose: "dismiss" },
    ]);
    const kids = new Map<string, number>();
    for (const i of items) if (i.parent_id) kids.set(i.parent_id, (kids.get(i.parent_id) ?? 0) + 1);
    this.candidates = items
      .filter((i) => !isLinked(i.id))
      .map((item) => {
        const project = projectPath(state, item.project_id);
        const due = dueDate(item.due);
        return { item, project, due, subtasks: kids.get(item.id) ?? 0, haystack: `${item.content} ${project} ${due ?? ""}`, score: 0 };
      });
    this.emptyStateText = this.candidates.length ? "No matching task" : "No open Todoist tasks that aren't already in a note";
  }

  getSuggestions(query: string): Candidate[] {
    const q = query.trim();
    if (!q) {
      return [...this.candidates].sort(
        (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.item.content.localeCompare(b.item.content),
      );
    }
    const search = prepareFuzzySearch(q);
    const out: Candidate[] = [];
    for (const c of this.candidates) {
      const m = search(c.haystack);
      if (m) out.push({ ...c, score: m.score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  renderSuggestion(c: Candidate, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest");
    el.createDiv({ text: c.item.content });
    const details = [c.project, c.due ? `📅 ${c.due}` : "", c.subtasks ? `${c.subtasks} subtask${c.subtasks > 1 ? "s" : ""}` : ""];
    el.createDiv({ text: details.filter(Boolean).join(" · "), cls: "inline-tasks-suggest-path" });
  }

  onChooseSuggestion(c: Candidate): void {
    this.onChoose(c.item);
  }
}

function projectPath(state: SyncState, id: string): string {
  const names: string[] = [];
  for (let p = id, guard = 0; p && state.projects[p] && guard < 10; p = state.projects[p].parentId ?? "", guard++) {
    names.unshift(state.projects[p].name);
  }
  return names.join(" / ");
}
