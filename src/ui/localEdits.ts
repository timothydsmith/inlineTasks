import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { isLocalChange } from "../sync/origin";

/**
 * Reports notes edited in this device's editor, as opposed to changed on disk by Obsidian Sync or
 * another app. See `isLocalChange` in sync/origin.ts for the rule.
 * @param lastInputAt when the user last pressed a key or tapped/clicked anywhere in Obsidian (ms)
 */
export function localEditTracker(onLocalEdit: (path: string) => void, lastInputAt: () => number) {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const events = u.transactions.map((tr) => tr.annotation(Transaction.userEvent));
    if (!isLocalChange(events, lastInputAt(), u.view.hasFocus, Date.now())) return;
    const file = u.state.field(editorInfoField, false)?.file;
    if (file) onLocalEdit(file.path);
  });
}
