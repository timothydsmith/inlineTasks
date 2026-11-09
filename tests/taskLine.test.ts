import { afterEach, describe, expect, it } from "vitest";
import { createsTask, findTasks, isCancelledStatus, setTasksGlobalFilter, setTasksStatuses, needsRelayout, parentLine, parseTaskLine, serializeTask, startsLabel, withPickedLabels, withProjectRef, withTitle } from "../src/parse/taskLine";

describe("parseTaskLine", () => {
  it("parses a plain checkbox", () => {
    const t = parseTaskLine("- [ ] Call Bob")!;
    expect(t).toMatchObject({ prefix: "- ", text: "Call Bob", checked: false, due: null, todoistId: null });
  });

  it("parses marker, due date and checked state", () => {
    const t = parseTaskLine("  * [x] Call Bob %%td:6Xg4Qm2pR%% ⏳ 2026-11-10")!;
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
    const t = parseTaskLine("- [ ] Send #[Old] invoice #[Home Reno] ⏳ 2026-11-10 #urgent")!;
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
    const t = parseTaskLine("- [ ] Plan p2 roadmap P1 ⏳ 2026-11-10")!;
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
    const line = "- [ ] Call Bob today p2 %%td:abc%% ⏳ 2026-11-10";
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
    const line = "- [ ] Call Bob %%td:abc123%% ⏳ 2026-11-10";
    expect(serializeTask(parseTaskLine(line)!)).toBe(line);
  });

  it("normalises field order", () => {
    const t = parseTaskLine("- [ ] %%td:abc%% Call ⏳ 2026-01-02 Bob")!;
    expect(serializeTask(t)).toBe("- [ ] Call Bob %%td:abc%% ⏳ 2026-01-02");
  });

  it("keeps a project reference before the due date and marker", () => {
    const t = parseTaskLine("- [ ] Call #[Work] Bob %%td:abc%% ⏳ 2026-11-10")!;
    expect(serializeTask(t)).toBe("- [ ] Call Bob #[Work] %%td:abc%% ⏳ 2026-11-10");
    expect(serializeTask({ ...t, projectRef: null })).toBe("- [ ] Call Bob %%td:abc%% ⏳ 2026-11-10");
  });

  it("writes labels after the text, bracketing names that need it", () => {
    const t = parseTaskLine("- [ ] Call @[Waiting For] Bob #[Work] @PhoneCall ⏳ 2026-11-10")!;
    expect(serializeTask(t)).toBe("- [ ] Call Bob @[Waiting For] @PhoneCall #[Work] ⏳ 2026-11-10");
    expect(serializeTask({ ...t, labelRefs: ["done."] })).toBe("- [ ] Call Bob @[done.] #[Work] ⏳ 2026-11-10");
  });

  it("writes a priority straight after the text", () => {
    const t = parseTaskLine("- [ ] Call p2 Bob @PhoneCall %%td:abc%% ⏳ 2026-11-10")!;
    expect(serializeTask(t)).toBe("- [ ] Call Bob p2 @PhoneCall %%td:abc%% ⏳ 2026-11-10");
    expect(serializeTask({ ...t, priorityRef: null })).toBe("- [ ] Call Bob @PhoneCall %%td:abc%% ⏳ 2026-11-10");
  });

  it("keeps a status while it still says the same, and ticks and unticks to x and a space", () => {
    const half = parseTaskLine("- [/] Half done")!;
    expect(half.checked).toBe(false);
    expect(serializeTask(half)).toBe("- [/] Half done");
    expect(serializeTask({ ...half, checked: true })).toBe("- [x] Half done");
    const cancelled = parseTaskLine("- [-] Dropped")!;
    expect(cancelled.checked).toBe(true);
    expect(serializeTask(cancelled)).toBe("- [-] Dropped");
    expect(serializeTask({ ...cancelled, checked: false })).toBe("- [ ] Dropped");
    expect(parseTaskLine("- [X] Done")!.checked).toBe(true);
    expect(parseTaskLine("- [?] Maybe")!.checked).toBe(false);
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
    const line = "\t- [ ] Call Bob %%td:T1%% ⏳ 2026-11-10";
    const out = withProjectRef(line, "Home Reno");
    expect(out).toBe("\t- [ ] Call Bob #[Home Reno] %%td:T1%% ⏳ 2026-11-10");
    expect(parseTaskLine(out)).toMatchObject({ projectRef: "Home Reno", due: "2026-11-10", todoistId: "T1" });
  });

  it("adds it at the end of a line without a marker", () => {
    expect(withProjectRef("- [ ] Call Bob  ", "Work")).toBe("- [ ] Call Bob #[Work]  ");
  });
});

