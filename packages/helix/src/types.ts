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
  version?: number;
}
