import { describe, expect, it } from "vitest";
import { todoistColor } from "../src/todoist/colors";

describe("todoistColor", () => {
  it("maps Todoist's colour names, and nothing for none or an unknown one", () => {
    expect(todoistColor("red")).toBe("#db4035");
    expect(todoistColor("olive_green")).toBe("#afb83b");
    expect(todoistColor("charcoal")).toBe("#808080");
    expect(todoistColor(undefined)).toBeUndefined();
    expect(todoistColor("chartreuse")).toBeUndefined();
  });
});
