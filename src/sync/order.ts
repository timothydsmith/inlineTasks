import { generateKeyBetween } from "fractional-indexing";
import { blockEnd, findTasks, parentLine } from "../parse/taskLine";

/**
 * Subtask order. Todoist sorts a task's subtasks by `order_key`, a fractional-indexing key
 * compared character by character (falling back to `child_order` for tasks that don't have a key
 * yet). A reorder gives just the moved task a new key between its new neighbours.
 */

export interface Sibling {
  id: string;
  key: string | null | undefined;
  childOrder?: number;
}

/** Todoist's order for two siblings: by order key, else by child order. */
export function compareSiblings(a: Sibling, b: Sibling): number {
  if (a.key && b.key) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  return (a.childOrder ?? 0) - (b.childOrder ?? 0);
}

export function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** `ids` in the order they appear in `order`, leaving out ids not in it. */
export function inOrderOf(ids: string[], order: string[]): string[] {
  const keep = new Set(ids);
  return order.filter((id) => keep.has(id));
}

/**
 * New order keys that put `wanted` (some of the siblings, as ordered in the note) in that order
 * among `siblings` (all of them, in Todoist's order), moving as few tasks as possible: the longest
 * run already in order stays put. Siblings not in `wanted` keep their places. Null if a key can't
 * be worked out, such as for tasks without order keys.
 */
export function reorderKeys(siblings: Sibling[], wanted: string[]): Map<string, string> | null {
  const work = [...siblings];
  const at = (id: string) => work.findIndex((s) => s.id === id);
  const ids = wanted.filter((id) => at(id) >= 0);
  const kept = longestInOrder(ids.map(at));
  const keep = new Set(kept.map((i) => ids[i]));
  const out = new Map<string, string>();
  try {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (keep.has(id)) continue;
      const moving = work.splice(at(id), 1)[0];
      let slot: number; // index in `work` to insert at
      if (i > 0) {
        slot = at(ids[i - 1]) + 1; // straight after the one before it in the note
      } else {
        const next = ids.slice(1).find((x) => keep.has(x))!; // there's always one kept
        slot = at(next); // straight before the first one that stays put
      }
      const lower = work[slot - 1]?.key ?? null;
      const upper = work[slot]?.key ?? null;
      if ((slot > 0 && !lower) || (slot < work.length && !upper)) return null;
      const key = generateKeyBetween(lower, upper);
      work.splice(slot, 0, { ...moving, key });
      out.set(id, key);
    }
  } catch {
    return null; // keys out of order or not in the expected format
  }
  return out;
}

/** Indexes (into `seq`) of a longest strictly increasing subsequence of `seq`. */
function longestInOrder(seq: number[]): number[] {
  const tails: number[] = []; // index into seq of the smallest tail of each length
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = prev[i]) out.unshift(i);
  return out;
}

/**
 * Move the task on line `from`, with everything nested under it, re-indented to its new place:
 * under the task whose id is `parentId`, after the subtasks of it whose ids are in `before`
 * (those ahead of it in Todoist's order), or first among them; or, for a null `parentId`, out
 * to the top level of the list it's in, just after the block it was in. Null if there's no such
 * place (the parent's line isn't in `lines`) or it's already top-level.
 */
export function moveBlock(
  lines: string[],
  from: number,
  parentId: string | null,
  before: Set<string>,
  tab: string,
  idOf: (line: string) => string | null,
): string[] | null {
  const ws = (l: string) => /^\s*/.exec(l)![0];
  const taskLines = new Set(findTasks(lines.join("\n")).map((t) => t.line));
  let top = from; // outermost checkbox it's nested under
  for (let p = parentLine(lines, top, taskLines); p !== null; p = parentLine(lines, p, taskLines)) top = p;
  if (!parentId && top === from) return null;

  const end = blockEnd(lines, from);
  const block = lines.slice(from, end + 1);
  const rest = [...lines.slice(0, from), ...lines.slice(end + 1)];
  let indent: string;
  let after: number;
  if (parentId) {
    const p = rest.findIndex((l) => idOf(l) === parentId);
    if (p < 0) return null;
    indent = ws(rest[p]) + tab;
    after = p;
    for (const l of childLines(rest, p)) {
      const id = idOf(rest[l]);
      if (id && before.has(id)) after = blockEnd(rest, l);
    }
  } else {
    indent = ws(rest[top]); // `top` is above the block, so removing it didn't shift
    after = blockEnd(rest, top);
  }
  const base = ws(lines[from]);
  const moved = block.map((l) => (l.startsWith(base) ? indent + l.slice(base.length) : l));
  return [...rest.slice(0, after + 1), ...moved, ...rest.slice(after + 1)];
}

/** The direct subtask lines of the task on line `parent`: their line numbers, in order. */
export function childLines(lines: string[], parent: number): number[] {
  const taskLines = new Set(findTasks(lines.join("\n")).map((t) => t.line));
  const end = blockEnd(lines, parent);
  const out: number[] = [];
  for (let i = parent + 1; i <= end; i++) if (taskLines.has(i) && parentLine(lines, i, taskLines) === parent) out.push(i);
  return out;
}

/**
 * Rearrange the subtask lines under line `parent`, each with the lines nested under it, so that
 * the linked ones (`idOf` gives a line's task id) follow `order`. Other subtask lines keep their
 * places. Null if nothing would change, or if anything other than subtasks (text, a plain bullet,
 * a blank line) sits between them, since there'd be no telling where it belongs.
 */
export function reorderBlocks(
  lines: string[],
  parent: number,
  order: string[],
  idOf: (line: string) => string | null,
): string[] | null {
  const kids = childLines(lines, parent);
  if (!kids.length) return null;
  const blocks = kids.map((k) => ({ id: idOf(lines[k]), lines: lines.slice(k, blockEnd(lines, k) + 1) }));
  // The subtasks' blocks must cover everything nested under the parent, with nothing between them.
  let next = parent + 1;
  for (let b = 0; b < kids.length; b++) {
    if (kids[b] !== next) return null;
    next += blocks[b].lines.length;
  }
  if (next !== blockEnd(lines, parent) + 1) return null;

  const rank = new Map(order.map((id, i) => [id, i]));
  const linked = blocks.filter((b) => b.id && rank.has(b.id)).sort((a, b) => rank.get(a.id!)! - rank.get(b.id!)!);
  let li = 0;
  const arranged = blocks.map((b) => (b.id && rank.has(b.id) ? linked[li++] : b));
  if (arranged.every((b, i) => b === blocks[i])) return null;
  return [...lines.slice(0, parent + 1), ...arranged.flatMap((b) => b.lines), ...lines.slice(next)];
}
