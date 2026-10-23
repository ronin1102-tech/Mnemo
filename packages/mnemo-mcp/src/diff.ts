/** Stored diffs are a review aid, not the record (approval applies the stored content), so they are capped. */
export const MAX_DIFF_LINES = 20_000;

export function capDiff(diff: string, max = MAX_DIFF_LINES): string {
  let idx = -1;
  for (let k = 0; k < max; k++) {
    idx = diff.indexOf("\n", idx + 1);
    if (idx < 0) return diff;
  }
  const rest = diff.slice(idx + 1).split("\n").length;
  return diff.slice(0, idx) + `\n… diff truncated: ${rest} more line(s). Approval still applies the full proposed content.`;
}

/** Largest LCS table (cells) we will build: 4M cells is ~16 MB. Beyond that the changed middle is shown whole. */
const MAX_CELLS = 4_000_000;

/**
 * Minimal unified-style line diff. Common leading and trailing lines are peeled off first; the
 * changed middle uses an LCS, or, if that would be huge (an agent-supplied rewrite of a big note),
 * is shown as one removal block and one addition block rather than exhausting memory.
 */
export function lineDiff(before: string, after: string): string {
  const A = before === "" ? [] : before.split("\n");
  const B = after === "" ? [] : after.split("\n");
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a = A.slice(head, A.length - tail);
  const b = B.slice(head, B.length - tail);
  // plain loops, not push(...arr): spreading millions of lines overflows the call stack
  const out: string[] = [];
  for (let i = 0; i < head; i++) out.push("  " + A[i]);
  for (const l of middle(a, b)) out.push(l);
  for (let i = A.length - tail; i < A.length; i++) out.push("  " + A[i]);
  return capDiff(out.join("\n"));
}

function middle(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    const out: string[] = [];
    for (const l of a) out.push("- " + l);
    for (const l of b) out.push("+ " + l);
    return out;
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push("  " + a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push("- " + a[i++]);
    else out.push("+ " + b[j++]);
  }
  while (i < n) out.push("- " + a[i++]);
  while (j < m) out.push("+ " + b[j++]);
  return out;
}
