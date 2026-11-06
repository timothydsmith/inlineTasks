import { EditorView } from "@codemirror/view";
import { editorInfoField, TFile } from "obsidian";
import { startsLabel } from "../parse/taskLine";

/**
 * Typing `@` on a checkbox line opens the label picker (see LabelModal). The `@` is typed as usual;
 * `onAt` then gets the editor and the `@`'s position, to open the picker and later replace the `@`.
 * Only a typed `@` counts (including from a phone keyboard's composition), not a pasted one.
 */
export function labelTrigger(enabledFor: (file: TFile) => boolean, onAt: (view: EditorView, pos: number) => void) {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged || !u.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
    let at = -1;
    let changes = 0;
    u.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
      changes++;
      if (fromA === toA && inserted.toString() === "@") at = fromB;
    });
    if (changes !== 1 || at < 0) return;
    const file = u.state.field(editorInfoField, false)?.file;
    if (!file || !enabledFor(file)) return;
    const line = u.state.doc.lineAt(at);
    if (!startsLabel(line.text, at - line.from)) return;
    // After this update finishes, but before the next key press reaches the editor.
    queueMicrotask(() => onAt(u.view, at));
  });
}
