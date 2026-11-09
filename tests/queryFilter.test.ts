import { describe, expect, it } from "vitest";
import { emptyState, type SyncState, type TaskRecord } from "../src/sync/state";
import { copyChecker, type TasksQueryTask } from "../src/ui/queryFilter";

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
