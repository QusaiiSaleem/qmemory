/**
 * Linker barrel re-export — redirects to services/linker.ts
 *
 * Keeps existing imports from "./linker.js" working.
 */

export { createLinkerService } from "./services/linker.js";
