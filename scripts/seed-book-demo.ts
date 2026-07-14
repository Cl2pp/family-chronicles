import 'dotenv/config';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, chronicles, memberships, stories, storyChronicles, user } from '@/db/schema';
import { putObjectBuffer } from '@/lib/s3';

/**
 * Dev utility: seed a few ready stories with photos into a user's first chronicle,
 * so the book builder has real content to typeset.
 *
 *   npx tsx scripts/seed-book-demo.ts you@example.com
 */

const DEMO: Array<{ title: string; year: number; body: string; photoLabel: string; color: string }> = [
  {
    title: 'Der Sommer am See',
    year: 1972,
    color: '#33658a',
    photoLabel: 'Am See, 1972',
    body: 'Im Sommer 1972 fuhr die ganze Familie zum ersten Mal gemeinsam an den Schweriner See. Hilde erinnerte sich noch Jahrzehnte später an das quietschende Ruderboot, das ihr Vater für zwei Mark am Tag gemietet hatte.\n\nDie Kinder schwammen bis zum Steg hinaus, während die Großmutter am Ufer Streuselkuchen verteilte. Es war der Sommer, in dem Peter schwimmen lernte — aus Angst vor seinem älteren Bruder, wie er später zugab, nicht aus Mut.',
  },
  {
    title: 'Omas Hochzeit',
    year: 1954,
    color: '#86735c',
    photoLabel: 'Hochzeitsfoto, 1954',
    body: 'Hilde und Werner heirateten an einem regnerischen Aprilsamstag im Jahr 1954 in der kleinen Dorfkirche von Banzkow. Weil das Geld knapp war, nähte Hildes Mutter das Brautkleid aus dem Fallschirmstoff, den ein Onkel nach dem Krieg aufbewahrt hatte.\n\nZur Feier gab es Kartoffelsuppe und einen einzigen Kuchen, aber getanzt wurde bis drei Uhr morgens — der Dorfmusiker weigerte sich, vor dem Brautpaar nach Hause zu gehen.',
  },
  {
    title: 'Die erste Fahrt im eigenen Auto',
    year: 1968,
    color: '#5a7a4d',
    photoLabel: 'Der neue Trabant, 1968',
    body: 'Nach acht Jahren Wartezeit stand er endlich vor der Tür: ein papyrusweißer Trabant 601. Werner polierte ihn am ersten Wochenende dreimal, obwohl es zweimal regnete.\n\nDie erste große Fahrt ging nach Thüringen zu Tante Grete. Die Kinder saßen hinten auf der Wolldecke, vorne lief das Radio, und auf dem Rennsteig kochte der Motor — was Werner standhaft als „normale Betriebstemperatur" bezeichnete.',
  },
];

async function makePhoto(label: string, color: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1000">
    <rect width="1400" height="1000" fill="${color}"/>
    <rect x="40" y="40" width="1320" height="920" fill="none" stroke="#ffffff55" stroke-width="6"/>
    <text x="700" y="520" font-family="Georgia" font-size="64" fill="#ffffffcc" text-anchor="middle">${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error('Usage: npx tsx scripts/seed-book-demo.ts <user-email>');

  const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!u) throw new Error(`No user with email ${email}`);
  const [m] = await db
    .select({ chronicleId: memberships.chronicleId, name: chronicles.name })
    .from(memberships)
    .innerJoin(chronicles, eq(memberships.chronicleId, chronicles.id))
    .where(eq(memberships.userId, u.id))
    .limit(1);
  if (!m) throw new Error(`${email} has no chronicle — create one in the app first.`);

  for (const demo of DEMO) {
    const [story] = await db
      .insert(stories)
      .values({
        submittedBy: u.id,
        title: demo.title,
        summary: demo.title,
        bodyOriginal: demo.body,
        bodyStyled: demo.body,
        inputType: 'text',
        status: 'ready',
        eventDate: new Date(Date.UTC(demo.year, 5, 15)),
        eventDatePrecision: 'year',
      })
      .returning();
    await db.insert(storyChronicles).values({
      storyId: story.id,
      chronicleId: m.chronicleId,
      sharedBy: u.id,
    });
    const photo = await makePhoto(demo.photoLabel, demo.color);
    const key = `photos/demo-${story.id}.jpg`;
    await putObjectBuffer(key, photo, 'image/jpeg');
    await db.insert(assets).values({
      storyId: story.id,
      kind: 'photo',
      s3Key: key,
      mimeType: 'image/jpeg',
      bytes: photo.length,
      width: 1400,
      height: 1000,
      caption: demo.photoLabel,
    });
    console.log(`seeded "${demo.title}" (${story.id})`);
  }
  console.log(`Done — 3 ready stories with photos in chronicle "${m.name}".`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
