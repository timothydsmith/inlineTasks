import { describe, expect, it } from "vitest";
import { holdForOtherDevice, LOCAL_WINDOW_MS, QUIET_MS } from "../src/sync/origin";

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
