import { describe, expect, it } from "vitest";
import { fileDate } from "../src/sync/fileDate";
import { parseTaskLine, serializeTask } from "../src/parse/taskLine";

describe("fileDate", () => {
  const on = { enabled: true, folders: [], format: "" };

  it("reads YYYY-MM-DD or YYYYMMDD from the note's name, as Tasks does", () => {
    expect(fileDate("Daily/2026-11-09.md", on)).toBe("2026-11-09");
    expect(fileDate("Meeting 20261109 notes.md", on)).toBe("2026-11-09");
    expect(fileDate("2026-11/Notes.md", on)).toBeNull(); // the folder doesn't count
    expect(fileDate("Daily/2026-02-30.md", on)).toBeNull();
  });

  it("does nothing unless it's on in Tasks", () => {
    expect(fileDate("2026-11-09.md", { ...on, enabled: false })).toBeNull();
    expect(fileDate("2026-11-09.md", null)).toBeNull();
  });

  it("only looks in Tasks' folders, when it names some", () => {
    const daily = { ...on, folders: ["Daily/"] };
    expect(fileDate("Daily/2026-11-09.md", daily)).toBe("2026-11-09");
    expect(fileDate("Daily/2026/2026-11-09.md", daily)).toBe("2026-11-09");
    expect(fileDate("Work/2026-11-09.md", daily)).toBeNull();
  });

  it("tries Tasks' format first", () => {
    const parse = (name: string, format: string) => (format === "DD.MM.YYYY" && name === "09.11.2026" ? "2026-11-09" : null);
    expect(fileDate("09.11.2026.md", { ...on, format: "DD.MM.YYYY" }, parse)).toBe("2026-11-09");
    expect(fileDate("2026-11-10.md", { ...on, format: "DD.MM.YYYY" }, parse)).toBe("2026-11-10");
  });
});

describe("a line in a note named for a date", () => {
  it("has the note's date when it has no date of its own, without writing it", () => {
    const t = parseTaskLine("- [ ] Call Bob %%td:T1%% ⏫", "2026-11-09")!;
    expect(t).toMatchObject({ due: "2026-11-09", inferredDue: "2026-11-09" });
    expect(serializeTask(t)).toBe("- [ ] Call Bob %%td:T1%% ⏫");
    expect(serializeTask({ ...t, due: "2026-11-12" })).toBe("- [ ] Call Bob %%td:T1%% ⏫ ⏳ 2026-11-12");
  });

  it("keeps its own ⏳, 📅 or 🛫 date, and then takes none from the name", () => {
    expect(parseTaskLine("- [ ] A ⏳ 2026-11-12", "2026-11-09")).toMatchObject({ due: "2026-11-12" });
    expect(parseTaskLine("- [ ] A ⏳ 2026-11-09", "2026-11-09")!.inferredDue).toBeUndefined();
    expect(parseTaskLine("- [ ] A 📅 2026-11-20", "2026-11-09")).toMatchObject({ due: null, deadline: "2026-11-20" });
    expect(parseTaskLine("- [ ] A 🛫 2026-11-05", "2026-11-09")).toMatchObject({ due: null });
  });

  it("writes the date once a deadline would stop Tasks taking it from the name", () => {
    const t = parseTaskLine("- [ ] A", "2026-11-09")!;
    expect(serializeTask({ ...t, deadline: "2026-11-20" })).toBe("- [ ] A ⏳ 2026-11-09 📅 2026-11-20");
  });
});
