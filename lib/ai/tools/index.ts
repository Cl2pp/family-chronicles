import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import {
  createChronicleTool,
  listChroniclesTool,
  switchChronicleTool,
  updateChronicleSettingsTool,
} from './chronicles';
import {
  addPersonTool,
  deletePersonTool,
  editPersonTool,
  getFamilyTreeTool,
  relatePeopleTool,
  unrelatePeopleTool,
} from './people';
import { cancelPeopleChangesTool, confirmPeopleChangesTool } from './people-confirm';
import {
  draftStoryTool,
  getStoryTool,
  listStoriesTool,
  saveStoryTool,
  shareStoryTool,
  tagStoryPeopleTool,
  untagStoryPeopleTool,
  updateStoryTool,
} from './stories';
import { inviteMemberTool } from './members';
import {
  createBookTool,
  deleteBookTool,
  designBookLayoutTool,
  getBookTool,
  listBooksTool,
  quoteBookPriceTool,
  renderBookPreviewTool,
  resetBookLayoutTool,
  setBookStoriesTool,
  updateBookLayoutTool,
  updateBookTool,
} from './books';
import { getPhotoBookTool, redesignPhotoBookTool, updatePhotoBookLayoutTool } from './photo-books';
import type { Tool } from './types';

export * from './types';

/** Every tool the chat agent can call, in a sensible presentation order. */
export const tools: Tool[] = [
  // read
  listChroniclesTool,
  getFamilyTreeTool,
  listStoriesTool,
  getStoryTool,
  // setup / structure (execute directly)
  createChronicleTool,
  switchChronicleTool,
  addPersonTool,
  relatePeopleTool,
  unrelatePeopleTool,
  editPersonTool,
  deletePersonTool,
  confirmPeopleChangesTool,
  cancelPeopleChangesTool,
  updateChronicleSettingsTool,
  inviteMemberTool,
  shareStoryTool,
  tagStoryPeopleTool,
  untagStoryPeopleTool,
  // books (printable memoir)
  listBooksTool,
  getBookTool,
  createBookTool,
  updateBookTool,
  setBookStoriesTool,
  renderBookPreviewTool,
  designBookLayoutTool,
  updateBookLayoutTool,
  resetBookLayoutTool,
  quoteBookPriceTool,
  deleteBookTool,
  // review-then-save
  draftStoryTool,
  updateStoryTool,
  // direct save — only on the user's explicit request
  saveStoryTool,
];

/**
 * Photo-book tools — deliberately NOT part of `tools` above: they're scoped to the
 * photo-book builder's own embedded chat (`runPhotoBookAgent`) only, never the general
 * chat agent or the story-book chat (`runBookAgent`'s `bookTools`), so neither of those
 * can see or call `update_photo_book_layout`/`redesign_photo_book` on someone's photo
 * book, and the photo-book chat never sees the story-only book tools either
 * (docs/PHOTO_BOOK_PLAN.md PR4).
 */
export const photoBookTools: Tool[] = [getPhotoBookTool, updatePhotoBookLayoutTool, redesignPhotoBookTool];

/** A tool catalog as OpenAI function-tool schemas (parameters derived from each zod
 *  schema). Defaults to the full chat-agent catalog; scoped agents (e.g. the book
 *  builder's chat) pass their own subset. */
export function toOpenAISchemas(list: Tool[] = tools): ChatCompletionTool[] {
  return list.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema, { target: 'draft-7' }) as Record<string, unknown>,
    },
  }));
}
