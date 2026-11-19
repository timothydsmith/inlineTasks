import { describe, expect, it } from "vitest";
import { emptyState, type SyncState, type TaskRecord } from "../src/sync/state";
import { copyChecker, todoistFunctions, type TasksQueryTask } from "../src/ui/queryFilter";

const line = (path: string, lineNumber: number, md: string): TasksQueryTask => ({ path, lineNumber, originalMarkdown: md });

describe("inlineTasks.isCopy", () => {
  const state: SyncState = emptyState();
  state.tasks.T1 = { path: "Home.md", copies: ["Daily.md"] } as TaskRecord;
  const tasks = [
    line("Home.md", 2, "- [ ] Plant bulbs %%td:T1%%"),
    line("Home.md", 7, "- [ ] Plant bulbs %%td:T1%%"),
    line("Daily.md", 0, "- [ ] Plant bulbs %%td:T1%%"),
    line("Home.md", 3, "- [ ] Not synced"),
    line("Home.md", 4, "- [ ] Someone else's %%td:X9%%"),
  ];
  const isCopy = copyChecker(() => state, () => tasks);

  it("is false for the task's first line in its home note", () => {
    expect(isCopy(tasks[0])).toBe(false);
  });

  it("is true for a copy in another note, or a later line in the home note", () => {
    expect(isCopy(tasks[2])).toBe(true);
    expect(isCopy(tasks[1])).toBe(true);
  });

  it("is false for lines without a marker, or tasks this device doesn't sync", () => {
    expect(isCopy(tasks[3])).toBe(false);
    expect(isCopy(tasks[4])).toBe(false);
  });

  it("follows the home when it moves", () => {
    state.tasks.T1 = { path: "Daily.md" } as TaskRecord;
    expect(isCopy(tasks[2])).toBe(false);
    expect(isCopy(tasks[0])).toBe(true);
  });
});

describe("inlineTasks label and project functions", () => {
  const state: SyncState = emptyState();
  state.projects = {
    W: { name: "Work", parentId: null },
    C: { name: "Clients", parentId: "W" },
    A: { name: "Acme", parentId: "C" },
    H: { name: "Home", parentId: null },
  } as unknown as SyncState["projects"];
  const meta = (projectId: string, labels?: string[]) => ({ projectId, priority: 1, due: null, checked: false, labels });
  state.remote.T1 = meta("A", ["PhoneCall", "context:Desk"]);
  state.remote.T2 = meta("H");
  const { labels, hasLabel, project, inProject } = todoistFunctions(() => state);
  const t1 = { originalMarkdown: "- [ ] Call Acme %%td:T1%%" };
  const t2 = { originalMarkdown: "- [ ] Fix tap %%td:T2%% ⏳ 2026-11-20" };
  const plain = { originalMarkdown: "- [ ] Not synced" };
  const unknown = { originalMarkdown: "- [ ] Elsewhere %%td:X9%%" };

  it("lists a task's Todoist labels", () => {
    expect(labels(t1)).toEqual(["PhoneCall", "context:Desk"]);
    expect(labels(t2)).toEqual([]);
    expect(labels(plain)).toEqual([]);
    expect(labels(unknown)).toEqual([]);
  });

  it("matches labels ignoring case and a leading @, any of several, or any label at all", () => {
    expect(hasLabel(t1, "phonecall")).toBe(true);
    expect(hasLabel(t1, "@PhoneCall")).toBe(true);
    expect(hasLabel(t1, "Errand", "context:desk")).toBe(true);
    expect(hasLabel(t1, "Errand")).toBe(false);
    expect(hasLabel(t1)).toBe(true);
    expect(hasLabel(t2)).toBe(false);
    expect(hasLabel(plain, "PhoneCall")).toBe(false);
  });

  it("gives a task's project as a path", () => {
    expect(project(t1)).toBe("Work/Clients/Acme");
    expect(project(t2)).toBe("Home");
    expect(project(plain)).toBe("");
  });

  it("matches a project and the projects under it, by name or path", () => {
    expect(inProject(t1, "Work")).toBe(true);
    expect(inProject(t1, "clients")).toBe(true);
    expect(inProject(t1, "Work/Clients")).toBe(true);
    expect(inProject(t1, "#[Work/Clients/Acme]")).toBe(true);
    expect(inProject(t1, "Clients/Acme")).toBe(false); // a path starts at the top
    expect(inProject(t1, "Home")).toBe(false);
    expect(inProject(t2, "Work", "Home")).toBe(true);
    expect(inProject(plain, "Work")).toBe(false);
  });
});
