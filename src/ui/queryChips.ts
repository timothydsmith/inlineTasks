/**
 * Chips in the Tasks plugin's query results.
 *
 * Tasks draws its results itself, without the `%%td:…%%` markers (Obsidian strips comments when it
 * renders a task's text), so nothing in a result says which Todoist task it is. Each result is
 * matched back to a task in Tasks' own cache, by its text, status and note, and gets that task's
 * chip if exactly one Todoist task matches.
 */

const MARKER_RE = /%%td:([A-Za-z0-9_-]+)%%/;
const RESULTS = ".plugin-tasks-query-result";
const RESULT_ITEM = `${RESULTS} li.task-list-item`;
const CHIP = "inline-tasks-chip";
const SCAN_DELAY_MS = 50;

/** The parts of a task in the Tasks plugin's cache used here. */
export interface TasksCacheTask {
  description: string;
  originalMarkdown: string;
  status?: { symbol?: string };
  taskLocation?: { path?: string };
}

/** Rendered markdown and its source, reduced to text that compares equal. */
function comparable(s: string): string {
  return s
    .replace(/#[^\s#]+/g, "") // tags (and Tasks' global filter, which it may hide)
    .replace(/[*_`~=]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A task's description as Obsidian renders it: comments gone, links as their text. */
function renderedText(md: string): string {
  return md
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/!?\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/!?\[\[([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/** Tasks' backlink names the note by its name, or its path if the name isn't unique, then " > heading". */
function linkMatches(link: string, path: string | undefined): boolean {
  if (!path) return false;
  const noExt = path.replace(/\.md$/, "");
  const name = noExt.split("/").pop()!;
  return [name, noExt].some((p) => link === p || link.startsWith(`${p} > `));
}

/**
 * The Todoist task shown by a query result, given its rendered text, status symbol and backlink
 * text (null when the query hides backlinks or shows only 🔗). Null unless exactly one matches.
 * `path` is the result's note, when every matching line is in the same one.
 */
export function matchResult(
  text: string,
  symbol: string,
  link: string | null,
  tasks: readonly TasksCacheTask[],
): { id: string; path?: string } | null {
  const want = comparable(text);
  const ids = new Set<string>();
  const paths = new Set<string | undefined>();
  for (const t of tasks) {
    const m = MARKER_RE.exec(t.originalMarkdown);
    if (!m) continue;
    if ((t.status?.symbol ?? "").trim() !== symbol.trim()) continue;
    if (comparable(renderedText(t.description)) !== want) continue;
    if (link && !linkMatches(link, t.taskLocation?.path)) continue;
    ids.add(m[1]);
    paths.add(t.taskLocation?.path);
  }
  if (ids.size !== 1) return null;
  return { id: [...ids][0], path: paths.size === 1 ? [...paths][0] : undefined };
}

/**
 * Watch `root` for Tasks query results and add chips to them. `makeChip` builds a chip for a
 * Todoist task shown in the note at `path` (unknown if undefined).
 */
export class QueryChips {
  private observer: MutationObserver;
  private timer: number | null = null;
  /** Redraw chips already shown, not only add missing ones. */
  private redraw = false;

  constructor(
    private root: HTMLElement,
    private getTasks: () => readonly TasksCacheTask[] | null,
    private makeChip: (id: string, path: string | undefined) => HTMLElement,
  ) {
    this.observer = new MutationObserver((records) => {
      if (records.some((r) => this.touchesResults(r))) this.schedule();
    });
    this.observer.observe(root, { childList: true, subtree: true });
    this.schedule();
  }

  /** Redraw every chip in query results, e.g. after a sync changed what they show. */
  refresh(): void {
    this.redraw = true;
    this.schedule();
  }

  stop(): void {
    this.observer.disconnect();
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  private touchesResults(r: MutationRecord): boolean {
    if (r.target instanceof Element && r.target.closest(RESULTS)) return true;
    return Array.from(r.addedNodes).some(
      (n) => n instanceof Element && (n.matches(RESULTS) || !!n.querySelector(RESULTS)),
    );
  }

  private schedule(): void {
    if (this.timer !== null) return;
    // Tasks adds a result's line, then renders its text, so wait for it to settle.
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.scan();
    }, SCAN_DELAY_MS);
  }

  private scan(): void {
    const items = this.root.querySelectorAll<HTMLElement>(RESULT_ITEM);
    const redraw = this.redraw;
    this.redraw = false;
    if (!items.length) return;
    const tasks = this.getTasks();
    if (!tasks) return;
    items.forEach((li) => {
      const shown = Array.from(li.querySelectorAll(`.${CHIP}`)).find((c) => c.closest("li") === li);
      if (shown && !redraw) return;
      const desc = li.querySelector<HTMLElement>(":scope > .tasks-list-text > .task-description");
      if (!desc) return;
      const linkText = li.querySelector(":scope .tasks-backlink a")?.textContent?.trim() ?? null;
      const link = linkText && !linkText.includes("🔗") ? linkText : null;
      const match = matchResult(desc.textContent ?? "", li.getAttribute("data-task") ?? "", link, tasks);
      const chip = match ? this.makeChip(match.id, match.path) : null;
      if (shown && chip) shown.replaceWith(chip);
      else if (shown) shown.remove();
      else if (chip) desc.after(chip);
    });
  }
}
