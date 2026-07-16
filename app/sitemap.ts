import type { MetadataRoute } from 'next';

const SITE_URL = 'https://familienwerk.co';

// Only the public marketing/entry pages; everything else is invite-only app.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: 'monthly', priority: 1 },
    { url: `${SITE_URL}/signup`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${SITE_URL}/login`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