describe("withPickedLabels", () => {
  const none = () => false;

  it("replaces the @ with the picked labels, cursor after them", () => {
    const line = "- [ ] Call Bob @";
    const out = withPickedLabels(line, line.length - 1, ["PhoneCall", "Waiting For"], none);
    expect(out.line).toBe("- [ ] Call Bob @PhoneCall @[Waiting For] ");
    expect(out.cursor).toBe(out.line.length);
  });

  it("keeps one space before the rest of the line", () => {
    const line = "- [ ] Call Bob @ today";
    const out = withPickedLabels(line, 15, ["Errands"], none);
    expect(out.line).toBe("- [ ] Call Bob @Errands today");
    expect(out.line.slice(0, out.cursor)).toBe("- [ ] Call Bob @Errands");
  });

  it("takes out the references to unticked labels, matching any spelling", () => {
    const line = "- [ ] Call @phonecall Bob @[waiting for] @";
    const drop = (n: string) => n.toLowerCase() === "phonecall";
    const out = withPickedLabels(line, line.length - 1, ["Errands"], drop);
    expect(out.line).toBe("- [ ] Call Bob @[waiting for] @Errands ");
    expect(out.cursor).toBe(out.line.length);
  });

  it("just removes the @ when nothing is added", () => {
    expect(withPickedLabels("- [ ] Call Bob @ today", 15, [], none)).toEqual({ line: "- [ ] Call Bob today", cursor: 15 });
    expect(withPickedLabels("- [ ] Call Bob @", 15, [], none)).toEqual({ line: "- [ ] Call Bob", cursor: 14 });
    expect(withPickedLabels("- [ ] Call Bob %%td:T1%% @", 25, [], none)).toEqual({ line: "- [ ] Call Bob %%td:T1%%", cursor: 24 });
  });
});

describe("startsLabel", () => {
  it("opens on an @ of its own, after the checkbox of a line that syncs", () => {
    expect(startsLabel("- [ ] Call Bob @", 15)).toBe(true);
    expect(startsLabel("- [ ] @", 6)).toBe(true);
    expect(startsLabel("\t- [ ] Call @ Bob %%td:T1%%", 12)).toBe(true);
  });

  it("doesn't open inside a word, on other lines, or where labels mean nothing", () => {
    expect(startsLabel("- [ ] Email bob@", 15)).toBe(false); // email address
    expect(startsLabel("- [ ] Call @Bob", 11)).toBe(false); // editing a reference
    expect(startsLabel("- Call Bob @", 11)).toBe(false); // not a checkbox
    expect(startsLabel("- [x] Done @", 11)).toBe(false); // ticked and never synced
    expect(startsLabel("- [ ] Private #notodoist @", 25)).toBe(false);
  });
});

describe("Tasks plugin fields", () => {
  it("keeps Tasks' fields out of the title and writes them after the marker, in Tasks' order", () => {
    const t = parseTaskLine("- [ ] Water plants ⏫ 🔁 every week when done ⏳ 2026-11-08 📅 2026-11-10 ➕ 2026-11-01 🛫 2026-11-07 %%td:abc%%")!;
    expect(t).toMatchObject({ text: "Water plants", due: "2026-11-08", deadline: "2026-11-10", todoistId: "abc", dueRef: null, priorityRef: null });
    expect(t.fields).toEqual({ priority: "⏫", recurrence: "every week when done", created: "2026-11-01", start: "2026-11-07" });
    expect(serializeTask(t)).toBe(
      "- [ ] Water plants %%td:abc%% ⏫ 🔁 every week when done ➕ 2026-11-01 🛫 2026-11-07 ⏳ 2026-11-08 📅 2026-11-10",
    );
  });

  it("round-trips a done line with a done date, ids and a block link", () => {
    const line = "- [x] Pay rent #home %%td:abc%% 🆔 rent ⛔ bank,cash 🏁 delete 📅 2026-11-10 ✅ 2026-11-06 ^rent-nov";
    const t = parseTaskLine(line)!;
    expect(t).toMatchObject({ text: "Pay rent #home", checked: true, blockLink: "rent-nov" });
    expect(t.fields).toMatchObject({ id: "rent", dependsOn: "bank,cash", onCompletion: "delete", done: "2026-11-06" });
    expect(serializeTask(t)).toBe(line);
  });

  it("reads Tasks' other spellings: variation selectors, 📆 and ⌛", () => {
    const t = parseTaskLine("- [ ] Call ⏫️ ⌛ 2026-11-08 📆 2026-11-10")!;
    expect(t).toMatchObject({ text: "Call", due: "2026-11-08", deadline: "2026-11-10" });
    expect(t.fields).toEqual({ priority: "⏫" });
    expect(serializeTask(t)).toBe("- [ ] Call ⏫ ⏳ 2026-11-08 📅 2026-11-10");
  });

  it("reads references typed after the fields", () => {
    expect(parseTaskLine("- [ ] Call %%td:a%% 📅 2026-11-10 p1 @PhoneCall")).toMatchObject({
      text: "Call",
      deadline: "2026-11-10",
      priorityRef: 1,
      labelRefs: ["PhoneCall"],
    });
  });

  it("knows a line written with its marker after the fields", () => {
    const old = "- [ ] Call Bob 📅 2026-11-10 %%td:abc%%";
    expect(needsRelayout(old, parseTaskLine(old)!)).toBe(true);
    const ok = "- [ ] Call Bob %%td:abc%% 📅 2026-11-10";
    expect(needsRelayout(ok, parseTaskLine(ok)!)).toBe(false);
    const bare = "- [ ] Call Bob %%td:abc%%";
    expect(needsRelayout(bare, parseTaskLine(bare)!)).toBe(false);
    const block = "- [ ] Call Bob ^b1 %%td:abc%%";
    expect(needsRelayout(block, parseTaskLine(block)!)).toBe(true);
    expect(serializeTask(parseTaskLine(block)!)).toBe("- [ ] Call Bob %%td:abc%% ^b1");
  });

  it("starts Todoist tasks only from to-do and in-progress lines", () => {
    expect(createsTask(parseTaskLine("- [ ] a")!)).toBe(true);
    expect(createsTask(parseTaskLine("- [/] a")!)).toBe(true);
    expect(createsTask(parseTaskLine("- [?] a")!)).toBe(false);
    expect(createsTask(parseTaskLine("- [x] a")!)).toBe(false);
    expect(createsTask(parseTaskLine("- [-] a")!)).toBe(false);
    expect(createsTask(parseTaskLine("- [ ] a %%td:x%%")!)).toBe(false);
  });
});

