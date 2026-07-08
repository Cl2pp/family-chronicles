import { permanentRedirect } from 'next/navigation';

/** Account lives as a tab on Settings now; keep old links and bookmarks working. */
export default function AccountPage() {
  permanentRedirect('/settings?tab=account');
}
