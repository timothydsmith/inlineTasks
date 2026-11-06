import { describe, expect, it } from "vitest";
import { projectTree } from "../src/sync/projects";
import { emptyState } from "../src/sync/state";

describe("projectTree", () => {
  it("lists the Inbox first, then projects in Todoist's order, each followed by its subprojects", () => {
    const state = emptyState();
    state.projects = {
      w: { name: "Work", order: 2, parentId: null, color: "red" },
      h: { name: "Home", order: 1, parentId: null },
      c: { name: "Clients", order: 2, parentId: "w" },
      a: { name: "Admin", order: 1, parentId: "w" },
      x: { name: "Acme", order: 1, parentId: "c" },
      i: { name: "Inbox", order: 0, parentId: null, inbox: true },
      old: { name: "Old", order: 0, parentId: null, archived: true },
      gone: { name: "Under old", order: 9, parentId: "old" },
    };
    expect(projectTree(state).map((p) => [p.name, p.depth, p.path])).toEqual([
      ["Inbox", 0, ""],
      ["Home", 0, ""],
      ["Work", 0, ""],
      ["Admin", 1, "Work"],
      ["Clients", 1, "Work"],
      ["Acme", 2, "Work / Clients"],
      ["Under old", 0, "Old"], // its parent is archived, so it's listed at the top level
    ]);
    expect(projectTree(state).find((p) => p.name === "Work")?.color).toBe("red");
  });
});
