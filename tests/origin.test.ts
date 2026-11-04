import { describe, expect, it } from "vitest";
import { holdForOtherDevice, INPUT_WINDOW_MS, isLocalChange, LOCAL_WINDOW_MS, QUIET_MS } from "../src/sync/origin";

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

  it("ignores selection-only events", () => {
    expect(isLocalChange(["select.pointer"], 0, true, now)).toBe(false);
  });
});

describe("holdForOtherDevice", () => {
  const now = 1_000_000_000;

  it("pushes a note just saved after typing in this editor", () => {
    expect(holdForOtherDevice(now - 2_500, now - 500, now)).toBe(false);
  });

  it("holds a note just changed on another device (never edited here)", () => {
    expect(holdForOtherDevice(undefined, now - 5_000, now)).toBe(true);
  });

  it("holds a note changed elsewhere after an older local edit", () => {
    const syncedAt = now - 5_000;
    expect(holdForOtherDevice(syncedAt - LOCAL_WINDOW_MS - 1, syncedAt, now)).toBe(true);
  });

  it("pushes a note changed elsewhere once it has been quiet long enough", () => {
    expect(holdForOtherDevice(undefined, now - QUIET_MS, now)).toBe(false);
  });
});
