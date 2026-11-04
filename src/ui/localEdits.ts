import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";

/**
 * Reports notes edited in this device's editor, as opposed to changed on disk by Obsidian Sync or
 * another app (see sync/origin.ts). A change counts as local if CodeMirror marks it as user input
 * (typing, paste, delete, undo, ...) or if it happens while the editor has focus, which covers
 * edits Obsidian makes on the user's behalf, such as ticking a checkbox.
 */
export function localEditTracker(onLocalEdit: (path: string) => void) {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const byUser = u.transactions.some((tr) => {
      const ev = tr.annotation(Transaction.userEvent);
      return !!ev && !ev.startsWith("select");
    });
    if (!byUser && !u.view.hasFocus) return;
    const file = u.state.field(editorInfoField, false)?.file;
    if (file) onLocalEdit(file.path);
  });
}
