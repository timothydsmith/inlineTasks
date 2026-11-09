import { describe, expect, it } from "vitest";
import { parseTaskLine } from "../src/parse/taskLine";
import { isoDate } from "../src/sync/dates";
import { historyLines, occurrenceDate, type CompletionEvent } from "../src/sync/history";

const ev = (extra: Record<string, unknown>, event_date = "2026-11-09T01:55:03Z", event_type = "completed"): CompletionEvent => ({
  object_id: "T1",
  event_type,
  event_date,
  extra_data: extra,
});

describe("occurrenceDate", () => {
  it("reads the occurrence's local date, however the key is written", () => {
    expect(occurrenceDate(ev({ completed_due_date_local: "2026-11-17T23:59:59" }))).toBe("2026-11-17");
    expect(occurrenceDate(ev({ completedDueDateLocal: "2026-11-17T23:59:59" }))).toBe("2026-11-17");
  });

  it("falls back to the UTC date, as a local date", () => {
    const utc = "2026-11-17T12:59:59.000000Z";
    expect(occurrenceDate(ev({ completed_due_date: utc }))).toBe(isoDate(new Date(utc)));
  });

  it("is null when the event doesn't say", () => {
    expect(occurrenceDate(ev({ content: "Water" }))).toBeNull();
  });
});

describe("historyLines", () => {
  const line = parseTaskLine("\t- [ ] Water %%td:T1%% ⏫ 🔁 every week ⏳ 2026-11-10 📅 2026-11-11 ^water")!;
  const at = (occ: string, when: string) => ev({ completed_due_date_local: `${occ}T23:59:59` }, when);

  it("writes the line as it was, ticked, with the occurrence's date and when it was completed, without its block link", () => {
    const when = "2026-11-12T03:00:00Z";
    expect(historyLines(line, "T1", [at("2026-11-10", when)], "2026-11-10", "2026-11-17")).toEqual([
      `\t- [x] Water ⏫ 🔁 every week ⏳ 2026-11-10 📅 2026-11-11 ✅ ${isoDate(new Date(when))}`,
    ]);
  });

  it("keeps only occurrences the pull moved past, one line each, newest first", () => {
    const lines = historyLines(
      line,
      "T1",
      [
        at("2026-11-03", "2026-11-04T00:00:00Z"), // before: already recorded
        at("2026-11-10", "2026-11-10T00:00:00Z"),
        at("2026-11-17", "2026-11-17T00:00:00Z"),
        at("2026-11-10", "2026-11-11T00:00:00Z"), // completed again after being reopened
        at("2026-11-24", "2026-11-24T00:00:00Z"), // the open occurrence
        ev({ completed_due_date_local: "2026-11-10T23:59:59" }, "2026-11-12T00:00:00Z", "uncompleted"),
      ],
      "2026-11-10",
      "2026-11-24",
    );
    expect(lines.map((l) => /⏳ (\S+)/.exec(l)![1])).toEqual(["2026-11-17", "2026-11-10"]);
    expect(lines[1]).toContain(`✅ ${isoDate(new Date("2026-11-11T00:00:00Z"))}`);
  });
});
