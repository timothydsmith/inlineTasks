import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import type { SyncState } from "../sync/state";
import { renderChip } from "./chip";
import { chipAction, type ChipActions } from "./chipActions";

/** Dispatch to an EditorView to re-render chips after sync state changes. */
export const refreshChips = StateEffect.define<null>();

const MARKER_RE = /\s*%%td:([A-Za-z0-9_-]+)%%/g;

class ChipWidget extends WidgetType {
  constructor(
    private markerId: string,
    private state: () => SyncState,
    private version: number,
    private actions: ChipActions,
  ) {
    super();
  }
  eq(other: ChipWidget): boolean {
    return other.markerId === this.markerId && other.version === this.version;
  }
  toDOM(): HTMLElement {
    const chip = renderChip(this.markerId, this.state()) as HTMLAnchorElement;
    // CodeMirror would otherwise handle mousedown by moving the cursor into the marker, which
    // removes the chip before the click lands. Swallow it here and open the link ourselves.
    // The raw marker stays reachable with the keyboard or by clicking just beside the chip.
    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The subtask count and the project have their own actions; the rest opens the task in Todoist.
      const action = chipAction(e.target, this.actions);
      if (action) action(this.markerId);
      else if (chip.href) window.open(chip.href, "_blank");
    });
    return chip;
  }
  ignoreEvent(e: Event): boolean {
    // true = CodeMirror leaves the event alone; the chip's own handlers deal with mouse events.
    return e.type.startsWith("mouse") || e.type === "click";
  }
}

/** Live-preview extension: replaces `%%td:ID%%` with a chip unless the cursor is inside it. */
export function chipExtension(getState: () => SyncState, getVersion: () => number, actions: ChipActions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.startState.field(editorLivePreviewField) !== u.state.field(editorLivePreviewField) ||
          u.transactions.some((t) => t.effects.some((e) => e.is(refreshChips)))
        ) {
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        if (!view.state.field(editorLivePreviewField)) return builder.finish();
        const sel = view.state.selection;
        const version = getVersion();
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          MARKER_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = MARKER_RE.exec(text))) {
            const start = from + m.index;
            const end = start + m[0].length;
            if (sel.ranges.some((r) => r.from <= end && r.to >= start)) continue; // let the user edit it
            builder.add(
              start,
              end,
              Decoration.replace({ widget: new ChipWidget(m[1], getState, version, actions) }),
            );
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
