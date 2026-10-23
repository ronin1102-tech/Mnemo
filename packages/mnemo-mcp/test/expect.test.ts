import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "./expect.js";

/** The adapter must FAIL on wrong values, or every other test here would pass vacuously. */
const fails = (fn: () => void) => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected this assertion to fail, but it passed");
};

describe("expect adapter catches wrong values", () => {
  it("each matcher fails on a wrong value and passes on a right one", () => {
    fails(() => expect(1).toBe(2));
    fails(() => expect({ a: 1 }).toEqual({ a: 2 }));
    fails(() => expect({ a: 1, b: 2 }).toMatchObject({ a: 2 }));
    fails(() => expect([1, 2]).toHaveLength(3));
    fails(() => expect("abc").toContain("z"));
    fails(() => expect([1, 2]).toContain(3));
    fails(() => expect("abc").toMatch(/z/));
    fails(() => expect(5).toBeLessThan(5));
    fails(() => expect(5).toBeGreaterThan(5));
    fails(() => expect(4).toBeGreaterThanOrEqual(5));
    fails(() => expect(1.2).toBeCloseTo(1.3));
    fails(() => expect(null).toBeUndefined());
    fails(() => expect(0).toBeTruthy());
    fails(() => expect(1).toBeFalsy());
    fails(() => expect(() => undefined).toThrow());
    fails(() => expect(() => { throw new Error("boom"); }).toThrow(/bang/));
    fails(() => expect(1).not.toBe(1));
    fails(() => expect("abc").not.toContain("b"));

    expect(1).toBe(1);
    expect({ a: 1, b: undefined }).toEqual({ a: 1 });
    expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
    expect(() => { throw new Error("boom"); }).toThrow(/boom/);
    expect(1.234).toBeCloseTo(1.23);
    expect([1, 2]).not.toContain(3);
  });

  it("messages carry the caller's label", () => {
    try {
      expect(1, "my-label").toBe(2);
    } catch (e) {
      expect((e as Error).message).toContain("my-label");
      return;
    }
    throw new Error("did not fail");
  });

  it("the helix package uses an identical copy of this adapter", () => {
    expect(fs.readFileSync(path.resolve("../helix/test/expect.ts"), "utf8")).toBe(fs.readFileSync(path.resolve("test/expect.ts"), "utf8"));
  });
});
