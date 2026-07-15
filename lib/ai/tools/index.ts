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
