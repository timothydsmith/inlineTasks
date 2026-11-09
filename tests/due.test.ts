import { describe, expect, it } from "vitest";
import { dueAt, dueDate, dueParts } from "../src/todoist/client";

describe("dueParts", () => {
  it("reads a date alone, a floating time, and a time fixed to a timezone", () => {
    expect(dueParts({ date: "2026-11-20" })).toEqual({ date: "2026-11-20", time: null, timezone: null });
    expect(dueParts({ date: "2026-11-20T09:30:00" })).toEqual({ date: "2026-11-20", time: "09:30:00", timezone: null });
    expect(dueParts({ date: "2026-11-19T22:00:00Z", timezone: "Australia/Melbourne" })).toEqual({
      date: "2026-11-20",
      time: "09:00:00",
      timezone: "Australia/Melbourne",
    });
    expect(dueParts({ date: "2026-11-19T22:00:00Z" })).toEqual({ date: "2026-11-19", time: "22:00:00", timezone: "UTC" });
    expect(dueParts(null)).toBeNull();
  });

  it("falls back to UTC for a timezone it doesn't know", () => {
    expect(dueParts({ date: "2026-11-19T22:00:00Z", timezone: "Nowhere/Special" })).toEqual({ date: "2026-11-19", time: "22:00:00", timezone: "UTC" });
  });

  it("gives dueDate the day in the task's timezone", () => {
    expect(dueDate({ date: "2026-11-19T22:00:00Z", timezone: "Australia/Melbourne" })).toBe("2026-11-20");
    expect(dueDate({ date: "2026-11-20T23:59:59" })).toBe("2026-11-20");
  });
});

describe("dueAt", () => {
  it("puts a kept time on a new date", () => {
    expect(dueAt("2026-11-22")).toEqual({ date: "2026-11-22" });
    expect(dueAt("2026-11-22", "09:00:00")).toEqual({ date: "2026-11-22T09:00:00" });
    expect(dueAt("2026-11-22", "09:00:00", "Australia/Melbourne")).toEqual({ date: "2026-11-21T22:00:00Z", timezone: "Australia/Melbourne" });
  });

  it("keeps the wall time across a daylight-saving change", () => {
    // Melbourne moves from UTC+10 to UTC+11 on 4 October 2026: 9am is 23:00 UTC before, 22:00 after.
    expect(dueAt("2026-10-03", "09:00:00", "Australia/Melbourne").date).toBe("2026-10-02T23:00:00Z");
    expect(dueAt("2026-10-05", "09:00:00", "Australia/Melbourne").date).toBe("2026-10-04T22:00:00Z");
    expect(dueAt("2026-07-01", "09:00:00", "Europe/London").date).toBe("2026-07-01T08:00:00Z");
    expect(dueAt("2026-12-01", "09:00:00", "Europe/London").date).toBe("2026-12-01T09:00:00Z");
  });
});
