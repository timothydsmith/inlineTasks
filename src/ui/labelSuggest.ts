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
import { labelRef, parseTaskLine } from "../parse/taskLine";
import { labelKey } from "../sync/engine";
import type { SyncState } from "../sync/state";

type Choice = { kind: "label"; name: string; score: number; order: number } | { kind: "create"; name: string };

const CHECKBOX_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/;
/** `@` (at line start or after a space) and the query up to the cursor: `@[any text` or `@word`. */
const QUERY_RE = /(?:^|\s)@(\[[^\]\n]*|[^\s@[\]#()]*)$/;
/** From the cursor to the end of the reference being edited: through `]` if bracketed, else the rest of the word. */
const BRACKET_REST_RE = /^[^\]\n]*\]/;
const WORD_REST_RE = /^[^\s@[\]#()]*/;

/**
 * Typing `@` on a checkbox line offers the user's Todoist labels, or to create one. Picking one
 * inserts `@label` (or `@[Label name]` for names with spaces or punctuation), which sync adds to
 * the task's labels and then removes from the line.
 */
export class LabelSuggest extends EditorSuggest<Choice> {
  constructor(
    app: App,
    private getState: () => SyncState,
    private enabledFor: (file: TFile | null) => boolean,
  ) {
    super(app);
    this.limit = 50;
    this.setInstructions([
      { command: "↑↓", purpose: "choose" },
      { command: "↵", purpose: "add label" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!this.enabledFor(file)) return null;
    const line = editor.getLine(cursor.line);
    const task = parseTaskLine(line);
    if (!task || /(^|\s)#notodoist(\s|$)/.test(line)) return null;
    if (task.checked && !task.todoistId && !task.pendingUuid) return null; // never syncs, so a label means nothing

    const m = QUERY_RE.exec(line.slice(0, cursor.ch));
    if (!m) return null;
    const atPos = cursor.ch - m[1].length - 1; // position of `@`
    const checkboxEnd = CHECKBOX_RE.exec(line)?.[0].length ?? 0;
    if (atPos < checkboxEnd) return null;
    const query = m[1].startsWith("[") ? m[1].slice(1) : m[1];
    return { start: { line: cursor.line, ch: atPos }, end: cursor, query };
  }

  getSuggestions(ctx: EditorSuggestContext): Choice[] {
    const query = ctx.query.trim();
    const out: Choice[] = this.labels(query);
    if (query && !out.some((c) => labelKey(c.name) === labelKey(query))) out.push({ kind: "create", name: query });
    return out;
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    el.addClass("inline-tasks-suggest");
    if (choice.kind === "create") {
      el.createDiv({ text: `Create label “${choice.name}”`, cls: "inline-tasks-suggest-create" });
      return;
    }
    el.createDiv({ text: `@${choice.name}` });
  }

  selectSuggestion(choice: Choice): void {
    const ctx = this.context;
    if (!ctx) return;
    const { editor, start } = ctx;
    // Replace the whole reference being typed or edited, including an auto-paired `]`.
    const typed = editor.getLine(start.line).slice(start.ch + 1, ctx.end.ch);
    const rest = editor.getLine(ctx.end.line).slice(ctx.end.ch);
    const restLen = (typed.startsWith("[") ? BRACKET_REST_RE : WORD_REST_RE).exec(rest)?.[0].length ?? 0;
    const end = { line: ctx.end.line, ch: ctx.end.ch + restLen };
    const spaceAfter = rest.charAt(restLen) === " ";
    const text = labelRef(choice.name) + (spaceAfter ? "" : " ");
    editor.replaceRange(text, start, end);
    editor.setCursor({ line: start.line, ch: start.ch + text.length + (spaceAfter ? 1 : 0) });
  }

  /** Labels matching `query` (fuzzy), best first; all of them in Todoist's order for an empty query. */
  private labels(query: string): Extract<Choice, { kind: "label" }>[] {
    const search = query ? prepareFuzzySearch(query) : null;
    const out: Extract<Choice, { kind: "label" }>[] = [];
    const seen = new Set<string>();
    for (const l of Object.values(this.getState().labels)) {
      if (seen.has(labelKey(l.name))) continue;
      const score = search ? search(l.name)?.score : 0;
      if (score === undefined) continue;
      seen.add(labelKey(l.name));
      out.push({ kind: "label", name: l.name, score, order: l.order ?? 0 });
    }
    return out.sort((a, b) => b.score - a.score || a.order - b.order || a.name.localeCompare(b.name));
  }
}
