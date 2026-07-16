import type { MetadataRoute } from 'next';

const SITE_URL = 'https://familienwerk.co';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Auth-gated app surfaces have no public/SEO value (they redirect to /login).
      disallow: [
        '/api/',
        '/chat',
        '/stories',
        '/chronicle',
        '/books',
        '/settings',
        '/account',
        '/invite/',
        '/offline',
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
