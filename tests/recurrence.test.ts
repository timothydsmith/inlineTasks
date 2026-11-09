import { describe, expect, it } from "vitest";
import { canonicalRule, todoistRule } from "../src/sync/recurrence";

describe("repeat rules", () => {
  it("reads Tasks rules and Todoist strings into one form", () => {
    const cases: [string, string][] = [
      ["every day", "every day"],
      ["Every  Week", "every week"],
      ["daily", "every day"],
      ["every 1 month", "every month"],
      ["every 2 week", "every 2 weeks"],
      ["every other week", "every 2 weeks"],
      ["ev 3 days", "every 3 days"],
      ["every workday", "every weekday"],
      ["every weekday", "every weekday"],
      ["every mon", "every week on Monday"],
      ["every friday, mon", "every week on Monday, Friday"],
      ["every week on Tuesday, Thursday", "every week on Tuesday, Thursday"],
      ["every mon and wed", "every week on Monday, Wednesday"],
      ["every 15th", "every month on the 15th"],
      ["every month on the 2nd", "every month on the 2nd"],
      ["every month on the last", "every month on the last"],
      ["every last day", "every month on the last"],
      ["every! week", "every week when done"],
      ["every week when done", "every week when done"],
      ["every 2 weeks starting nov 10", "every 2 weeks"],
      ["every day at 9am", "every day"],
      ["every 3rd friday", "every month on the 3rd Friday"],
      ["every month on the 2nd Wednesday", "every month on the 2nd Wednesday"],
      ["every first mon", "every month on the 1st Monday"],
      ["every last friday", "every month on the last Friday"],
      ["every month on the last Friday", "every month on the last Friday"],
      ["every January on the 15th", "every January on the 15th"],
      ["every jan 15th", "every January on the 15th"],
      ["every 15 jan", "every January on the 15th"],
      ["every 29th of february", "every February on the 29th"],
      ["every year on sept 3", "every September on the 3rd"],
      ["every other monday", "every 2 weeks on Monday"],
      ["every 2 weeks on Monday", "every 2 weeks on Monday"],
    ];
    for (const [rule, want] of cases) expect(canonicalRule(rule), rule).toBe(want);
  });

  it("leaves rules one side wouldn't understand", () => {
    for (const rule of ["every 5th friday", "every 3rd friday when done", "every! other monday", "every feb 30", "every 3 weeks on monday", "every month on the 32nd", "every 0 days", "every blursday", "tomorrow"]) {
      expect(canonicalRule(rule), rule).toBeUndefined();
    }
  });

  it("writes Todoist strings that read back the same", () => {
    const cases: [string, string][] = [
      ["every week", "every week"],
      ["every 2 weeks", "every 2 weeks"],
      ["every week on Monday, Friday", "every monday, friday"],
      ["every month on the 15th", "every 15th"],
      ["every month on the last", "every last day"],
      ["every week when done", "every! week"],
      ["every weekday", "every weekday"],
      ["every month on the 3rd Friday", "every 3rd friday"],
      ["every month on the last Friday", "every last friday"],
      ["every January on the 15th", "every jan 15th"],
      ["every 2 weeks on Monday", "every other monday"],
    ];
    for (const [canonical, todoist] of cases) {
      expect(todoistRule(canonical)).toBe(todoist);
      expect(canonicalRule(todoist)).toBe(canonical);
    }
  });
});
