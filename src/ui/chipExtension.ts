import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import type { SyncState } from "../sync/state";
import { renderChip } from "./chip";

/** Dispatch to an EditorView to re-render chips after sync state changes. */
export const refreshChips = StateEffect.define<null>();

const MARKER_RE = /\s*%%td:([A-Za-z0-9_-]+)%%/g;

class ChipWidget extends WidgetType {
  constructor(private markerId: string, private state: () => SyncState, private version: number) {
    super();
  }
  eq(other: ChipWidget): boolean {
    return other.markerId === this.markerId && other.version === this.version;
  }
  toDOM(): HTMLElement {
    return renderChip(this.markerId, this.state());
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** Live-preview extension: replaces `%%td:ID%%` with a chip unless the cursor is inside it. */
export function chipExtension(getState: () => SyncState, getVersion: () => number) {
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
              Decoration.replace({ widget: new ChipWidget(m[1], getState, version) }),
            );
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
