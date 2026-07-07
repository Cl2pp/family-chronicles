import type { StoryStatus } from '@/lib/stories';
import type { Dictionary } from '@/lib/i18n';

/** Badge color + label for a story status. */
export function storyStatusMeta(
  status: StoryStatus,
  t: Dictionary,
): { color: string; label: string } {
  switch (status) {
    case 'processing':
      return { color: 'brand', label: t.status.processing };
    case 'ready':
      return { color: 'green', label: t.status.ready };
    case 'failed':
      return { color: 'red', label: t.status.failed };
    case 'draft':
      return { color: 'gray', label: t.status.draft };
    default:
      return { color: 'gray', label: status };
  }
}
