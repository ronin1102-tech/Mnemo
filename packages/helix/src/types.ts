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
  /** Live, and this session is the owner's: Copilot chat is available. */
  canChat?: boolean;
  /** Why chat is off for this session, if it is. */
  chatOff?: "read-only" | "not-owner" | null;
  requests?: RequestSummary[];
  version?: number;
}

/** Copilot chat (the owner's private channel with one agent). Shapes mirror the hub's /api/chat. */
export interface ChatRef {
  path: string;
  title: string;
  /** `open`: the note the owner had open. `match`: a search hit for the message. */
  why?: "open" | "match";
}
export interface ChatMessage {
  id: string;
  author: "owner" | "agent";
  at: string;
  body: string;
  state?: "queued" | "delivered" | "answered";
  deliveredAt?: string;
  answeredAt?: string;
  context?: ChatRef[];
  cites?: ChatRef[];
  proposal?: string;
}
export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}
export interface ChatThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  count: number;
  queued: number;
  lastAgentAt: string | null;
}
export interface ChatList {
  /** Name of the agent the owner connected, or null if none yet. */
  agent: string | null;
  lastAgentSeen: string | null;
  queued: number;
  threads: ChatThreadSummary[];
}
/** A proposal attached to a reply, as the hub resolves it for the pane. */
export interface ChatProposal {
  id: string;
  status: string;
  op?: string;
  path?: string;
  to?: string;
  client?: string;
  createdAt?: string;
  expiresAt?: string;
  exists?: boolean;
}
