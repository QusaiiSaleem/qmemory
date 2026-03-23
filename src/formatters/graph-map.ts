/**
 * Graph map formatting for system prompt injection
 *
 * Formats entity and relationship data as a navigable world map.
 */

import type { GraphEntity, GraphEdge, GraphStats } from "../types.js";

/**
 * Format the graph summary as a world map for the agent.
 * Shows entities grouped by type, relationships between them,
 * and a nudge about orphan memories that need linking.
 */
export function formatGraphMap(
  entities: GraphEntity[],
  edges: GraphEdge[],
  stats: GraphStats,
): string {
  if (entities.length === 0 && edges.length === 0) return "";

  const sections: string[] = [
    "### Knowledge Graph",
    `_${stats.entities} entities, ${stats.edges} relationships, ${stats.memories} memories_`,
  ];

  // Group entities by type
  const byType: Record<string, GraphEntity[]> = {};
  for (const e of entities) {
    const t = e.type || "other";
    if (!byType[t]) byType[t] = [];
    byType[t].push(e);
  }

  // Display order for entity types — channels/topics first for navigation
  const typeLabels: Record<string, string> = {
    channel: "Channels",
    topic: "Topics",
    person: "People",
    project: "Projects",
    org: "Organizations",
    system: "Systems",
    concept: "Concepts",
    contact: "Contacts",
  };

  // Books get a special compact section — show count + top 5 by connections
  const books = byType["book"];
  if (books && books.length > 0) {
    const sorted = [...books].sort((a, b) => (b.total_links ?? 0) - (a.total_links ?? 0));
    const topBooks = sorted.slice(0, 5);
    sections.push("", `**📚 Library (${books.length} books)**`);
    for (const b of topBooks) {
      const links = b.total_links ?? 0;
      const name = b.name.length > 60 ? b.name.slice(0, 57) + "..." : b.name;
      sections.push(`- ${name} (${links} connections)`);
    }
    if (books.length > 5) {
      sections.push(`- _...and ${books.length - 5} more_`);
    }
    sections.push(`_Search book content: qmemory_search({categories: ["domain"], query: "book title or topic"})_`);
  }

  for (const [type, label] of Object.entries(typeLabels)) {
    const items = byType[type];
    if (!items || items.length === 0) continue;

    sections.push("", `**${label}**`);
    for (const e of items.slice(0, 10)) {
      // Find relationships for this entity
      const rels = edges.filter(
        (r) => String(r.from_node) === String(e.id) || String(r.to_node) === String(e.id),
      );
      const relStr = rels.slice(0, 3).map((r) => {
        const other = String(r.from_node) === String(e.id) ? String(r.to_node) : String(r.from_node);
        // Extract just the name part from record ID
        const otherName = other.split(":").slice(1).join(":");
        return `${r.type} → ${otherName}`;
      }).join(", ");

      const ext = e.external_source ? ` (${e.external_source})` : "";
      const connections = relStr ? ` | ${relStr}` : "";
      sections.push(`- ${e.name}${ext}${connections}`);
    }
  }

  // Show any remaining types not in the predefined list
  for (const [type, items] of Object.entries(byType)) {
    if (typeLabels[type] || type === "book" || items.length === 0) continue;
    sections.push("", `**${type}**`);
    for (const e of items.slice(0, 5)) {
      sections.push(`- ${e.name}`);
    }
  }

  // Orphan nudge — encourage agent to build relationships
  if (stats.orphans > 0) {
    sections.push(
      "",
      `_${stats.orphans} memories have no relationships yet. Use qmemory_link to connect them._`,
    );
  }

  return sections.join("\n");
}
