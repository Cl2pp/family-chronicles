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
  designBookLayoutTool,
  getBookTool,
  listBooksTool,
  quoteBookPriceTool,
  renderBookPreviewTool,
  setBookStoriesTool,
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
  quoteBookPriceTool,
  // review-then-save
  draftStoryTool,
  updateStoryTool,
  // direct save — only on the user's explicit request
  saveStoryTool,
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

/** The tool catalog as OpenAI function-tool schemas (parameters derived from each zod schema). */
export function toOpenAISchemas(): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema, { target: 'draft-7' }) as Record<string, unknown>,
    },
  }));
}
