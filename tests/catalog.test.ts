import { describe, expect, it } from "vitest";
import { parseTaskLine } from "../src/parse/taskLine";
import { catalogNote } from "../src/sync/catalog";
import { emptyState } from "../src/sync/state";

const settings = { excludedFolders: ["Templates"], folderProjects: [] };

describe("catalogNote", () => {
  it("lists active projects nested as in Todoist's sidebar, as references", () => {
    const state = emptyState();
    state.projects = {
      i: { name: "Inbox", inbox: true, parentId: null, order: 0 },
      w: { name: "Work", parentId: null, order: 2 },
      c: { name: "Clients", parentId: "w", order: 1 },
      h: { name: "Home Reno", parentId: null, order: 1 },
      old: { name: "Old", archived: true, parentId: null, order: 3 },
    };
    const note = catalogNote(state, settings);
    expect(note).toContain(["## Projects", "", "- `#[Inbox]`", "- `#[Home Reno]`", "- `#[Work]`", "  - `#[Clients]`", ""].join("\n"));
    expect(note).not.toContain("#[Old]");
  });

  it("lists labels in Todoist's order, bracketed when the name needs it", () => {
    const state = emptyState();
    state.projects = { i: { name: "Inbox", inbox: true } };
    state.labels = { a: { name: "Waiting For", order: 2 }, b: { name: "PhoneCall", order: 1 }, c: { name: "phonecall", order: 3 } };
    const note = catalogNote(state, settings);
    expect(note).toContain(["## Labels", "", "- `@PhoneCall`", "- `@[Waiting For]`", ""].join("\n"));
  });

  it("flags projects a reference can't pick out", () => {
    const state = emptyState();
    state.projects = {
      a: { name: "Admin", parentId: null, order: 1 },
      b: { name: "admin", parentId: null, order: 2 },
      c: { name: "Phase [1]", parentId: null, order: 3 },
    };
    const note = catalogNote(state, settings);
    expect(note).toContain("- `#[Admin]` (another project has the same name");
    expect(note).toContain("- `#[admin]` (another project has the same name");
    expect(note).toContain("- `#[Phase [1]]` (can't be named in a reference");
  });

  it("lists folder mappings and excluded folders", () => {
    const state = emptyState();
    state.projects = { w: { name: "Work" } };
    const note = catalogNote(state, { excludedFolders: ["Templates", "Journal"], folderProjects: [{ folder: "Work", project: "Work" }] });
    expect(note).toContain("notes in these folders: `Templates`, `Journal`,");
    expect(note).toContain("| Work | Work |");
  });

  it("is kept out of sync by its frontmatter, and its example line files a task as described", () => {
    const state = emptyState();
    state.projects = { w: { name: "Work" } };
    const note = catalogNote(state, settings);
    expect(note.startsWith("---\ntodoist: false\n---\n")).toBe(true);
    const example = note.split("\n").find((l) => l.startsWith("- [ ] "))!;
    const task = parseTaskLine(example)!;
    expect(task.text).toBe("Get tiling quotes");
    expect(task.projectRef).toBe("Home Reno");
    expect(task.labelRefs).toEqual(["Waiting For"]);
    expect(task.priorityRef).toBe(2);
    expect(task.dueRef).toBe("next friday");
  });
});
