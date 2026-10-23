export interface NoteNode {
  path: string;
  title: string;
  mtime: number;
  tags: string[];
  /** Frontmatter `created` (ms), when present. The time axis prefers it over `mtime`. */
  created?: number | null;
  /** First ~160 characters of the body, for the focus card. */
  excerpt?: string;
}
export interface Link {
  src: string;
  dst: string;
}
export interface PendingProposal {
  id: string;
  path: string;
  op: string;
  client: string;
}
/** Shape written by `mnemo-mcp export-graph`. */
export interface GraphData {
  generatedAt: string;
  nodes: NoteNode[];
  links: Link[];
  proposals: PendingProposal[];
}
