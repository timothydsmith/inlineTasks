/**
 * Ranking for the import picker's search, kept apart from the modal so it can be tested.
 *
 * A task matches when every word typed is somewhere in its title, project, labels or date, in any
 * order and ignoring case. Those whose title has every word come first, then by date, soonest first.
 * A query that matches nothing that way falls back to `fuzzy` (Obsidian's letters-in-order search),
 * for typos and abbreviations.
 */

export interface Searchable {
  title: string;
  /** Project, labels and date: matched, but a match only here ranks below one in the title. */
  rest: string;
  due: string | null;
}

/** The query's words, lowercased; a leading `@` or `#` is dropped, so `@PhoneCall` finds the label. */
function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[@#]+/, ""))
    .filter(Boolean);
}

export function rankMatches<T extends Searchable>(
  candidates: readonly T[],
  query: string,
  fuzzy?: (text: string) => number | null,
): T[] {
  const ws = words(query);
  if (!ws.length) return byDue([...candidates]);
  const inTitle: T[] = [];
  const elsewhere: T[] = [];
  for (const c of candidates) {
    const title = c.title.toLowerCase();
    if (ws.every((w) => title.includes(w))) inTitle.push(c);
    else if (ws.every((w) => title.includes(w) || c.rest.toLowerCase().includes(w))) elsewhere.push(c);
  }
  if (inTitle.length || elsewhere.length || !fuzzy) return [...byDue(inTitle), ...byDue(elsewhere)];
  const scored: { c: T; score: number }[] = [];
  for (const c of candidates) {
    const score = fuzzy(`${c.title} ${c.rest}`);
    if (score !== null) scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
}

function byDue<T extends Searchable>(list: T[]): T[] {
  return list.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
}
