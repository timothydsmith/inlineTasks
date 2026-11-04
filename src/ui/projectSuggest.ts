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
import { parseTaskLine } from "../parse/taskLine";
import { projectKey } from "../sync/engine";
import type { SyncState } from "../sync/state";

type Choice =
  | { kind: "project"; id: string; name: string; path: string; score: number }
  | { kind: "create"; name: string };

const CHECKBOX_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/;
/** `#` (at line start or after a space) followed by the query, up to the cursor. `#[` allows spaces. */
const QUERY_RE = /(?:^|\s)#(\[[^\]\n]*|[^\s#[\]]*)$/;

/**
 * Typing `#` on a checkbox line offers the user's Todoist projects. Picking one inserts
 * `#[Project name]`, which sync turns into the task's project and then removes from the line.
 *
 * Plain `#tags` keep working: without `[`, the menu only opens when the text matches a project,
 * so Obsidian's own tag suggestions take over otherwise. Typing `#[` also offers to create a project.
 */
export class ProjectSuggest extends EditorSuggest<Choice> {
  constructor(
    app: App,
    private getState: () => SyncState,
    private enabledFor: (file: TFile | null) => boolean,
  ) {
    super(app);
    this.limit = 50;
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "file in project" },
      { command: "esc", purpose: "keep as a tag" },
    ]);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!this.enabledFor(file)) return null;
    const line = editor.getLine(cursor.line);
    const task = parseTaskLine(line);
    if (!task || /(^|\s)#notodoist(\s|$)/.test(line)) return null;
    if (task.checked && !task.todoistId && !task.pendingUuid) return null; // never syncs, so a project means nothing

    const m = QUERY_RE.exec(line.slice(0, cursor.ch));
    if (!m) return null;
    const hashAt = cursor.ch - m[1].length - 1;
    const checkboxEnd = CHECKBOX_RE.exec(line)?.[0].length ?? 0;
    if (hashAt < checkboxEnd) return null;

    const bracketed = m[1].startsWith("[");
    const query = bracketed ? m[1].slice(1) : m[1];
    // A bare `#word` is probably an ordinary tag: only step in if it matches a project.
    if (!bracketed && query && !this.projects(query).length) return null;
    return { start: { line: cursor.line, ch: hashAt }, end: cursor, query: bracketed ? `[${query}` : query };
  }

  getSuggestions(ctx: EditorSuggestContext): Choice[] {
    const bracketed = ctx.query.startsWith("[");
    const query = (bracketed ? ctx.query.slice(1) : ctx.query).trim();
    const out: Choice[] = this.projects(query);
    if (bracketed && query && !out.some((c) => c.kind === "project" && projectKey(c.name) === projectKey(query))) {
      out.push({ kind: "create", name: query });
    }
    return out;
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest");
    if (choice.kind === "create") {
      el.createDiv({ text: `Create project “${choice.name}”`, cls: "inline-tasks-suggest-create" });
      return;
    }
    el.createDiv({ text: choice.name });
    if (choice.path) el.createDiv({ text: choice.path, cls: "inline-tasks-suggest-path" });
  }

  selectSuggestion(choice: Choice): void {
    const ctx = this.context;
    if (!ctx) return;
    const after = ctx.editor.getRange(ctx.end, { line: ctx.end.line, ch: ctx.end.ch + 1 });
    const text = `#[${choice.name}]` + (after === " " ? "" : " ");
    ctx.editor.replaceRange(text, ctx.start, ctx.end);
    ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + text.length + (after === " " ? 1 : 0) });
  }

  /** Active projects matching `query` (fuzzy), best first; all of them, Inbox first, for an empty query. */
  private projects(query: string): Choice[] {
    const { projects } = this.getState();
    const search = query ? prepareFuzzySearch(query) : null;
    const out: Extract<Choice, { kind: "project" }>[] = [];
    for (const [id, p] of Object.entries(projects)) {
      if (p.archived) continue;
      const score = search ? search(p.name)?.score : 0;
      if (score === undefined) continue;
      out.push({ kind: "project", id, name: p.name, path: this.parentPath(p.parentId), score: p.inbox && !query ? 1 : score });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  private parentPath(parentId: string | null | undefined): string {
    const { projects } = this.getState();
    const names: string[] = [];
    for (let id = parentId, guard = 0; id && projects[id] && guard < 10; id = projects[id].parentId, guard++) {
      names.unshift(projects[id].name);
    }
    return names.join(" / ");
  }
}
