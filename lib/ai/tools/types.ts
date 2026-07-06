import type { z } from 'zod';

/**
 * Tool layer for the chat agent. Each tool is a thin, permission-checked wrapper
 * over an existing `lib/*` domain function. The agent loop (`lib/ai/agent.ts`)
 * gives these to the model as OpenAI function tools; when the model calls one we
 * validate its args with the tool's zod `schema`, run `execute`, and feed the
 * result back. Structural writes return a `receipt` (a UI chip); story drafts
 * return a `storyDraft` the client renders as an editable card.
 */

/** A story the assistant has drafted but NOT yet committed — awaits user review. */
export interface StoryProposal {
  kind: 'story';
  title: string;
  summary: string;
  body: string;
  eventYear: number | null;
  people: string[];
}

/** A story draft handed to the client for review, bound to its target family. */
export interface StoryDraft {
  proposal: StoryProposal;
  familyId: string;
  familyName: string;
}

/** How to reverse an applied action — attached to a receipt to power an Undo button. */
export type UndoAction =
  | { kind: 'person'; personId: string }
  | { kind: 'relationship'; relType: 'parent' | 'spouse'; from: string; to: string };

/** A short "✓ did X" chip shown under the assistant's reply for an applied action. */
export interface Receipt {
  label: string;
  detail?: string;
  /** Optional in-app link (e.g. a story or invite URL). */
  href?: string;
  /** If set, the chip offers an Undo button that reverses this action. */
  undo?: UndoAction;
}

/**
 * Per-turn context handed to every tool. `activeFamilyId` is MUTABLE — creating a
 * family mid-turn calls `setActiveFamily` so later tools in the same turn target it.
 * The server action persists the final value to the `activeFamilyId` cookie.
 */
export interface ToolContext {
  userId: string;
  userName: string;
  activeFamilyId: string | null;
  activeFamilyName: string | null;
  setActiveFamily(id: string, name: string): void;
}

export type ToolResult =
  | { ok: true; message: string; receipt?: Receipt; storyDraft?: StoryDraft }
  | { ok: false; error: string };

export interface Tool<A = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/** Helper for tool authors: build a well-typed Tool with inference on the args. */
export function defineTool<A>(tool: Tool<A>): Tool<A> {
  return tool;
}
