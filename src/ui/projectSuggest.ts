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
    this.limit = 50;
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
    if (task.checked && !task.todoistId && !task.pendingUuid) return null; // never syncs, so a project means nothing

    const m = QUERY_RE.exec(line.slice(0, cursor.ch));
    if (!m) return null;
    const hashAt = cursor.ch - m[1].length - 2; // position of `#`
    const checkboxEnd = CHECKBOX_RE.exec(line)?.[0].length ?? 0;
    if (hashAt < checkboxEnd) return null;
    return { start: { line: cursor.line, ch: hashAt }, end: cursor, query: m[1] };
  }

  getSuggestions(ctx: EditorSuggestContext): Choice[] {
    const query = ctx.query.trim();
    const out: Choice[] = this.projects(query);
    if (query && !out.some((c) => c.kind === "project" && projectKey(c.name) === projectKey(query))) {
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
    const { editor, start } = ctx;
    // Replace through the closing `]` if there is one, so an auto-paired bracket doesn't leave a stray `]`.
    const rest = editor.getLine(ctx.end.line).slice(ctx.end.ch);
    const closeLen = CLOSE_RE.exec(rest)?.[0].length ?? 0;
    const end = { line: ctx.end.line, ch: ctx.end.ch + closeLen };
    const spaceAfter = rest.charAt(closeLen) === " ";
    const text = `#[${choice.name}]` + (spaceAfter ? "" : " ");
    editor.replaceRange(text, start, end);
    editor.setCursor({ line: start.line, ch: start.ch + text.length + (spaceAfter ? 1 : 0) });
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
