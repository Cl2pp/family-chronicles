import 'dotenv/config';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, chronicles, memberships, stories, storyChronicles, user } from '@/db/schema';
import { putObjectBuffer } from '@/lib/s3';

/**
 * Dev utility: seed a few ready stories with photos into a user's first chronicle,
 * so the book builder has real content to typeset.
 *
 *   npx tsx scripts/seed-book-demo.ts you@example.com
 */

interface MultiPhotoDemo {
  title: string;
  year: number;
  body: string;
  color: string;
  /** Mixed aspect ratios so multi-image layout blocks (row/grid/float/photo-page)
   *  actually get exercised by the auto-layouter. */
  photos: Array<{ label: string; width: number; height: number }>;
}

const MULTI_PHOTO_DEMO: MultiPhotoDemo = {
  title: 'Das Familienfest 1980',
  year: 1980,
  color: '#a8553f',
  body: 'Zum vierzigsten Geburtstag von Werner lud die ganze Familie in den Garten ein. Tische wurden aus drei Haushalten zusammengetragen, und Tante Grete brachte ihren berühmten Bienenstich in einer Kuchenform, die größer war als der Kofferraum ihres Wartburgs.\n\nDie Kinder bauten aus Bierkästen und einer alten Tür eine Wippe, die keine zwei Stunden überlebte. Werner selbst verbrachte den Nachmittag damit, jedem Gast persönlich zu erklären, warum er eigentlich noch gar nicht vierzig fühle.\n\nAls die Sonne unterging, wurden die Tische beiseite geräumt und im Garten getanzt — zur Musik aus einem Kofferradio, das Peter mit einer Antenne aus Alufolie notdürftig empfangsfähig gemacht hatte. Es war eines der letzten Feste, bei dem noch alle vier Großeltern dabei waren.\n\nHilde fotografierte an diesem Tag fast eine ganze Filmrolle voll — Bilder, die Jahrzehnte später den Grundstein für diese Chronik legen sollten. Manche zeigen verschwommene Gesichter, andere sind perfekt scharf; alle zusammen erzählen mehr als jedes einzelne für sich.',
  photos: [
    { label: 'Gruppenfoto, Garten', width: 1500, height: 2000 }, // portrait 3:4
    { label: 'Tanz am Abend', width: 1920, height: 1080 }, // landscape 16:9
    { label: 'Bienenstich', width: 1400, height: 1400 }, // square
    { label: 'Werner am Kofferradio', width: 1000, height: 2500 }, // tall 2:5
    { label: 'Die ganze Familie', width: 4000, height: 3000 }, // large 4:3, highest resolution
  ],
};

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

async function makePhoto(
  label: string,
  color: string,
  width = 1400,
  height = 1000,
): Promise<Buffer> {
  const inset = Math.round(Math.min(width, height) * 0.03);
  const fontSize = Math.max(28, Math.round(Math.min(width, height) * 0.055));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="${color}"/>
    <rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}" fill="none" stroke="#ffffff55" stroke-width="6"/>
    <text x="${width / 2}" y="${height / 2}" font-family="Georgia" font-size="${fontSize}" fill="#ffffffcc" text-anchor="middle">${label}</text>
    <text x="${width / 2}" y="${height / 2 + fontSize * 1.3}" font-family="Georgia" font-size="${Math.round(fontSize * 0.5)}" fill="#ffffff88" text-anchor="middle">${width}×${height}</text>
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

  async function storyExists(title: string): Promise<boolean> {
    const [existing] = await db
      .select({ id: stories.id })
      .from(stories)
      .innerJoin(storyChronicles, eq(storyChronicles.storyId, stories.id))
      .where(and(eq(storyChronicles.chronicleId, m.chronicleId), eq(stories.title, title)))
      .limit(1);
    return !!existing;
  }

  for (const demo of DEMO) {
    if (await storyExists(demo.title)) {
      console.log(`skipping "${demo.title}" — already seeded`);
      continue;
    }
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

  const multi = MULTI_PHOTO_DEMO;
  if (await storyExists(multi.title)) {
    console.log(`skipping "${multi.title}" — already seeded`);
  } else {
    const [story] = await db
      .insert(stories)
      .values({
        submittedBy: u.id,
        title: multi.title,
        summary: multi.title,
        bodyOriginal: multi.body,
        bodyStyled: multi.body,
        inputType: 'text',
        status: 'ready',
        eventDate: new Date(Date.UTC(multi.year, 5, 15)),
        eventDatePrecision: 'year',
      })
      .returning();
    await db.insert(storyChronicles).values({
      storyId: story.id,
      chronicleId: m.chronicleId,
      sharedBy: u.id,
    });
    for (const [i, p] of multi.photos.entries()) {
      const photo = await makePhoto(p.label, multi.color, p.width, p.height);
      const key = `photos/demo-${story.id}-${i}.jpg`;
      await putObjectBuffer(key, photo, 'image/jpeg');
      await db.insert(assets).values({
        storyId: story.id,
        kind: 'photo',
        s3Key: key,
        mimeType: 'image/jpeg',
        bytes: photo.length,
        width: p.width,
        height: p.height,
        caption: p.label,
      });
    }
    console.log(`seeded "${multi.title}" (${story.id}) with ${multi.photos.length} photos`);
  }

  console.log(`Done — demo stories with photos in chronicle "${m.name}".`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
