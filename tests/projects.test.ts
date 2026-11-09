import { describe, expect, it } from "vitest";
import { findProjectId, projectPlan, projectRef, projectTree, splitProjectPath } from "../src/sync/projects";
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

describe("project paths", () => {
  const state = emptyState();
  state.projects = {
    w: { name: "Work", parentId: null },
    h: { name: "Home", parentId: null },
    wa: { name: "Admin", parentId: "w" },
    ha: { name: "Admin", parentId: "h" },
    c: { name: "Clients", parentId: "w" },
    x: { name: "Acme", parentId: "c" },
    s: { name: "A/B", parentId: null },
  };

  it("splits a reference into project names", () => {
    expect(splitProjectPath(" Work / Clients/  Acme Ltd ")).toEqual(["Work", "Clients", "Acme Ltd"]);
    expect(splitProjectPath("Work/")).toEqual(["Work"]);
  });

  it("finds a project by name, or by a path whose first name is at any level", () => {
    expect(findProjectId(state, "acme")).toBe("x");
    expect(findProjectId(state, "Work/Clients/Acme")).toBe("x");
    expect(findProjectId(state, "Clients/Acme")).toBe("x");
    expect(findProjectId(state, "Home/Admin")).toBe("ha");
    expect(findProjectId(state, "Work/Admin")).toBe("wa");
    expect(findProjectId(state, "A/B")).toBe("s"); // a name with a slash matches first
    expect(findProjectId(state, "Home/Clients")).toBeUndefined();
  });

  it("names a project by its path only when another shares its name", () => {
    expect(projectRef(state, "x")).toBe("Acme");
    expect(projectRef(state, "ha")).toBe("Home/Admin");
    expect(projectRef(state, "wa")).toBe("Work/Admin");
  });

  it("says which parents creating a path would make too", () => {
    expect(projectPlan(state, "Work/Clients/Beta")).toEqual({ name: "Beta", parents: ["Work", "Clients"], missing: [] });
    expect(projectPlan(state, "Work/Partners/Beta")).toEqual({ name: "Beta", parents: ["Work", "Partners"], missing: ["Partners"] });
    expect(projectPlan(state, "Garden/Beds")).toEqual({ name: "Beds", parents: ["Garden"], missing: ["Garden"] });
    expect(projectPlan(state, "Beta")).toEqual({ name: "Beta", parents: [], missing: [] });
  });
});
