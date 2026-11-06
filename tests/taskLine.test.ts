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

  it("extracts #[Project] references from the text", () => {
    const t = parseTaskLine("- [ ] Send #[Old] invoice #[Home Reno] 📅 2026-11-10 #urgent")!;
    expect(t.projectRef).toBe("Home Reno"); // last one wins
    expect(t.text).toBe("Send invoice #urgent"); // ordinary tags stay
    expect(parseTaskLine("- [ ] Plain #tag")!.projectRef).toBeNull();
    expect(parseTaskLine("- [ ] Not a ref: a#[b]")!.projectRef).toBeNull();
    expect(parseTaskLine("- [ ] Empty #[ ]")!.projectRef).toBeNull();
    expect(parseTaskLine("- [ ] #[Work]")!.excluded).toBe(true); // nothing to create
  });

  it("extracts @label references from the text", () => {
    const t = parseTaskLine("- [ ] Ask @person:Sarah about @[Waiting For] it @context:Home. @phonecall @PhoneCall")!;
    expect(t.labelRefs).toEqual(["person:Sarah", "Waiting For", "context:Home", "phonecall"]); // de-duplicated
    expect(t.text).toBe("Ask about it ."); // a trailing full stop isn't part of a bare label
    expect(parseTaskLine("- [ ] Email bob@example.com")!.labelRefs).toEqual([]);
    expect(parseTaskLine("- [ ] Meet @ 5pm")!.labelRefs).toEqual([]);
    expect(parseTaskLine("- [ ] WhatsApp/SMS @WhatsApp/SMS")!.labelRefs).toEqual(["WhatsApp/SMS"]);
    expect(parseTaskLine("- [ ] @PhoneCall")!.excluded).toBe(true); // nothing to create
  });

  it("extracts a p1–p4 priority from the text", () => {
    const t = parseTaskLine("- [ ] Plan p2 roadmap P1 📅 2026-11-10")!;
    expect(t.priorityRef).toBe(1); // last one wins, either case
    expect(t.text).toBe("Plan roadmap");
    for (const line of ["- [ ] Review mp3 files", "- [ ] Use #p1 tag", "- [ ] Win p1st", "- [ ] Try p5", "- [ ] Ref (p1)"]) {
      expect(parseTaskLine(line)!.priorityRef).toBeNull();
    }
  });

  it("doesn't read references inside a bracketed name", () => {
    const t = parseTaskLine("- [ ] Plan #[Phase p1] @[Errands @home]")!;
    expect(t.projectRef).toBe("Phase p1");
    expect(t.labelRefs).toEqual(["Errands @home"]);
    expect(t.priorityRef).toBeNull();
    expect(t.text).toBe("Plan");
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

  it("keeps a project reference before the due date and marker", () => {
    const t = parseTaskLine("- [ ] Call #[Work] Bob 📅 2026-11-10 %%td:abc%%")!;
    expect(serializeTask(t)).toBe("- [ ] Call Bob #[Work] 📅 2026-11-10 %%td:abc%%");
    expect(serializeTask({ ...t, projectRef: null })).toBe("- [ ] Call Bob 📅 2026-11-10 %%td:abc%%");
  });

  it("writes labels after the text, bracketing names that need it", () => {
    const t = parseTaskLine("- [ ] Call @[Waiting For] Bob #[Work] @PhoneCall 📅 2026-11-10")!;
    expect(serializeTask(t)).toBe("- [ ] Call Bob @[Waiting For] @PhoneCall #[Work] 📅 2026-11-10");
    expect(serializeTask({ ...t, labelRefs: ["done."] })).toBe("- [ ] Call Bob @[done.] #[Work] 📅 2026-11-10");
  });

  it("writes a priority straight after the text", () => {
    const t = parseTaskLine("- [ ] Call p2 Bob @PhoneCall 📅 2026-11-10 %%td:abc%%")!;
    expect(serializeTask(t)).toBe("- [ ] Call Bob p2 @PhoneCall 📅 2026-11-10 %%td:abc%%");
    expect(serializeTask({ ...t, priorityRef: null })).toBe("- [ ] Call Bob @PhoneCall 📅 2026-11-10 %%td:abc%%");
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
