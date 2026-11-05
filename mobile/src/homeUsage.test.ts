import { beforeAll, describe, expect, it } from "vitest";
import { leftText, pace, resetIn, spendSummary, usageTone } from "./homeUsage";
import { setLanguage } from "./i18n";

beforeAll(() => {
  setLanguage("en");
});

describe("usageTone", () => {
  it("turns amber at 70 and red at 90", () => {
    expect(usageTone(0)).toBe("");
    expect(usageTone(69)).toBe("");
    expect(usageTone(70)).toBe("warm");
    expect(usageTone(89)).toBe("warm");
    expect(usageTone(90)).toBe("hot");
    expect(usageTone(100)).toBe("hot");
  });
});

describe("leftText", () => {
  it("is coarser the longer the wait", () => {
    expect(leftText(45 * 60_000)).toBe("45 min");
    expect(leftText(130 * 60_000)).toBe("2 h 10");
    expect(leftText(125 * 60_000)).toBe("2 h 05");
    expect(leftText((3 * 1440 + 5 * 60) * 60_000)).toBe("3 d 5 h");
  });
  it("never says 0 min", () => {
    expect(leftText(1000)).toBe("1 min");
  });
});

describe("resetIn", () => {
  const now = new Date(2026, 8, 10, 13, 0);
  it("reads a time of day as its next occurrence", () => {
    expect(resetIn("3pm", now)).toBe(2 * 3_600_000);
  });
  it("reads a dated reset", () => {
    expect(resetIn("Sep 12, 1pm", now)).toBe(2 * 86_400_000);
  });
  it("is null when unreadable or missing", () => {
    expect(resetIn("soon", now)).toBeNull();
    expect(resetIn("", now)).toBeNull();
    expect(resetIn(undefined, now)).toBeNull();
  });
  it("is null for a dated reset already past", () => {
    expect(resetIn("Sep 1, 1pm", now)).toBeNull();
  });
});

describe("pace", () => {
  const H = 3_600_000;
  it("is over when usage runs ahead of the clock by more than 10 points", () => {
    // 3 h of 5 left: 40% of the window has passed.
    expect(pace(60, 3 * H, 5 * H)).toEqual({ elapsed: 40, state: "over" });
  });
  it("is under when usage lags the clock by more than 10 points", () => {
    expect(pace(10, 1 * H, 5 * H)).toEqual({ elapsed: 80, state: "under" });
  });
  it("is on pace within the margin", () => {
    expect(pace(50, 2.5 * H, 5 * H).state).toBe("on");
    expect(pace(50, 2.5 * H, 5 * H).elapsed).toBe(50);
    expect(pace(50, 2 * H, 5 * H).state).toBe("on");
  });
  it("clamps elapsed to 0-100", () => {
    expect(pace(5, 6 * H, 5 * H).elapsed).toBe(0);
    expect(pace(5, -H, 5 * H).elapsed).toBe(100);
  });
});

describe("spendSummary", () => {
  const spend = (period: string, cost: number) => ({ kind: "spend", period, cost });
  it("copes with missing periods", () => {
    const s = spendSummary([spend("today", 2)]);
    expect(s.today?.cost).toBe(2);
    expect(s.month).toBeUndefined();
    expect(s.dailyAverage).toBeNull();
    expect(s.ratio).toBeNull();
    expect(s.state).toBeNull();
    expect(spendSummary([spend("month", 30)]).ratio).toBeNull();
  });
  it("ignores other kinds", () => {
    expect(spendSummary([{ kind: "gauge", period: "today", cost: 9 }]).today).toBeUndefined();
  });
  it("flags a day well above the average", () => {
    const s = spendSummary([spend("today", 2), spend("week", 8), spend("month", 30)]);
    expect(s.dailyAverage).toBe(1);
    expect(s.ratio).toBe(2);
    expect(s.state).toBe("over");
  });
  it("flags a quiet day and an ordinary one", () => {
    expect(spendSummary([spend("today", 0.5), spend("month", 30)]).state).toBe("under");
    expect(spendSummary([spend("today", 1), spend("month", 30)]).state).toBe("on");
    expect(spendSummary([spend("today", 1.3), spend("month", 30)]).state).toBe("over");
    expect(spendSummary([spend("today", 0.7), spend("month", 30)]).state).toBe("under");
  });
  it("has no average when nothing was spent in the month", () => {
    expect(spendSummary([spend("today", 1), spend("month", 0)]).dailyAverage).toBeNull();
  });
});
