import { App, SuggestModal } from "obsidian";
import { projectKey } from "../sync/engine";
import type { SyncState } from "../sync/state";
import { projectChoices, renderProjectChoice, type ProjectChoice } from "./projectSuggest";

type Choice = ProjectChoice | { kind: "create"; name: string };

/**
 * Pick a project to move a task to, from the project on its chip. Offers to create a project when
 * none matches what's typed. The task's current project is marked, and choosing it does nothing.
 */
export class ProjectModal extends SuggestModal<Choice> {
  constructor(
    app: App,
    private state: SyncState,
    private currentId: string | undefined,
    private onChoose: (name: string, id: string | undefined) => void,
  ) {
    super(app);
    this.limit = 500; // the whole project list, nested, when nothing is typed
    this.setPlaceholder("Move to project…");
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "move to project" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  getSuggestions(query: string): Choice[] {
    const q = query.trim();
    const out: Choice[] = projectChoices(this.state, q);
    // `]` would end a `#[Project]` reference, so a name with one can't be created this way.
    if (q && !q.includes("]") && !out.some((c) => c.kind === "project" && projectKey(c.name) === projectKey(q))) {
      out.push({ kind: "create", name: q });
    }
    return out;
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest");
    if (choice.kind === "create") {
      el.createDiv({ text: `Create project “${choice.name}”`, cls: "inline-tasks-suggest-create" });
      return;
    }
    renderProjectChoice(choice, el, choice.id === this.currentId ? "Current" : undefined);
  }

  onChooseSuggestion(choice: Choice): void {
    if (choice.kind === "project" && choice.id === this.currentId) return;
    this.onChoose(choice.name, choice.kind === "project" ? choice.id : undefined);
  }
}
