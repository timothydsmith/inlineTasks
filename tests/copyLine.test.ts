import { afterEach, describe, expect, it } from "vitest";
import { setTasksGlobalFilter } from "../src/parse/taskLine";
import { copyLine } from "../src/sync/importTask";

describe("copyLine, for importing a task that's already in a note", () => {
  afterEach(() => setTasksGlobalFilter(null));

  it("copies the line with its marker and fields, as a list item at the indent", () => {
    expect(copyLine("\t\t- [ ] Water plants %%td:T1%% ⏫ 🔁 every week ⏳ 2026-11-30", "\t")).toBe(
      "\t- [ ] Water plants %%td:T1%% ⏫ 🔁 every week ⏳ 2026-11-30",
    );
    expect(copyLine("1. [/] Draft report %%td:T2%% 📅 2026-12-01", "")).toBe("- [/] Draft report %%td:T2%% 📅 2026-12-01");
  });

  it("leaves off the block link, which only one line can have", () => {
    expect(copyLine("- [ ] Plan trip %%td:T1%% ⏳ 2026-11-30 ^trip", "")).toBe("- [ ] Plan trip %%td:T1%% ⏳ 2026-11-30");
  });

  it("writes out a date the home note's name gives the task", () => {
    expect(copyLine("- [ ] Call Bob %%td:T1%%", "", "2026-11-26")).toBe("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-26");
    expect(copyLine("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-28", "", "2026-11-26")).toBe("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-28");
  });

  it("keeps Tasks' global filter where it was", () => {
    setTasksGlobalFilter("#task");
    expect(copyLine("- [ ] #task Call Bob %%td:T1%%", "")).toBe("- [ ] #task Call Bob %%td:T1%%");
  });

  it("is null for a line that isn't a synced task", () => {
    expect(copyLine("- [ ] Not synced", "")).toBeNull();
    expect(copyLine("Just text", "")).toBeNull();
  });
});
