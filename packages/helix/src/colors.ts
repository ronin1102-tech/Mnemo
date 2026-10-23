/**
 * Palette of the Mnemo mark: deep navy ground, water-blue strands, blue-white nodes.
 * GOLD is reserved for agent proposals and must only be used by proposal markers
 * (enforced by test/colors.test.ts). MARK_GOLD is the emblem's own gold (beads and ring):
 * a branding surface, used only by drawEmblem, never in the working graph.
 */
export const COLORS = {
  bg: "#050c24",
  text: "#e6eefc",
  muted: "#8fa3c8",
  strand: ["#8fbcff", "#5e8fdc"],
  node: "#e4efff",
  rung: "#a9c4f0",
  water: "#4f86d6",
  select: "#ffffff",
  gold: "#e0b040", // agent proposals only
  markGold: "#d9b04a", // the emblem mark only
};
