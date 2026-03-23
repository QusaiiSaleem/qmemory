/**
 * Session utilities — parsing, message handling, helpers
 *
 * Shared by bootstrap, assemble, compact, and afterTurn.
 */

import {
  query,
  generateId,
} from "../../db/client.js";
import { estimateTokens } from "../../config.js";
import type { QmemoryLogger } from "../../config.js";

// Module-level logger — set by setSessionLogger()
let moduleLogger: QmemoryLogger | null = null;

export function setSessionLogger(logger: QmemoryLogger) {
  moduleLogger = logger;
}

/** Extract ID from string or RecordId: "session:s1234" → "s1234" */
export function sessionIdPart(fullId: unknown): string {
  const str = String(fullId);
  const idx = str.indexOf(":");
  return idx >= 0 ? str.slice(idx + 1) : str;
}

// ---------------------------------------------------------------------------
// Message content extractor
// ---------------------------------------------------------------------------
// OpenClaw messages use content blocks: [{type:"text",text:"..."}, ...]
// NOT plain strings. This helper extracts the text safely.

/**
 * Extract plain text from an OpenClaw message's content field.
 *
 * OpenClaw uses the pi-ai message format where content is:
 *   - string (rare, some user messages)
 *   - array of content blocks: [{type:"text", text:"..."}, {type:"toolCall",...}]
 *
 * Without this helper, you'd get "[object Object]" from .toString() on the array.
 */
export function extractText(content: unknown): string {
  // Already a string — return as-is
  if (typeof content === "string") return content;

  // Array of content blocks — extract text from "text" blocks
  if (Array.isArray(content)) {
    const text = content
      .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
      .map((block: any) => block.text)
      .join("\n");
    // Warn if array had items but none were text blocks (new provider format?)
    if (text.length === 0 && content.length > 0) {
      const types = content.map((b: any) => b?.type ?? typeof b).join(", ");
      moduleLogger?.debug(`extractText: no text blocks in array of ${content.length} items (types: ${types})`);
    }
    return text;
  }

  // Non-null unknown type — log so we catch new provider formats
  if (content !== null && content !== undefined) {
    moduleLogger?.debug(`extractText: unexpected content type: ${typeof content}`);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Session key parser — extracts topic/group/channel from OpenClaw session keys
// Format: agent:<agentId>:<channel>:group:<groupId>:topic:<topicId>
// ---------------------------------------------------------------------------

export interface ParsedSessionKey {
  channel: string;
  chatType: string;
  topicId?: string;
  groupId?: string;
  scope: string;
}

export function parseSessionKey(sessionKey: string): ParsedSessionKey {
  // Default values
  const result: ParsedSessionKey = {
    channel: "unknown",
    chatType: "direct",
    scope: "global",
  };

  if (!sessionKey) return result;

  // Extract channel: agent:<id>:<channel>:...
  const parts = sessionKey.split(":");
  if (parts.length >= 3) {
    result.channel = parts[2]; // "telegram", "whatsapp", etc.
  }

  // Check for group
  const groupIdx = parts.indexOf("group");
  if (groupIdx >= 0 && parts[groupIdx + 1]) {
    result.chatType = "group";
    result.groupId = parts[groupIdx + 1];
    result.scope = `group:${result.groupId}`;
  }

  // Check for topic
  const topicIdx = parts.indexOf("topic");
  if (topicIdx >= 0 && parts[topicIdx + 1]) {
    result.topicId = parts[topicIdx + 1];
    result.scope = `topic:${result.topicId}`;
  }

  // Check for subagent
  if (sessionKey.includes("subagent")) {
    result.chatType = "subagent";
  }

  // Check for cron
  if (sessionKey.includes("cron")) {
    result.chatType = "cron";
  }

  return result;
}

// ---------------------------------------------------------------------------
// ingest() — Store message as node + has_message edge
// ---------------------------------------------------------------------------

export async function ingestMessage(
  params: {
    role: string;
    content: string;
    toolCalls?: unknown[];
    toolName?: string;
  },
  currentSessionId: string,
  logger: QmemoryLogger,
): Promise<{ ingested: boolean; messageId?: string }> {
  const msgIdPart = generateId("m");
  const messageId = `message:${msgIdPart}`;
  const tokenCount = estimateTokens(params.content);

  // Create message node
  // SurrealDB 3.0: option<> fields reject NULL — omit them entirely when absent
  const optionalMsgFields: string[] = [];
  const msgParams: Record<string, unknown> = {
    idPart: msgIdPart,
    sessionId: sessionIdPart(currentSessionId),
    role: params.role,
    content: params.content,
    tokenCount: tokenCount,
  };
  if (params.toolCalls) {
    optionalMsgFields.push("tool_calls: $toolCalls,");
    msgParams.toolCalls = params.toolCalls;
  }
  if (params.toolName) {
    optionalMsgFields.push("tool_name: $toolName,");
    msgParams.toolName = params.toolName;
  }

  await query(
    `CREATE type::record("message", $idPart) CONTENT {
      session: type::record("session", $sessionId),
      role: $role,
      content: $content,
      ${optionalMsgFields.join("\n      ")}
      token_count: $tokenCount,
      created_at: time::now()
    }`,
    msgParams,
  );

  // Create structural edge: session → message
  await query(
    `LET $f = type::record($from); LET $t = type::record($to); RELATE $f->has_message->$t SET created_at = time::now();`,
    { from: currentSessionId, to: messageId },
  );

  logger.debug(`Ingested ${params.role} message (${tokenCount} tokens)`);
  return { ingested: true, messageId };
}

// ---------------------------------------------------------------------------
// afterTurn message storage — stores last 2 messages for cross-session search
// ---------------------------------------------------------------------------

export async function storeRecentMessages(
  messages: unknown[],
  currentSessionId: string,
  logger: QmemoryLogger,
): Promise<void> {
  const sid = sessionIdPart(currentSessionId);
  // Only store the last 2 messages (current turn) to avoid re-storing old ones
  const newMsgs = messages.slice(-2);
  for (const m of newMsgs) {
    const text = extractText((m as any)?.content);
    if (!text || text.length < 5) continue;
    const role = (m as any)?.role ?? "unknown";
    const msgIdPart = generateId("m");
    const msgId = `message:${msgIdPart}`;
    await query(
      `CREATE type::record("message", $idPart) CONTENT {
        session: type::record("session", $sid),
        role: $role,
        content: $content,
        token_count: $tokenCount,
        created_at: time::now()
      }`,
      {
        idPart: msgIdPart,
        sid,
        role,
        content: text.slice(0, 2000), // Cap to avoid huge records
        tokenCount: estimateTokens(text),
      },
    );
    // Create structural edge
    await query(
      `LET $f = type::record("session", $sid); LET $t = type::record($to);
       RELATE $f->has_message->$t SET created_at = time::now();`,
      { sid, to: msgId },
    );
  }
}
