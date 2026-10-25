export interface NoteNode {
  path: string;
  title: string;
  mtime: number;
  tags: string[];
  /** Frontmatter `created` (ms), when present. The time axis prefers it over `mtime`. */
  created?: number | null;
  /** First ~160 characters of the body, for the focus card. */
  excerpt?: string;
  /** The whole note, when the data carries it (the demo vault). Live mode fetches it from the bridge instead. */
  content?: string;
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
  /** Destination of a move. */
  to?: string;
  createdAt?: string;
  expiresAt?: string;
  /** False when the proposal would create a note that isn't in the vault yet. */
  exists?: boolean;
  /** The owner request (a note in Requests/) this proposal answers. */
  request?: string;
}
export interface RequestAnswer {
  id: string;
  op: string;
  path: string;
  to?: string;
  client: string;
  status: string;
}
/** One owner request and what agents have proposed for it (computed by the server). */
export interface RequestSummary {
  path: string;
  title: string;
  created: number | null;
  status: "open" | "in-progress" | "addressed" | "closed";
  answers: RequestAnswer[];
}
/** Shape written by `mnemo-mcp export-graph`. */
export interface GraphData {
  generatedAt: string;
  nodes: NoteNode[];
  links: Link[];
  proposals: PendingProposal[];
  /** Set when served live by `mnemo-ctl ui`. */
  live?: boolean;
  readOnly?: boolean;
  /** Live, on the vault's own computer, not read-only: the owner may write. */
  canWrite?: boolean;
  requests?: RequestSummary[];
  version?: number;
}
