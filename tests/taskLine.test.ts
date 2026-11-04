import { describe, expect, it } from "vitest";
import { findTasks, parseTaskLine, serializeTask } from "../src/parse/taskLine";

describe("parseTaskLine", () => {
  it("parses a plain checkbox", () => {
    const t = parseTaskLine("- [ ] Call Bob")!;
    expect(t).toMatchObject({ prefix: "- ", text: "Call Bob", checked: false, due: null, todoistId: null });
  });

  it("parses marker, due date and checked state", () => {
    const t = parseTaskLine("  * [x] Call Bob 📅 2026-11-10 %%td:6Xg4Qm2pR%%")!;
    expect(t).toMatchObject({ prefix: "  * ", text: "Call Bob", checked: true, due: "2026-11-10", todoistId: "6Xg4Qm2pR" });
  });

  it("recognises pending markers", () => {
    const t = parseTaskLine("- [ ] A %%td:new-123e4567-e89b-42d3-a456-426614174000%%")!;
    expect(t.todoistId).toBeNull();
    expect(t.pendingUuid).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  it("supports numbered lists", () => {
    expect(parseTaskLine("1. [ ] First")!.prefix).toBe("1. ");
  });

  it("flags opt-out and empty tasks as excluded", () => {
    expect(parseTaskLine("- [ ] Private #notodoist")!.excluded).toBe(true);
    expect(parseTaskLine("- [ ] ")!.excluded).toBe(true);
    expect(parseTaskLine("- [ ] Normal #work")!.excluded).toBe(false);
  });

  it("ignores non-task lines", () => {
    expect(parseTaskLine("- just a bullet")).toBeNull();
    expect(parseTaskLine("[ ] no list marker")).toBeNull();
  });
});

describe("serializeTask", () => {
  it("round-trips a canonical line", () => {
    const line = "- [ ] Call Bob 📅 2026-11-10 %%td:abc123%%";
    expect(serializeTask(parseTaskLine(line)!)).toBe(line);
  });

  it("normalises field order", () => {
    const t = parseTaskLine("- [ ] %%td:abc%% Call 📅 2026-01-02 Bob")!;
    expect(serializeTask(t)).toBe("- [ ] Call Bob 📅 2026-01-02 %%td:abc%%");
  });

  it("preserves custom checked statuses but unchecks to space", () => {
    const t = parseTaskLine("- [/] Half done")!;
    expect(serializeTask(t)).toBe("- [/] Half done");
    expect(serializeTask({ ...t, checked: false })).toBe("- [ ] Half done");
    expect(serializeTask({ ...parseTaskLine("- [ ] X")!, checked: true })).toBe("- [x] X");
  });
});

describe("findTasks", () => {
  it("skips frontmatter and code fences", () => {
    const content = [
      "---",
      "tags: [a]",
      "---",
      "- [ ] one",
      "```",
      "- [ ] in code",
      "```",
      "~~~~md",
      "- [ ] tilde code",
      "~~~~",
      "- [x] two",
    ].join("\n");
    expect(findTasks(content).map((t) => [t.line, t.task.text])).toEqual([
      [3, "one"],
      [10, "two"],
    ]);
  });
});
