import type { StoryStatus } from '@/lib/stories';

/** Badge color + label for a story status. */
export function storyStatusMeta(status: StoryStatus): { color: string; label: string } {
  switch (status) {
    case 'processing':
      return { color: 'brand', label: 'Retelling…' };
    case 'ready':
      return { color: 'green', label: 'Ready' };
    case 'failed':
      return { color: 'red', label: 'Failed' };
    case 'draft':
      return { color: 'gray', label: 'Draft' };
    default:
      return { color: 'gray', label: status };
  }
}
