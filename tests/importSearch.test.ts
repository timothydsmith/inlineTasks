import { describe, expect, it } from "vitest";
import { rankMatches, type Searchable } from "../src/ui/importSearch";

const task = (title: string, rest = "", due: string | null = null): Searchable => ({ title, rest, due });

describe("import picker search", () => {
  const leave = task("Prepare a short December leave handover for Tim", "Work @Waiting For @person:Belinda Thompson", "2026-11-26");
  const myRecords = task("Send Tim the Finance MyRecords access request", "Admin @person:Belinda Thompson");
  const tap = task("Fix the tap", "Home", "2026-11-20");
  const all = [leave, myRecords, tap];

  it("lists everything by date, soonest first, with nothing typed", () => {
    expect(rankMatches(all, "")).toEqual([tap, leave, myRecords]);
  });

  it("matches words in any order, ignoring case", () => {
    expect(rankMatches(all, "LEAVE december")).toEqual([leave]);
    expect(rankMatches(all, "tim send")).toEqual([myRecords]);
  });

  it("finds a task by its label or project, with or without @", () => {
    expect(rankMatches(all, "belinda")).toEqual([leave, myRecords]);
    expect(rankMatches(all, "@waiting")).toEqual([leave]);
    expect(rankMatches(all, "home")).toEqual([tap]);
  });

  it("puts tasks with every word in the title before those matched by label or project", () => {
    const named = task("Ask Belinda about the budget", "Admin", "2026-12-10");
    expect(rankMatches([leave, myRecords, named], "belinda")).toEqual([named, leave, myRecords]);
  });

  it("needs every word to match somewhere", () => {
    expect(rankMatches(all, "leave tap")).toEqual([]);
  });

  it("falls back to the fuzzy search when no task has every word", () => {
    const fuzzy = (text: string) => (text.includes("tap") ? 1 : null);
    expect(rankMatches(all, "fxtp", fuzzy)).toEqual([tap]);
    expect(rankMatches(all, "leave", fuzzy)).toEqual([leave]); // a word match skips the fuzzy search
  });
});
