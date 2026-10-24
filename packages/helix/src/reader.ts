/**
 * The reader: turns the parsed Markdown tree into DOM. Every piece of note text goes in through
 * textContent (never innerHTML), and only http(s)/mailto links leave the app.
 */
import { classifyHref, slug } from "./markdown";
import type { Block, Inline } from "./markdown";

export interface ReaderLinks {
  /** The note being read (for relative Markdown links). */
  src: string;
  resolve(target: string): string | null;
  titleOf(path: string): string;
  /** Open another note in the reader, optionally at a heading. */
  open(path: string, heading: string): void;
  /** Scroll to a heading in this note. */
  jump(heading: string): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export function renderBlocks(blocks: Block[], ctx: ReaderLinks, into: HTMLElement) {
  const seen = new Map<string, number>();
  const headingId = (text: string) => {
    const base = slug(text) || "section";
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const walk = (bs: Block[], parent: HTMLElement) => {
    for (const b of bs) {
      switch (b.t) {
        case "h": {
          const h = el(("h" + Math.min(6, b.level + 1)) as "h2"); // the note title is the page's h1
          h.className = "md-h md-h" + b.level;
          inline(b.c, ctx, h);
          h.dataset.slug = headingId(h.textContent || "");
          parent.appendChild(h);
          break;
        }
        case "p": {
          const p = el("p");
          inline(b.c, ctx, p);
          parent.appendChild(p);
          break;
        }
        case "list": {
          const list = el(b.ordered ? "ol" : "ul");
          if (b.ordered && b.start !== 1) list.setAttribute("start", String(b.start));
          for (const item of b.items) {
            const li = el("li");
            if (item.task !== null) {
              li.className = "task" + (item.task ? " done" : "");
              const box = el("span", "checkbox", item.task ? "✓" : "");
              box.setAttribute("role", "img");
              box.setAttribute("aria-label", item.task ? "done" : "not done");
              li.appendChild(box);
            }
            // a tight item's first paragraph sits inline; anything after it is a nested block
            const [first, ...rest] = item.c;
            if (first && first.t === "p") {
              const span = el("span", "li-text");
              inline(first.c, ctx, span);
              li.appendChild(span);
              walk(rest, li);
            } else walk(item.c, li);
            list.appendChild(li);
          }
          parent.appendChild(list);
          break;
        }
        case "quote": {
          const q = el("blockquote");
          walk(b.c, q);
          parent.appendChild(q);
          break;
        }
        case "callout": {
          const box = el("aside", "callout callout-" + b.kind.replace(/[^a-z0-9-]/g, ""));
          const title = el("p", "callout-title");
          inline(b.title, ctx, title);
          box.appendChild(title);
          walk(b.c, box);
          parent.appendChild(box);
          break;
        }
        case "code": {
          const pre = el("pre", "md-code");
          if (b.lang) pre.appendChild(el("span", "code-lang", b.lang));
          pre.appendChild(el("code", "", b.v));
          parent.appendChild(pre);
          break;
        }
        case "hr":
          parent.appendChild(el("hr"));
          break;
        case "table": {
          const wrap = el("div", "table-wrap");
          const table = el("table");
          const thead = el("thead");
          const hr = el("tr");
          b.head.forEach((c, i) => {
            const th = el("th");
            if (b.align[i]) th.style.textAlign = b.align[i];
            inline(c, ctx, th);
            hr.appendChild(th);
          });
          thead.appendChild(hr);
          table.appendChild(thead);
          const tbody = el("tbody");
          for (const row of b.rows) {
            const tr = el("tr");
            b.head.forEach((_, i) => {
              const td = el("td");
              if (b.align[i]) td.style.textAlign = b.align[i];
              inline(row[i] || [], ctx, td);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          wrap.appendChild(table);
          parent.appendChild(wrap);
          break;
        }
      }
    }
  };
  walk(blocks, into);
}

function inline(nodes: Inline[], ctx: ReaderLinks, parent: HTMLElement) {
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        parent.appendChild(document.createTextNode(n.v));
        break;
      case "br":
        parent.appendChild(el("br"));
        break;
      case "code":
        parent.appendChild(el("code", "md-inline-code", n.v));
        break;
      case "strong": case "em": case "del": case "mark": {
        const e = el(n.t === "em" ? "em" : n.t === "strong" ? "strong" : n.t === "del" ? "del" : "mark");
        inline(n.c, ctx, e);
        parent.appendChild(e);
        break;
      }
      case "tag":
        parent.appendChild(el("span", "md-tag", "#" + n.v));
        break;
      case "image": {
        // images aren't served by the bridge (and its CSP blocks remote ones): name it instead
        parent.appendChild(el("span", "md-attachment", "▧ " + (n.alt || n.src.split("/").pop() || "image")));
        break;
      }
      case "wiki": {
        const isNote = !n.target || /\.md$/i.test(n.target) || !/\.[a-z0-9]{1,5}$/i.test(n.target);
        if (!isNote) {
          parent.appendChild(el("span", "md-attachment", "▧ " + (n.label || n.target)));
          break;
        }
        if (!n.target) {
          const b = el("button", "md-wiki", n.label);
          b.type = "button";
          b.addEventListener("click", () => ctx.jump(n.heading));
          parent.appendChild(b);
          break;
        }
        const path = ctx.resolve(n.target);
        if (!path) {
          const s = el("span", "md-wiki unresolved", n.label);
          s.title = "No note with this name yet";
          parent.appendChild(s);
          break;
        }
        const b = el("button", "md-wiki" + (n.embed ? " embed" : ""), (n.embed ? "↳ " : "") + n.label);
        b.type = "button";
        b.title = ctx.titleOf(path);
        b.addEventListener("click", () => ctx.open(path, n.heading));
        parent.appendChild(b);
        break;
      }
      case "link": {
        const h = classifyHref(n.href, ctx.src, ctx.resolve);
        if (h.kind === "web") {
          const a = el("a", "md-link");
          a.href = h.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          inline(n.c, ctx, a);
          parent.appendChild(a);
        } else if (h.kind === "note") {
          const b = el("button", "md-wiki");
          b.type = "button";
          inline(n.c, ctx, b);
          b.addEventListener("click", () => ctx.open(h.path, h.heading));
          parent.appendChild(b);
        } else {
          const s = el("span", "md-link dead");
          s.title = n.href;
          inline(n.c, ctx, s);
          parent.appendChild(s);
        }
        break;
      }
    }
  }
}
