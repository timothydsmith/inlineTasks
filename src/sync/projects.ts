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
  /** Its parents' names and its own, outermost first: ["Work", "Clients", "Acme"]. */
  names: string[];
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
    const parents = parentNames(state, p.parentId);
    out.push({ id, name: p.name, color: p.color, depth, path: parents.join(" / "), names: [...parents, p.name] });
    for (const kid of kids.get(id) ?? []) visit(kid, depth + 1);
  };
  for (const id of kids.get(null) ?? []) visit(id, 0);
  return out;
}

/** The names of a project's parent projects, outermost first, e.g. "Work / Clients". */
export function projectPath(state: SyncState, parentId: string | null | undefined): string {
  return parentNames(state, parentId).join(" / ");
}

/** The names of a project's parent projects, outermost first. */
function parentNames(state: SyncState, parentId: string | null | undefined): string[] {
  const names: string[] = [];
  for (let id = parentId, guard = 0; id && state.projects[id] && guard < 10; id = state.projects[id].parentId, guard++) {
    names.unshift(state.projects[id].name);
  }
  return names;
}

/** Comparison key for project names: case- and whitespace-insensitive (as projectKey in engine.ts). */
const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The project names in a `#[…]` reference: `Work/Clients/Acme` names Acme, under Clients, under
 * Work. A name without a `/` is a path of one.
 */
export function splitProjectPath(ref: string): string[] {
  return ref
    .split("/")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/** Active projects with this name, at any level. */
function named(state: SyncState, name: string): string[] {
  const key = nameKey(name);
  return Object.entries(state.projects)
    .filter(([, p]) => !p.archived && nameKey(p.name) === key)
    .map(([id]) => id);
}

/** The active subproject of `parentId` with this name. */
export function childProject(state: SyncState, parentId: string, name: string): string | undefined {
  const key = nameKey(name);
  return Object.entries(state.projects).find(([, p]) => !p.archived && p.parentId === parentId && nameKey(p.name) === key)?.[0];
}

/**
 * The active project a `#[…]` reference names: the one with that exact name, or else the end of a
 * path of nested projects, `Work/Clients/Acme`, whose first name can be a project at any level.
 */
export function findProjectId(state: SyncState, ref: string): string | undefined {
  const exact = named(state, ref)[0];
  if (exact) return exact;
  const parts = splitProjectPath(ref);
  if (!parts.length) return undefined;
  for (const first of named(state, parts[0])) {
    let id: string | undefined = first;
    for (const part of parts.slice(1)) id = id && childProject(state, id, part);
    if (id) return id;
  }
  return undefined;
}

/**
 * How a reference can name this project: its name, or its path, `Work/Clients/Acme`, when another
 * project has the same name. Undefined if neither names only it, or it can't be written in one.
 */
export function projectRef(state: SyncState, id: string): string | undefined {
  const p = state.projects[id];
  if (!p || p.name.includes("]")) return undefined;
  if (named(state, p.name).length === 1) return p.name;
  const names: string[] = [];
  for (let x: string | null | undefined = id, guard = 0; x && state.projects[x] && guard < 10; x = state.projects[x].parentId, guard++) {
    names.unshift(state.projects[x].name);
  }
  if (names.some((n) => n.includes("/") || n.includes("]"))) return undefined;
  const path = names.join("/");
  return findProjectId(state, path) === id ? path : undefined;
}

/**
 * What creating a reference's project would make: the project, the projects it goes under, and
 * which of those don't exist yet and would be created too.
 */
export function projectPlan(state: SyncState, ref: string): { name: string; parents: string[]; missing: string[] } {
  const parts = splitProjectPath(ref);
  const parents = parts.slice(0, -1);
  let id: string | undefined = parents.length ? named(state, parents[0])[0] : undefined;
  let found = id ? 1 : 0;
  for (const part of parents.slice(1)) {
    id = id && childProject(state, id, part);
    if (!id) break;
    found++;
  }
  return { name: parts[parts.length - 1] ?? "", parents, missing: parents.slice(found) };
}
