'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@mantine/core';
import { IconLogout } from '@tabler/icons-react';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function signOut() {
    setLoading(true);
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <Button
      variant="default"
      leftSection={<IconLogout size={16} />}
      loading={loading}
      onClick={signOut}
    >
      Sign out
    </Button>
  );
}
