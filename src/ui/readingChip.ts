import type { MarkdownPostProcessorContext } from "obsidian";
import type { SyncState } from "../sync/state";
import { renderChip } from "./chip";
import { chipAction, type ChipActions } from "./chipActions";

const MARKER_RE = /%%td:([A-Za-z0-9_-]+)%%/;

/**
 * Reading view: Obsidian strips `%%comments%%` from rendered HTML, so map each task
 * `<li>` back to its source line and append a chip if that line carries a marker.
 */
export function readingChipProcessor(getState: () => SyncState, actions: ChipActions) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    const items = el.querySelectorAll<HTMLElement>("li.task-list-item");
    if (!items.length) return;
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    const lines = info.text.split("\n");
    items.forEach((li) => {
      const rel = Number(li.getAttribute("data-line"));
      if (!Number.isFinite(rel)) return;
      const m = MARKER_RE.exec(lines[info.lineStart + rel] ?? "");
      if (!m) return;
      const id = m[1];
      const chip = renderChip(id, getState());
      // The subtask count and the project have their own actions, rather than following the link.
      chip.addEventListener("click", (e) => {
        const action = chipAction(e.target, actions);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        action(id);
      });
      // Insert after the item's own text, before any nested list. In a loose list (one with a blank
      // line between items) that text is in its own paragraph, so the chip goes inside it, or it
      // would start a new line.
      const para = li.querySelector(":scope > p");
      if (para) para.appendChild(chip);
      else li.insertBefore(chip, li.querySelector(":scope > ul, :scope > ol"));
    });
  };
}
