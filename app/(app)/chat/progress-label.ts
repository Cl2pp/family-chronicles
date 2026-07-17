import type { Dictionary } from '@/lib/i18n';

type ChatDict = Dictionary['chat'];

/** "Leonhard Koch" from an add_person args preview, or whatever single name a tool names. */
function personLabel(args: Record<string, string>): string | null {
  if (args.firstName) return [args.firstName, args.familyName].filter(Boolean).join(' ');
  return args.name || args.personName || null;
}

/**
 * One live status line for a tool call the agent just started — "Adding Leonhard
 * Koch…" — from the whitelisted args preview the stream carries. Pure lookup so the
 * label always renders in the viewer's language (the server never composes prose).
 * Unknown tools fall back to a generic "working" line rather than showing tool names.
 */
export function progressLabel(t: ChatDict, tool: string, args: Record<string, string>): string {
  const p = t.progress;
  switch (tool) {
    case 'get_family_tree':
      return p.readingTree;
    case 'add_person': {
      const label = personLabel(args);
      return label ? p.addingPerson(label) : p.working;
    }
    case 'relate_people':
      return args.personName && args.relativeName
        ? p.linkingPeople(args.personName, args.relativeName)
        : p.working;
    case 'unrelate_people':
      return args.personName && args.relativeName
        ? p.unlinkingPeople(args.personName, args.relativeName)
        : p.working;
    case 'edit_person': {
      const label = personLabel(args);
      return label ? p.editingPerson(label) : p.working;
    }
    case 'delete_person': {
      const label = personLabel(args);
      return label ? p.removingPerson(label) : p.working;
    }
    case 'confirm_people_changes':
      return p.applyingChanges;
    case 'draft_story':
      return p.draftingStory;
    case 'update_story':
      return p.updatingStory;
    case 'save_story':
      return p.savingStory;
    case 'list_stories':
    case 'get_story':
      return p.readingStories;
    case 'share_story':
      return p.sharingStory;
    case 'tag_story_people':
    case 'untag_story_people':
      return p.taggingPeople;
    case 'invite_member':
      return p.invitingMember;
    case 'create_chronicle':
    case 'switch_chronicle':
      return p.settingUpChronicle;
    case 'update_chronicle_settings':
      return p.updatingSettings;
    default:
      // Every book tool, cancel_people_changes, list_chronicles, and whatever gets
      // added later — a calm generic line beats leaking tool names.
      return tool.includes('book') ? p.workingOnBook : p.working;
  }
}
