import type { SyncState } from "./state";

export interface ProjectNode {
  id: string;
  name: string;
  /** Todoist colour name. */
  color?: string;
  /** How deeply it's nested: 0 for a top-level project. */
  depth: number;
  /** Its parent projects, e.g. "Work / Clients"; empty for a top-level project. */
  path: string;
}

/**
 * Active (not archived) projects as Todoist's sidebar lists them: the Inbox first, then each
 * project in Todoist's order, followed by its subprojects. A project whose parent isn't active is
 * listed at the top level.
 */
export function projectTree(state: SyncState): ProjectNode[] {
  const active = Object.entries(state.projects).filter(([, p]) => !p.archived);
  const ids = new Set(active.map(([id]) => id));
  const kids = new Map<string | null, string[]>();
  for (const [id, p] of active) {
    const parent = p.parentId && ids.has(p.parentId) ? p.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), id]);
  }
  const rank = (id: string) => {
    const p = state.projects[id];
    return p.inbox ? -1 : (p.order ?? Number.MAX_SAFE_INTEGER);
  };
  for (const list of kids.values()) {
    list.sort((a, b) => rank(a) - rank(b) || state.projects[a].name.localeCompare(state.projects[b].name));
  }
  const out: ProjectNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id)) return; // a loop in the parents; shouldn't happen
    seen.add(id);
    const p = state.projects[id];
    out.push({ id, name: p.name, color: p.color, depth, path: projectPath(state, p.parentId) });
    for (const kid of kids.get(id) ?? []) visit(kid, depth + 1);
  };
  for (const id of kids.get(null) ?? []) visit(id, 0);
  return out;
}

/** The names of a project's parent projects, outermost first, e.g. "Work / Clients". */
export function projectPath(state: SyncState, parentId: string | null | undefined): string {
  const names: string[] = [];
  for (let id = parentId, guard = 0; id && state.projects[id] && guard < 10; id = state.projects[id].parentId, guard++) {
    names.unshift(state.projects[id].name);
  }
  return names.join(" / ");
}
