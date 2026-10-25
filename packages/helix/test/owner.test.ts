import { fileNameFromTitle, isRequestPath, newNoteContent, newNotePath } from "../src/owner";
import { describe, expect, it } from "./expect";

describe("owner editor helpers", () => {
  it("turns titles into safe file names", () => {
    expect(fileNameFromTitle("Plan: Q4 / launch?")).toBe("Plan Q4 launch");
    expect(fileNameFromTitle("..hidden")).toBe("hidden");
    expect(fileNameFromTitle("[[x]] #tag")).toBe("x tag");
    expect(fileNameFromTitle("Café ✓ notes")).toBe("Café ✓ notes");
  });
  it("places new notes and requests", () => {
    expect(newNotePath("Summer ideas")).toBe("Summer ideas.md");
    expect(newNotePath("Ask: summarise", "Requests")).toBe("Requests/Ask summarise.md");
    expect(newNotePath("x", "../../etc")).toBe("etc/x.md");
    expect(newNotePath("  ///  ")).toBe(null);
  });
  it("writes the title as the heading", () => {
    expect(newNoteContent("Idea", "")).toBe("# Idea\n");
    expect(newNoteContent(" Idea ", "\nfirst line\n\n")).toBe("# Idea\n\nfirst line\n");
  });
  it("recognises the requests folder in any case", () => {
    expect(isRequestPath("Requests/a.md")).toBe(true);
    expect(isRequestPath("requests/a.md")).toBe(true);
    expect(isRequestPath("Notes/Requests/a.md")).toBe(false);
  });
});
