/**
 * Minimal Jest/Vitest-style `expect` on top of node:test + node:assert, so the suite runs on
 * Node's built-in test runner with no test-framework dependency (vitest's dependency tree
 * pulled in native binaries that need macOS 11-12, and Catalina is the floor).
 * Covers exactly the matchers this repo uses.
 */
import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";

type Fn = () => unknown | Promise<unknown>;

export const describe = (name: string, fn: () => void) => nodeDescribe(name, fn);

function itImpl(name: string, fn: Fn, timeout?: number) {
  return nodeIt(name, timeout ? { timeout } : {}, async () => {
    await fn();
  });
}

/** `it.each([...])(name, fn)`: one test per row; `%j` / `%s` in the name are filled from the row. */
itImpl.each = <T>(rows: T[]) => (name: string, fn: (row: T) => unknown, timeout?: number) => {
  for (const row of rows) {
    const label = name.replace(/%[js]/, typeof row === "string" ? JSON.stringify(row) : JSON.stringify(row));
    itImpl(label, () => fn(row), timeout);
  }
};

export const it = itImpl;

/** Deep equality that, like toEqual, treats an `undefined` property as absent. */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = strip(x);
    return out;
  }
  return v;
}

function isSubset(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => isSubset((actual as Record<string, unknown>)[k], v));
  }
  try {
    assert.deepEqual(strip(actual), strip(expected));
    return true;
  } catch {
    return false;
  }
}

function matchers(actual: unknown, negate: boolean, msg?: string) {
  const check = (pass: boolean, what: string) => {
    if (pass === negate) assert.fail((msg ? msg + ": " : "") + `expected ${show(actual)} ${negate ? "not " : ""}${what}`);
  };
  return {
    toBe: (e: unknown) => check(Object.is(actual, e), `to be ${show(e)}`),
    toEqual: (e: unknown) => {
      let pass = true;
      try {
        assert.deepEqual(strip(actual), strip(e));
      } catch {
        pass = false;
      }
      check(pass, `to equal ${show(e)}`);
    },
    toMatchObject: (e: unknown) => check(isSubset(actual, e), `to match object ${show(e)}`),
    toHaveLength: (n: number) => check((actual as { length: number }).length === n, `to have length ${n} (has ${(actual as { length: number })?.length})`),
    toContain: (x: unknown) =>
      check(typeof actual === "string" ? actual.includes(x as string) : (actual as unknown[]).includes(x), `to contain ${show(x)}`),
    toMatch: (re: RegExp | string) => check(typeof re === "string" ? String(actual).includes(re) : re.test(String(actual)), `to match ${re}`),
    toBeLessThan: (n: number) => check((actual as number) < n, `to be < ${n}`),
    toBeGreaterThan: (n: number) => check((actual as number) > n, `to be > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => check((actual as number) >= n, `to be >= ${n}`),
    toBeCloseTo: (n: number, digits = 2) => check(Math.abs((actual as number) - n) < Math.pow(10, -digits) / 2, `to be close to ${n}`),
    toBeUndefined: () => check(actual === undefined, "to be undefined"),
    toBeTruthy: () => check(!!actual, "to be truthy"),
    toBeFalsy: () => check(!actual, "to be falsy"),
    toThrow: (want?: RegExp | string) => {
      let threw = false;
      let message = "";
      try {
        (actual as () => unknown)();
      } catch (e) {
        threw = true;
        message = e instanceof Error ? e.message : String(e);
      }
      const ok = threw && (want === undefined || (typeof want === "string" ? message.includes(want) : want.test(message)));
      check(ok, `to throw${want ? " " + want : ""}${threw ? ` (threw: ${message})` : " (did not throw)"}`);
    },
  };
}

const show = (v: unknown) => {
  try {
    const s = typeof v === "string" ? JSON.stringify(v) : typeof v === "function" ? "[function]" : JSON.stringify(v);
    return s && s.length > 200 ? s.slice(0, 200) + "…" : String(s);
  } catch {
    return String(v);
  }
};

export function expect(actual: unknown, msg?: string) {
  return { ...matchers(actual, false, msg), not: matchers(actual, true, msg) };
}
