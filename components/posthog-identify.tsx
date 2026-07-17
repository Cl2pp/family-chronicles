'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';

export function PostHogIdentify({
  userId,
  name,
  email,
}: {
  userId: string;
  name: string;
  email: string;
}) {
  useEffect(() => {
    posthog.identify(userId, { name, email });
  }, [userId, name, email]);
  return null;
}
