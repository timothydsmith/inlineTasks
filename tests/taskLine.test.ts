import { describe, expect, it } from "vitest";
import { findTasks, parentLine, parseTaskLine, serializeTask, withProjectRef, withTitle } from "../src/parse/taskLine";

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

  it("extracts a due date in words", () => {
    const cases: [string, string | null, string][] = [
      ["- [ ] Call Bob today about it", "today", "Call Bob about it"],
      ["- [ ] Send invoice Next  Friday.", "Next Friday", "Send invoice ."],
      ["- [ ] Pay rent every month", "every month", "Pay rent"],
      ["- [ ] Gym every monday", "every monday", "Gym"],
      ["- [ ] Plan next week", "next week", "Plan"],
      ["- [ ] Renew passport 15/11", "15/11", "Renew passport"],
      ["- [ ] Renew 1/2/2027", "1/2/2027", "Renew"],
      ["- [ ] Lunch friday then saturday", "saturday", "Lunch then"], // last wins
      ["- [ ] Buy sun cream on sat", null, "Buy sun cream on sat"], // no abbreviations
      ["- [ ] Check 31/13 and 15/11x", null, "Check 31/13 and 15/11x"],
      ["- [ ] Fridays are long", null, "Fridays are long"],
    ];
    for (const [line, dueRef, text] of cases) {
      const t = parseTaskLine(line)!;
      expect([t.dueRef, t.text]).toEqual([dueRef, text]);
    }
  });

  it("reads only what follows a synced title for references", () => {
    const line = "- [ ] Call Bob today p2 📅 2026-11-10 %%td:abc%%";
    const plain = parseTaskLine(line)!;
    expect([plain.text, plain.dueRef, plain.priorityRef]).toEqual(["Call Bob", "today", 2]);
    expect(plain.content).toBe("Call Bob today p2");
    const whole = withTitle(plain, "Call Bob today p2");
    expect([whole.text, whole.dueRef, whole.priorityRef]).toEqual(["Call Bob today p2", null, null]);
    const tail = withTitle(plain, "Call Bob  today");
    expect([tail.text, tail.dueRef, tail.priorityRef]).toEqual(["Call Bob today", null, 2]);
    const edited = withTitle(plain, "Ring Bob today");
    expect(edited).toBe(plain); // title edited in the middle: read in full
    expect(serializeTask(whole)).toBe(line);
    expect(serializeTask(tail)).toBe(line);
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

describe("parentLine", () => {
  it("finds the checkbox a line is nested under", () => {
    const lines = ["- [ ] A", "\t- [ ] B", "", "    - [ ] C", "\t\t- [ ] D", "  - [ ] E", "- note", "\t- [ ] F", "- [ ] G"];
    const tasks = new Set([0, 1, 3, 4, 5, 7, 8]);
    const parents = lines.map((_, i) => parentLine(lines, i, tasks));
    expect(parents).toEqual([null, 0, null, 0, 3, 0, null, null, null]);
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

describe("withProjectRef", () => {
  it("adds the reference just before the marker, where it's read as a project", () => {
    const line = "\t- [ ] Call Bob 📅 2026-11-10 %%td:T1%%";
    const out = withProjectRef(line, "Home Reno");
    expect(out).toBe("\t- [ ] Call Bob 📅 2026-11-10 #[Home Reno] %%td:T1%%");
    expect(parseTaskLine(out)).toMatchObject({ projectRef: "Home Reno", due: "2026-11-10", todoistId: "T1" });
  });

  it("adds it at the end of a line without a marker", () => {
    expect(withProjectRef("- [ ] Call Bob  ", "Work")).toBe("- [ ] Call Bob #[Work]  ");
  });
});
