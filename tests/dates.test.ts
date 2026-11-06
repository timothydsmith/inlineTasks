import { describe, expect, it } from "vitest";
import { isoDate, quickDates } from "../src/sync/dates";

const on = (iso: string) => new Date(iso + "T09:00:00");
const dates = (iso: string) => Object.fromEntries(quickDates(on(iso)).map((q) => [q.name, q.date]));

describe("quickDates", () => {
  it("counts from a weekday", () => {
    expect(dates("2026-11-04")).toEqual({ Today: "2026-11-04", Tomorrow: "2026-11-05", "This weekend": "2026-11-07", "Next week": "2026-11-09" });
  });

  it("offers next weekend at the weekend, and next week's Monday from a Monday", () => {
    expect(dates("2026-11-07")).toMatchObject({ "Next weekend": "2026-11-14", "Next week": "2026-11-09" });
    expect(dates("2026-11-08")).toMatchObject({ "Next weekend": "2026-11-14", "Next week": "2026-11-09" });
    expect(dates("2026-11-09")).toMatchObject({ "This weekend": "2026-11-14", "Next week": "2026-11-16" });
  });

  it("crosses months and years", () => {
    expect(dates("2026-12-31")).toMatchObject({ Tomorrow: "2027-01-01", "This weekend": "2027-01-02" });
  });
});

describe("isoDate", () => {
  it("uses the local date, not UTC", () => {
    expect(isoDate(new Date(2026, 10, 6, 23, 59))).toBe("2026-11-06");
    expect(isoDate(new Date(2026, 10, 6, 0, 1))).toBe("2026-11-06");
  });
});
