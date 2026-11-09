import { App, SuggestModal } from "obsidian";
import type { SyncState } from "../sync/state";
import { createChoice, projectChoices, renderCreateChoice, renderProjectChoice, type ProjectChoice } from "./projectSuggest";

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
    const create = createChoice(this.state, q); // `Work/Clients/Acme` creates nested projects
    if (create) out.push(create);
    return out;
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest");
    if (choice.kind === "create") {
      renderCreateChoice(this.state, choice.name, el);
      return;
    }
    renderProjectChoice(choice, el, choice.id === this.currentId ? "Current" : undefined);
  }

  onChooseSuggestion(choice: Choice): void {
    if (choice.kind === "project" && choice.id === this.currentId) return;
    this.onChoose(choice.name, choice.kind === "project" ? choice.id : undefined);
  }
}
