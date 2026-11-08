import { describe, expect, it } from "vitest";
import { allowanceLevel, dollars, limitNote, resetsAt } from "../shared/allowance.ts";

describe("the daily allowance ring", () => {
  it("fills with what today's calls cost against the limit, and turns at 60% and at the limit", () => {
    expect(allowanceLevel(0, 5)).toEqual({ share: 0, percent: 0, level: "", left: 5 });
    expect(allowanceLevel(1.2, 5)).toMatchObject({ share: 0.24, percent: 24, level: "" });
    expect(allowanceLevel(3, 5)).toMatchObject({ percent: 60, level: "high", left: 2 });
    expect(allowanceLevel(4.999, 5).level).toBe("high");
    expect(allowanceLevel(5, 5)).toMatchObject({ share: 1, percent: 100, level: "full", left: 0 });
    // Past the limit (calls already going when it was reached): full, never more than the whole ring.
    expect(allowanceLevel(7.5, 5)).toMatchObject({ share: 1, level: "full", left: 0 });
  });

  it("shows no share without a limit, and reads a limit from the environment only as a positive amount", () => {
    expect(allowanceLevel(3, 0)).toEqual({ share: 0, percent: 0, level: "", left: 0 });
    expect(dollars("5.00")).toBe(5);
    expect(dollars(0.5)).toBe(0.5);
    for (const value of ["", "0", "-1", "abc", undefined, null, Number.POSITIVE_INFINITY]) expect(dollars(value)).toBe(0);
  });

  it("starts again at the next UTC midnight", () => {
    expect(resetsAt(Date.UTC(2026, 10, 8, 13, 45))).toBe(Date.UTC(2026, 10, 9));
    expect(resetsAt(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
    expect(resetsAt(Date.UTC(2026, 10, 8))).toBe(Date.UTC(2026, 10, 9));
  });

  it("says what stops at the limit and that the person's own messages never do", () => {
    expect(limitNote(1.25, 5, "2:00 AM")).toBe(
      "$3.75 left before your agents' scheduled runs and unprompted posts pause; your own messages never do. It starts again at 2:00 AM.",
    );
    expect(limitNote(5.2, 5, "2:00 AM")).toMatch(/^The limit is reached: .* wait until 2:00 AM\. Your own messages still go\.$/);
    expect(limitNote(5.2, 0, "2:00 AM")).toBe("");
  });
});
