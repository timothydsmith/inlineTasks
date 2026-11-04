import { describe, expect, it } from "vitest";
import { INPUT_WINDOW_MS, isLocalChange, LOCAL_WINDOW_MS, OriginTracker, QUIET_MS } from "../src/sync/origin";

describe("isLocalChange", () => {
  const now = 1_000_000_000;

  it("counts typing, paste and delete as local", () => {
    for (const ev of ["input.type", "input.paste", "delete.backward", "undo"]) {
      expect(isLocalChange([ev], 0, false, now)).toBe(true);
    }
  });

  it("does not count a synced change to a focused but idle editor", () => {
    // The desktop sits focused on the note while the user types on the phone.
    expect(isLocalChange([undefined], now - 30_000, true, now)).toBe(false);
  });

  it("counts an unannotated change right after a tap in the focused editor (ticking a checkbox)", () => {
    expect(isLocalChange([undefined], now - 200, true, now)).toBe(true);
  });

  it("does not count a change right after input elsewhere, when the editor isn't focused", () => {
    expect(isLocalChange([undefined], now - 200, false, now)).toBe(false);
    expect(isLocalChange([undefined], now - INPUT_WINDOW_MS, true, now)).toBe(false);
  });

  it("does not count Obsidian reloading a synced change into the editor ('set')", () => {
    expect(isLocalChange(["set"], now - 30_000, true, now)).toBe(false);
  });

  it("ignores selection-only events", () => {
    expect(isLocalChange(["select.pointer"], 0, true, now)).toBe(false);
  });
});

describe("OriginTracker", () => {
  const t0 = 1_000_000_000;

  it("pushes a note just saved after typing here", () => {
    const o = new OriginTracker();
    o.localEdit("a.md", t0);
    expect(o.modified("a.md", "x", t0 + 2_000)).toBe("local");
    expect(o.status("a.md", t0 + 5_000)).toEqual({ hold: false, fromElsewhere: false });
  });

  it("holds a note changed on another device, then pushes it without being 'local'", () => {
    const o = new OriginTracker();
    expect(o.modified("a.md", "x", t0)).toBe("elsewhere");
    expect(o.status("a.md", t0 + 5_000)).toEqual({ hold: true, fromElsewhere: true });
    expect(o.status("a.md", t0 + QUIET_MS)).toEqual({ hold: false, fromElsewhere: true });
  });

  it("treats a synced change after an older local edit as from elsewhere", () => {
    const o = new OriginTracker();
    o.localEdit("a.md", t0);
    expect(o.modified("a.md", "x", t0 + LOCAL_WINDOW_MS + 1)).toBe("elsewhere");
    expect(o.status("a.md", t0 + LOCAL_WINDOW_MS + 2).hold).toBe(true);
  });

  it("recognises the plugin's own write and leaves the origin alone", () => {
    const o = new OriginTracker();
    o.modified("a.md", "typed on phone", t0);
    o.ownWrite("a.md", "typed on phone %%td:1%%");
    // Long after any local edit: the plugin's own marker write mustn't make synced changes look local.
    expect(o.modified("a.md", "typed on phone %%td:1%%", t0 + QUIET_MS + 1)).toBe("own");
    expect(o.status("a.md", t0 + QUIET_MS + 2)).toEqual({ hold: false, fromElsewhere: true });
    // The next synced change is still from elsewhere.
    expect(o.modified("a.md", "more from phone", t0 + QUIET_MS + 3)).toBe("elsewhere");
  });

  it("editing here after a synced change makes the note local again", () => {
    const o = new OriginTracker();
    o.modified("a.md", "x", t0);
    o.localEdit("a.md", t0 + 1_000);
    expect(o.status("a.md", t0 + 1_500)).toEqual({ hold: false, fromElsewhere: false });
  });

  it("follows renames", () => {
    const o = new OriginTracker();
    o.modified("a.md", "x", t0);
    o.rename("a.md", "b.md");
    expect(o.status("b.md", t0 + 1).hold).toBe(true);
    expect(o.status("a.md", t0 + 1).hold).toBe(false);
  });
});
