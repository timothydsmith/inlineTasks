import { describe, expect, it } from "vitest";
import { matchResult, type TasksCacheTask } from "../src/ui/queryChips";

const task = (line: string, path = "Notes/Garden.md", symbol = " "): TasksCacheTask => {
  const body = line.replace(/^- \[.\] /, "");
  return {
    originalMarkdown: line,
    description: body.replace(/ [⏳📅🔁⏫🔼🔺✅].*$/u, ""),
    status: { symbol },
    taskLocation: { path },
  };
};

describe("matchResult", () => {
  const tasks = [
    task("- [ ] Plant bulbs %%td:A1%% ⏳ 2026-11-14"),
    task("- [ ] Water [[Roses|the roses]] **today** %%td:B2%%"),
    task("- [ ] Plant bulbs %%td:C3%%", "Daily/2026-11-09.md"),
    task("- [x] Plant bulbs %%td:D4%%", "Notes/Garden.md", "x"),
    task("- [ ] Plant bulbs"),
  ];

  it("finds the task by its text, status and note", () => {
    expect(matchResult("Plant bulbs ", " ", "Garden", tasks)).toEqual({ id: "A1", path: "Notes/Garden.md" });
    expect(matchResult("Plant bulbs", "x", "Garden", tasks)).toEqual({ id: "D4", path: "Notes/Garden.md" });
    expect(matchResult("Plant bulbs", "", "2026-11-09 > Morning", tasks)).toEqual({ id: "C3", path: "Daily/2026-11-09.md" });
  });

  it("compares rendered links and formatting with their source", () => {
    expect(matchResult("Water the roses today", " ", "Garden", tasks)?.id).toBe("B2");
  });

  it("matches nothing when two Todoist tasks fit, as with backlinks hidden", () => {
    expect(matchResult("Plant bulbs", " ", null, tasks)).toBeNull();
  });

  it("matches copies of one task, without a note when they're in several", () => {
    const copies = [task("- [ ] Seed %%td:E5%%"), task("- [ ] Seed %%td:E5%%", "Daily/2026-11-09.md")];
    expect(matchResult("Seed", " ", null, copies)).toEqual({ id: "E5", path: undefined });
  });

  it("ignores tasks without a marker", () => {
    expect(matchResult("Plant bulbs", " ", "Garden", [task("- [ ] Plant bulbs")])).toBeNull();
  });
});
