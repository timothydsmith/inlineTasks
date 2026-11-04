import { describe, expect, it } from "vitest";
import { merge } from "../src/sync/merge";

const base = { text: "Call Bob", checked: false, due: null as string | null };

describe("merge", () => {
  it("no changes → nothing to do", () => {
    const m = merge(base, base, base, 0, 0);
    expect(m.push).toEqual({});
    expect(m.pull).toEqual({});
  });

  it("local-only change is pushed", () => {
    const m = merge(base, { ...base, checked: true }, base, 0, 0);
    expect(m.push).toEqual({ checked: true });
    expect(m.pull).toEqual({});
    expect(m.merged.checked).toBe(true);
  });

  it("remote-only change is pulled", () => {
    const m = merge(base, base, { ...base, due: "2026-11-10" }, 0, 0);
    expect(m.pull).toEqual({ due: "2026-11-10" });
    expect(m.push).toEqual({});
  });

  it("independent changes on different fields both apply", () => {
    const m = merge(base, { ...base, text: "Call Bob re contract" }, { ...base, checked: true }, 0, 0);
    expect(m.push).toEqual({ text: "Call Bob re contract" });
    expect(m.pull).toEqual({ checked: true });
    expect(m.conflicts).toEqual([]);
  });

  it("same change on both sides is not a conflict", () => {
    const m = merge(base, { ...base, checked: true }, { ...base, checked: true }, 0, 0);
    expect(m.push).toEqual({});
    expect(m.pull).toEqual({});
    expect(m.conflicts).toEqual([]);
  });

  it("text conflict: newer side wins", () => {
    const local = { ...base, text: "local" };
    const remote = { ...base, text: "remote" };
    expect(merge(base, local, remote, 200, 100).push).toEqual({ text: "local" });
    expect(merge(base, local, remote, 100, 200).pull).toEqual({ text: "remote" });
  });

  it("completion changed on both sides always agrees (boolean), so never conflicts", () => {
    const m = merge(base, { ...base, checked: true }, { ...base, checked: true }, 0, 999);
    expect(m.conflicts).toEqual([]);
    expect(m.merged.checked).toBe(true);
  });

  it("due date cleared locally while changed remotely: newer wins", () => {
    const b = { ...base, due: "2026-11-01" };
    const m = merge(b, { ...b, due: null }, { ...b, due: "2026-11-05" }, 500, 100);
    expect(m.push).toEqual({ due: null });
    expect(m.conflicts).toEqual(["due"]);
  });
});
