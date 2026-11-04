import type { MarkdownPostProcessorContext } from "obsidian";
import type { SyncState } from "../sync/state";
import { renderChip } from "./chip";

const MARKER_RE = /%%td:([A-Za-z0-9_-]+)%%/;

/**
 * Reading view: Obsidian strips `%%comments%%` from rendered HTML, so map each task
 * `<li>` back to its source line and append a chip if that line carries a marker.
 */
export function readingChipProcessor(getState: () => SyncState) {
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
      const chip = renderChip(m[1], getState());
      // Insert after the item's own text, before any nested list.
      const nested = li.querySelector(":scope > ul, :scope > ol");
      li.insertBefore(chip, nested);
    });
  };
}
