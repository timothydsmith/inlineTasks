import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import type { SyncState } from "../sync/state";
import { renderChip } from "./chip";
import { chipAction, type ChipActions } from "./chipActions";

const MARKER_RE = /%%td:([A-Za-z0-9_-]+)%%/;
const ITEM = "li.task-list-item";

/** A chip whose subtask count, project and house icon have their own actions, rather than following the link. */
export function clickableChip(id: string, state: SyncState, path: string | undefined, actions: ChipActions): HTMLElement {
  const chip = renderChip(id, state, path);
  chip.addEventListener("click", (e) => {
    const action = chipAction(e.target, actions);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action(id);
  });
  return chip;
}

/** Does the item have its own chip (not one on a nested subtask)? */
function hasOwnChip(li: HTMLElement): boolean {
  return Array.from(li.querySelectorAll(".inline-tasks-chip")).some((c) => c.closest("li") === li);
}

/** Put the chip after the item's own text, before its fields and any nested list. */
function placeChip(li: HTMLElement, chip: HTMLElement): void {
  // Rendered by the Tasks plugin: after the description, before the dates and priority.
  const desc = li.querySelector<HTMLElement>(":scope > .tasks-list-text > .task-description");
  if (desc) {
    desc.after(chip);
    return;
  }
  // In a loose list (one with a blank line between items) the text is in its own paragraph, so the
  // chip goes inside it, or it would start a new line.
  const para = li.querySelector(":scope > p");
  if (para) para.appendChild(chip);
  else li.insertBefore(chip, li.querySelector(":scope > ul, :scope > ol"));
}

/**
 * Reading view: Obsidian strips `%%comments%%` from rendered HTML, so map each task
 * `<li>` back to its source line and append a chip if that line carries a marker.
 *
 * The Tasks plugin replaces each task's `<li>` with its own rendering, after this runs (it waits
 * for the layout to be ready). Only nested lists survive that, so the section is watched and the
 * chip added again to each replacement, which keeps the same `data-line`.
 */
export function readingChipProcessor(getState: () => SyncState, actions: ChipActions) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    if (!el.querySelector(ITEM)) return;
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    const lines = info.text.split("\n");

    const addChip = (li: HTMLElement) => {
      // A Tasks query result: its data-line is its place in the results, not a line of this note.
      if (hasOwnChip(li) || li.closest(".plugin-tasks-query-result")) return;
      const rel = Number(li.getAttribute("data-line"));
      if (!Number.isFinite(rel)) return;
      const m = MARKER_RE.exec(lines[info.lineStart + rel] ?? "");
      if (!m) return;
      placeChip(li, clickableChip(m[1], getState(), ctx.sourcePath, actions));
    };
    el.querySelectorAll<HTMLElement>(ITEM).forEach(addChip);

    const observer = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches(ITEM)) addChip(n);
          n.querySelectorAll<HTMLElement>(ITEM).forEach(addChip);
        });
      }
    });
    observer.observe(el, { childList: true, subtree: true });
    const child = new MarkdownRenderChild(el);
    child.onunload = () => observer.disconnect();
    ctx.addChild(child);
  };
}
