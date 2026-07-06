import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import {
  createFamilyTool,
  listFamiliesTool,
  switchFamilyTool,
  updateFamilySettingsTool,
} from './families';
import {
  addPersonTool,
  deletePersonTool,
  editPersonTool,
  getFamilyTreeTool,
  relatePeopleTool,
} from './people';
import {
  draftStoryTool,
  getStoryTool,
  listStoriesTool,
  shareStoryTool,
  updateStoryTool,
} from './stories';
import { inviteMemberTool } from './members';
import type { Tool } from './types';

export * from './types';

/** Every tool the chat agent can call, in a sensible presentation order. */
export const tools: Tool[] = [
  // read
  listFamiliesTool,
  getFamilyTreeTool,
  listStoriesTool,
  getStoryTool,
  // setup / structure (execute directly)
  createFamilyTool,
  switchFamilyTool,
  addPersonTool,
  relatePeopleTool,
  editPersonTool,
  deletePersonTool,
  updateFamilySettingsTool,
  inviteMemberTool,
  shareStoryTool,
  // review-then-save
  draftStoryTool,
  updateStoryTool,
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
