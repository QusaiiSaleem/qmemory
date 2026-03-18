/**
 * Person & Contact Management
 *
 * Creates people as entities with multiple linked identities (contacts).
 * A person can have WhatsApp, email, Telegram, Smartsheet IDs — all linked
 * via `relates` edges with type "has_identity".
 *
 * Pattern:
 *   entity:ahmed (type: "person", name: "Ahmed")
 *     → relates → entity:ahmed_wa (type: "contact", external_source: "whatsapp")
 *        type: "has_identity"
 *     → relates → entity:ahmed_email (type: "contact", external_source: "gmail")
 *        type: "has_identity"
 *
 * Query "everything about Ahmed":
 *   SELECT * FROM entity:ahmed->relates WHERE type = "has_identity";
 *   SELECT * FROM entity:ahmed<-relates<-memory;  -- all memories about Ahmed
 */

import { query, generateId } from "../db/client.js";
import { linkNodes } from "./link.js";
import { consoleLogger } from "../config.js";
import type { QmemoryLogger, Entity } from "../config.js";

let logger: QmemoryLogger = consoleLogger;

export function setPersonLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContactIdentity {
  source: string;    // "whatsapp", "telegram", "hey", "gmail", etc.
  id: string;        // phone number, email, username, user ID
  url?: string;      // direct URL (optional)
  label?: string;    // display label: "Work email", "Personal WhatsApp"
}

export interface CreatePersonParams {
  name: string;
  aliases?: string[];
  contacts?: ContactIdentity[];
}

export interface CreatePersonResult {
  person_id: string;
  contact_ids: string[];
  links_created: number;
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

/**
 * Create a person entity with linked contact identities.
 * If person already exists (by name), adds new contacts to existing.
 */
export async function createPerson(
  params: CreatePersonParams,
): Promise<CreatePersonResult> {
  const { name, aliases = [], contacts = [] } = params;

  // Search for existing person by name or alias
  const existing = await query<Entity>(
    `SELECT * FROM entity WHERE type = "person" AND (
      name = $name OR $name IN aliases
    ) LIMIT 1;`,
    { name },
  );

  let personId: string;

  if (existing && existing.length > 0) {
    // Person exists — add new aliases if provided
    personId = String(existing[0].id);
    if (aliases.length > 0) {
      const currentAliases = existing[0].aliases || [];
      const newAliases = [...new Set([...currentAliases, ...aliases])];
      await query(
        `UPDATE type::record($id) SET aliases = $aliases, updated_at = time::now();`,
        { id: personId, aliases: newAliases },
      );
    }
    logger.info(`Person exists: ${personId} (${name})`);
  } else {
    // Create new person entity
    personId = `entity:${generateId("p")}`;
    await query(
      `CREATE type::record($id) CONTENT {
        name: $name,
        type: "person",
        aliases: $aliases,
        created_at: time::now(),
        updated_at: time::now()
      };`,
      { id: personId, name, aliases },
    );
    logger.info(`Created person: ${personId} (${name})`);
  }

  // Create contact entities and link them
  const contactIds: string[] = [];
  let linksCreated = 0;

  for (const contact of contacts) {
    // Check if this contact already exists
    const existingContact = await query<Entity>(
      `SELECT * FROM entity WHERE type = "contact"
       AND external_source = $source AND external_id = $extId LIMIT 1;`,
      { source: contact.source, extId: contact.id },
    );

    let contactId: string;

    if (existingContact && existingContact.length > 0) {
      contactId = String(existingContact[0].id);
      logger.debug(`Contact exists: ${contactId} (${contact.source}:${contact.id})`);
    } else {
      // Create new contact entity
      contactId = `entity:${generateId("c")}`;
      const contactName = contact.label || `${name} (${contact.source})`;
      await query(
        `CREATE type::record($id) CONTENT {
          name: $contactName,
          type: "contact",
          aliases: [],
          external_source: $source,
          external_id: $extId,
          external_url: $url,
          external_channel: $extId,
          created_at: time::now(),
          updated_at: time::now()
        };`,
        {
          id: contactId,
          contactName,
          source: contact.source,
          extId: contact.id,
          url: contact.url || null,
        },
      );
      logger.info(`Created contact: ${contactId} (${contact.source}:${contact.id})`);
    }

    contactIds.push(contactId);

    // Link person → contact via "has_identity"
    // Check if link already exists
    const existingLink = await query(
      `SELECT * FROM relates WHERE in = type::record($from) AND out = type::record($to) AND type = "has_identity" LIMIT 1;`,
      { from: personId, to: contactId },
    );

    if (!existingLink || existingLink.length === 0) {
      await linkNodes({
        from_id: personId,
        to_id: contactId,
        type: "has_identity",
        reason: `${name}'s ${contact.source} identity`,
        created_by: "agent",
      });
      linksCreated++;
    }
  }

  return { person_id: personId, contact_ids: contactIds, links_created: linksCreated };
}

/**
 * Find a person and all their linked identities.
 * Returns the person entity + all contacts.
 */
export async function findPerson(
  nameOrId: string,
): Promise<{ person: Entity | null; contacts: Entity[] }> {
  // Try by ID first
  let person: Entity | null = null;
  if (nameOrId.startsWith("entity:")) {
    const rows = await query<Entity>(
      `SELECT * FROM type::record($id);`,
      { id: nameOrId },
    );
    person = rows?.[0] ?? null;
  }

  // Try by name or alias
  if (!person) {
    const rows = await query<Entity>(
      `SELECT * FROM entity WHERE type = "person" AND (
        name = $name OR $name IN aliases
      ) LIMIT 1;`,
      { name: nameOrId },
    );
    person = rows?.[0] ?? null;
  }

  if (!person) return { person: null, contacts: [] };

  // Find all linked contacts (has_identity edges)
  const contacts = await query<Entity>(
    `SELECT out.* FROM relates WHERE in = type::record($id) AND type = "has_identity";`,
    { id: String(person.id) },
  ) ?? [];

  return { person, contacts };
}

/**
 * Find all memories and relationships linked to a person (across all identities).
 * Traverses: person → has_identity → contacts, then finds all relates edges.
 */
export async function findPersonContext(
  nameOrId: string,
): Promise<{
  person: Entity | null;
  contacts: Entity[];
  memories: Array<{ id: string; content: string; type: string }>;
}> {
  const { person, contacts } = await findPerson(nameOrId);
  if (!person) return { person: null, contacts: [], memories: [] };

  // Collect all entity IDs (person + contacts)
  const allIds = [String(person.id), ...contacts.map(c => String(c.id))];

  // Find all memories linked to any of these entities
  const memories: Array<{ id: string; content: string; type: string }> = [];
  for (const entityId of allIds) {
    const related = await query<{ id: string; content: string; type: string }>(
      `SELECT in.id, in.content, type FROM relates WHERE out = type::record($id) AND in.id CONTAINS "memory:";`,
      { id: entityId },
    );
    if (related) memories.push(...related);
  }

  return { person, contacts, memories };
}