describe("Tasks plugin statuses", () => {
  afterEach(() => setTasksStatuses(null));
  const line = (s: string) => parseTaskLine(`- [${s}] Thing`)!;

  it("reads statuses as Tasks defines them", () => {
    setTasksStatuses([
      { symbol: "d", type: "DONE" },
      { symbol: "c", type: "CANCELLED" },
      { symbol: "~", type: "NON_TASK" },
      { symbol: "/", type: "NON_TASK" },
    ]);
    expect(["d", "c", "~", "/", "x", "X", "-", " "].map((s) => line(s).checked)).toEqual([true, true, false, false, true, true, true, false]);
    expect(["c", "-", "d"].map(isCancelledStatus)).toEqual([true, true, false]);
    expect(["~", "/", " ", "d"].map((s) => createsTask(line(s)))).toEqual([false, false, true, false]);
    // A custom done line Todoist reopens becomes `[ ]`.
    expect(serializeTask({ ...line("d"), checked: false })).toBe("- [ ] Thing");
  });

  it("goes back to the defaults without Tasks", () => {
    setTasksStatuses([{ symbol: "d", type: "DONE" }]);
    setTasksStatuses(null);
    expect(line("d").checked).toBe(false);
    expect(createsTask(line("d"))).toBe(false);
    expect(createsTask(line("/"))).toBe(true);
  });
});

describe("Tasks' global filter", () => {
  afterEach(() => setTasksGlobalFilter(null));

  it("keeps it out of the text, and writes it back where it was", () => {
    setTasksGlobalFilter("#task");
    const start = parseTaskLine("- [ ] #task Buy milk %%td:T1%% ⏳ 2026-11-10")!;
    expect(start).toMatchObject({ text: "Buy milk", hasGlobalFilter: true, globalFilterAt: "start" });
    expect(serializeTask({ ...start, text: "Buy bread" })).toBe("- [ ] #task Buy bread %%td:T1%% ⏳ 2026-11-10");
    const end = parseTaskLine("- [ ] Buy milk #task p2")!;
    expect(end).toMatchObject({ text: "Buy milk", priorityRef: 2, globalFilterAt: "end" });
    expect(serializeTask({ ...end, priorityRef: null })).toBe("- [ ] Buy milk #task");
  });

  it("counts it inside a word, as Tasks does, but leaves it in the text there", () => {
    setTasksGlobalFilter("#task");
    const t = parseTaskLine("- [ ] Sort #tasks")!;
    expect(t).toMatchObject({ text: "Sort #tasks", hasGlobalFilter: true });
    expect(t.globalFilterAt).toBeUndefined();
  });

  it("treats a line with only the filter as empty", () => {
    setTasksGlobalFilter("#task");
    expect(parseTaskLine("- [ ] #task")!.excluded).toBe(true);
  });

  it("with only, makes tasks from lines with the filter alone", () => {
    setTasksGlobalFilter("#task", true);
    expect(createsTask(parseTaskLine("- [ ] Buy milk")!)).toBe(false);
    expect(createsTask(parseTaskLine("- [ ] #task Buy milk")!)).toBe(true);
    setTasksGlobalFilter("#task", false);
    expect(createsTask(parseTaskLine("- [ ] Buy milk")!)).toBe(true);
    setTasksGlobalFilter(null, true);
    expect(createsTask(parseTaskLine("- [ ] Buy milk")!)).toBe(true);
  });

  it("handles a filter that isn't a tag", () => {
    setTasksGlobalFilter("TODO");
    const t = parseTaskLine("- [ ] TODO call (Bob)")!;
    expect(t).toMatchObject({ text: "call (Bob)", globalFilterAt: "start" });
  });
});
