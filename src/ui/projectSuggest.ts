import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  prepareFuzzySearch,
  TFile,
} from "obsidian";
import { createsTask, parseTaskLine } from "../parse/taskLine";
import { findProjectId, projectPlan, projectRef, projectTree, splitProjectPath, type ProjectNode } from "../sync/projects";
import type { SyncState } from "../sync/state";
import { todoistColor } from "../todoist/colors";

type Choice = ({ kind: "project"; score: number } & ProjectNode) | { kind: "create"; name: string };

const CHECKBOX_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/;
/** `#[` (at line start or after a space) followed by the query, up to the cursor. */
const QUERY_RE = /(?:^|\s)#\[([^\]\n]*)$/;
/** From the cursor to the reference's closing `]`: an auto-paired bracket, or the rest of a name being edited. */
const CLOSE_RE = /^[^\]\n#]*\]/;

/**
 * Typing `#[` on a checkbox line offers the user's Todoist projects, or to create one. Picking one
 * inserts `#[Project name]`, which sync turns into the task's project and then removes from the line.
 *
 * Only `#[` triggers it. `[` can't appear in a tag, so Obsidian's own tag suggester has already
 * stepped aside by then and the two never compete; a bare `#` is always an ordinary tag.
 */
export class ProjectSuggest extends EditorSuggest<Choice> {
  constructor(
    app: App,
    private getState: () => SyncState,
    private enabledFor: (file: TFile | null) => boolean,
  ) {
    super(app);
    this.limit = 500; // the whole project list, nested, when nothing is typed
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "file in project" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!this.enabledFor(file)) return null;
    const line = editor.getLine(cursor.line);
    const task = parseTaskLine(line);
    if (!task || /(^|\s)#notodoist(\s|$)/.test(line)) return null;
    if (!task.todoistId && !task.pendingUuid && !createsTask(task)) return null; // never syncs, so a project means nothing

    const m = QUERY_RE.exec(line.slice(0, cursor.ch));
    if (!m) return null;
    const hashAt = cursor.ch - m[1].length - 2; // position of `#`
    const checkboxEnd = CHECKBOX_RE.exec(line)?.[0].length ?? 0;
    if (hashAt < checkboxEnd) return null;
    return { start: { line: cursor.line, ch: hashAt }, end: cursor, query: m[1] };
  }

  getSuggestions(ctx: EditorSuggestContext): Choice[] {
    const query = ctx.query.trim();
    const state = this.getState();
    const out: Choice[] = projectChoices(state, query);
    const create = createChoice(state, query);
    if (create) out.push(create);
    return out;
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest");
    if (choice.kind === "create") {
      renderCreateChoice(this.getState(), choice.name, el);
      return;
    }
    renderProjectChoice(choice, el);
  }

  selectSuggestion(choice: Choice): void {
    const ctx = this.context;
    if (!ctx) return;
    const { editor, start } = ctx;
    // Replace through the closing `]` if there is one, so an auto-paired bracket doesn't leave a stray `]`.
    const rest = editor.getLine(ctx.end.line).slice(ctx.end.ch);
    const closeLen = CLOSE_RE.exec(rest)?.[0].length ?? 0;
    const end = { line: ctx.end.line, ch: ctx.end.ch + closeLen };
    const spaceAfter = rest.charAt(closeLen) === " ";
    // A project that shares its name with another is named by its path, so it means that one.
    const name = choice.kind === "project" ? (projectRef(this.getState(), choice.id) ?? choice.name) : choice.name;
    const text = `#[${name}]` + (spaceAfter ? "" : " ");
    editor.replaceRange(text, start, end);
    editor.setCursor({ line: start.line, ch: start.ch + text.length + (spaceAfter ? 1 : 0) });
  }

}

export type ProjectChoice = Extract<Choice, { kind: "project" }>;

/**
 * Active projects. With nothing typed, all of them as Todoist's sidebar lists them, nested (see
 * projectTree). With a query, the ones matching it (fuzzy), best first, each with its parents' names.
 */
export function projectChoices(state: SyncState, query: string): ProjectChoice[] {
  const tree = projectTree(state);
  if (!query) return tree.map((p) => ({ kind: "project", ...p, score: 0 }));
  // `Work/Cli`: match against each project's path, so a project can be found under its parent.
  const path = query.includes("/");
  const search = prepareFuzzySearch(path ? splitProjectPath(query).join("/") : query);
  const out: ProjectChoice[] = [];
  for (const p of tree) {
    const score = search(path ? p.names.join("/") : p.name)?.score;
    if (score !== undefined) out.push({ kind: "project", ...p, depth: 0, score });
  }
  return out.sort((a, b) => b.score - a.score); // stable, so ties keep Todoist's order
}

/**
 * The picker's offer to create the project typed, `Acme` or `Work/Clients/Acme`, unless it exists.
 * Not for a name with a `]`, which would end the `#[…]` reference.
 */
export function createChoice(state: SyncState, query: string): { kind: "create"; name: string } | undefined {
  const parts = splitProjectPath(query);
  if (!parts.length || query.includes("]") || findProjectId(state, query)) return undefined;
  return { kind: "create", name: parts.join("/") };
}

/** "Create project “Acme” in Work / Clients", saying which of those it creates too. */
export function renderCreateChoice(state: SyncState, ref: string, el: HTMLElement): void {
  const { name, parents, missing } = projectPlan(state, ref);
  let text = `Create project “${name}”`;
  if (parents.length) text += ` in ${parents.join(" / ")}`;
  el.createDiv({ text, cls: "inline-tasks-suggest-create" });
  if (missing.length) {
    const also = missing.map((m) => `“${m}”`).join(", ");
    el.createDiv({ text: `Also creates ${also}`, cls: "inline-tasks-suggest-path" });
  }
}

/**
 * One project in a picker: a `#` in the project's colour and its name, indented under its parent
 * in the nested list, or with its parents' names beneath it in search results. `note` goes at the end.
 */
export function renderProjectChoice(choice: ProjectChoice, el: HTMLElement, note?: string): void {
  el.addClass("inline-tasks-suggest");
  const row = el.createDiv({ cls: "inline-tasks-project-choice" });
  row.style.paddingLeft = `${choice.depth * 1.25}em`;
  const hash = row.createSpan({ text: "#", cls: "inline-tasks-project-hash" });
  const color = todoistColor(choice.color);
  if (color) hash.style.color = color;
  row.createSpan({ text: choice.name });
  if (note) row.createSpan({ text: note, cls: "inline-tasks-suggest-path inline-tasks-suggest-note" });
  if (choice.depth === 0 && choice.path) el.createDiv({ text: choice.path, cls: "inline-tasks-suggest-path" });
}
