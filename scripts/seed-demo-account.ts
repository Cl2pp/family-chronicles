import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import {
  assets,
  books,
  bookStories,
  chronicles,
  contributions,
  conversations,
  memberships,
  messages,
  people,
  stories,
  storyChronicles,
  storyPeople,
  user,
} from '@/db/schema';
import { ensurePersonForUser, connectPeople, addPersonToChronicle } from '@/lib/people';
import { putObjectBuffer } from '@/lib/s3';
import { generateThumbnail } from '@/lib/thumbnails';
import { openrouter } from '@/lib/ai/client';

/**
 * Demo-account seeder: fills one account with a complete, convincing showcase —
 * a four-generation family tree (10 people, avatars), 10 ready stories with
 * source-material contributions and era-styled photos, a sample chat, and a book.
 *
 *   npx tsx scripts/seed-demo-account.ts demo@example.com
 *
 * Photos are AI-generated once (OpenRouter, `IMAGE_MODEL` env or Gemini image
 * default) and cached in SEED_IMAGE_DIR (default ./seed-demo-images), so a
 * rehearsal run and the production run upload identical images. Idempotent:
 * existing people/stories/book/chat are skipped, never duplicated.
 */

const IMAGE_MODEL = process.env.IMAGE_MODEL ?? 'google/gemini-2.5-flash-image';
const IMAGE_DIR = process.env.SEED_IMAGE_DIR ?? path.join(process.cwd(), 'seed-demo-images');

/* ────────────────────────────────────────────────────────────────────────────
 * The Müller family — 10 people, 4 generations
 * ──────────────────────────────────────────────────────────────────────────── */

interface PersonSpec {
  key: string;
  displayName: string;
  givenName: string;
  familyName: string;
  birthFamilyName?: string;
  gender: 'male' | 'female';
  born?: [number, number, number] | number; // [y,m,d] with day precision, or year
  bornCirca?: boolean;
  died?: [number, number, number] | number;
  notes?: string;
  /** True for the person node that represents the demo account itself. */
  isSelf?: boolean;
  avatarPrompt: string;
}

const PEOPLE: PersonSpec[] = [
  {
    key: 'heinrich',
    displayName: 'Heinrich Müller',
    givenName: 'Heinrich',
    familyName: 'Müller',
    gender: 'male',
    born: [1921, 3, 4],
    died: [1998, 11, 20],
    notes:
      'Tischlermeister in Lüneburg. Gründete 1952 die Werkstatt in der Salzstraße, die die Familie über zwei Generationen prägte.',
    avatarPrompt:
      'Authentic vintage black and white portrait photograph from the 1950s: a German craftsman in his late 30s, short combed-back hair, weathered friendly face, wearing a collared work shirt, looking at the camera. Studio portrait, film grain, slightly faded scanned print. No text, no watermark.',
  },
  {
    key: 'kaethe',
    displayName: 'Käthe Müller',
    givenName: 'Käthe',
    familyName: 'Müller',
    birthFamilyName: 'Vogel',
    gender: 'female',
    born: 1925,
    died: 2011,
    notes: 'Geborene Vogel. Kam 1946 aus Pommern nach Lüneburg — mit ihrer Mutter und einem einzigen Koffer.',
    avatarPrompt:
      'Authentic vintage black and white portrait photograph from the early 1950s: a German woman in her mid 20s, hair pinned back in the fashion of the time, gentle serious expression, simple blouse. Studio portrait, film grain, slightly faded scanned print. No text, no watermark.',
  },
  {
    key: 'otto',
    displayName: 'Otto Brandt',
    givenName: 'Otto',
    familyName: 'Brandt',
    gender: 'male',
    born: 1919,
    died: 1989,
    notes: 'Lokführer bei der Bundesbahn. Sein Schrebergarten in der Kolonie „Morgensonne" war sein Königreich.',
    avatarPrompt:
      'Authentic vintage black and white portrait photograph from the late 1950s: a German railway worker in his early 40s, sturdy build, kind eyes, slightly receding hairline, wearing a dark uniform jacket. Film grain, slightly faded scanned print. No text, no watermark.',
  },
  {
    key: 'elfriede',
    displayName: 'Elfriede Brandt',
    givenName: 'Elfriede',
    familyName: 'Brandt',
    birthFamilyName: 'Krüger',
    gender: 'female',
    born: 1924,
    died: 2015,
    notes: 'Geborene Krüger. Ihr Apfelkuchen ist bis heute Familienlegende — das Rezept stand nie auf Papier.',
    avatarPrompt:
      'Authentic vintage black and white portrait photograph from the late 1950s: a warm-faced German woman in her mid 30s, wavy pinned hair, soft smile, floral blouse. Film grain, slightly faded scanned print. No text, no watermark.',
  },
  {
    key: 'werner',
    displayName: 'Werner Müller',
    givenName: 'Werner',
    familyName: 'Müller',
    gender: 'male',
    born: [1948, 6, 2],
    died: [2020, 4, 14],
    notes: 'Übernahm 1975 die Tischlerei seines Vaters. Baute für jedes Kind der Familie die Schultüte selbst.',
    avatarPrompt:
      'Faded color portrait photograph from the late 1970s, Agfacolor tones: a German man around 30 with sideburns and a confident smile, open collar shirt with wide lapels. Amateur photo, film grain, slight color shift towards orange. No text, no watermark.',
  },
  {
    key: 'ingrid',
    displayName: 'Ingrid Müller',
    givenName: 'Ingrid',
    familyName: 'Müller',
    birthFamilyName: 'Brandt',
    gender: 'female',
    born: [1952, 9, 18],
    notes: 'Geborene Brandt. Lehrerin für Deutsch und Geschichte — und die eigentliche Chronistin der Familie: sie fotografierte alles.',
    avatarPrompt:
      'Faded color portrait photograph from the late 1970s, Agfacolor tones: a German woman in her mid 20s with shoulder-length brown hair, warm intelligent smile, wearing a patterned blouse. Amateur photo, film grain, slight color shift. No text, no watermark.',
  },
  {
    key: 'martin',
    displayName: 'Martin Müller',
    givenName: 'Martin',
    familyName: 'Müller',
    gender: 'male',
    born: [1978, 5, 11],
    isSelf: true,
    notes: 'Hat diese Chronik begonnen, damit die Geschichten der Familie nicht verloren gehen.',
    avatarPrompt:
      'Modern natural-light portrait photograph: a friendly German man in his mid 40s, short brown hair, slight stubble, casual dark sweater, soft outdoor background. Realistic smartphone photo quality. No text, no watermark.',
  },
  {
    key: 'sabine',
    displayName: 'Sabine Müller',
    givenName: 'Sabine',
    familyName: 'Müller',
    birthFamilyName: 'Weber',
    gender: 'female',
    born: [1980, 2, 23],
    notes: 'Geborene Weber, aus Hannover. Lernte Martin 2003 im Studium in Hamburg kennen.',
    avatarPrompt:
      'Modern natural-light portrait photograph: a German woman in her early 40s, blonde shoulder-length hair, warm open smile, light blouse, soft garden background. Realistic smartphone photo quality. No text, no watermark.',
  },
  {
    key: 'claudia',
    displayName: 'Claudia Hoffmann',
    givenName: 'Claudia',
    familyName: 'Hoffmann',
    birthFamilyName: 'Müller',
    gender: 'female',
    born: [1975, 12, 1],
    notes: 'Geborene Müller, Martins große Schwester. Schrieb als Einzige Omas Apfelkuchen-Rezept auf.',
    avatarPrompt:
      'Modern natural-light portrait photograph: a German woman in her late 40s, dark chin-length hair, glasses, confident friendly expression, dark blazer. Realistic smartphone photo quality. No text, no watermark.',
  },
  {
    key: 'lena',
    displayName: 'Lena Müller',
    givenName: 'Lena',
    familyName: 'Müller',
    gender: 'female',
    born: [2010, 8, 30],
    notes: 'Martins und Sabines Tochter. Für sie wird diese Chronik geschrieben.',
    avatarPrompt:
      'Modern natural-light portrait photograph: a cheerful German girl around 12 years old, light brown braided hair, freckles, colorful t-shirt, park background. Realistic smartphone photo quality. No text, no watermark.',
  },
];

/** subject `rel` of relative — mirrors lib/people edge semantics. */
const EDGES: Array<{ type: 'parent' | 'spouse'; from: string; to: string }> = [
  { type: 'spouse', from: 'heinrich', to: 'kaethe' },
  { type: 'parent', from: 'heinrich', to: 'werner' },
  { type: 'parent', from: 'kaethe', to: 'werner' },
  { type: 'spouse', from: 'otto', to: 'elfriede' },
  { type: 'parent', from: 'otto', to: 'ingrid' },
  { type: 'parent', from: 'elfriede', to: 'ingrid' },
  { type: 'spouse', from: 'werner', to: 'ingrid' },
  { type: 'parent', from: 'werner', to: 'martin' },
  { type: 'parent', from: 'ingrid', to: 'martin' },
  { type: 'parent', from: 'werner', to: 'claudia' },
  { type: 'parent', from: 'ingrid', to: 'claudia' },
  { type: 'spouse', from: 'martin', to: 'sabine' },
  { type: 'parent', from: 'martin', to: 'lena' },
  { type: 'parent', from: 'sabine', to: 'lena' },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Stories — 10, chronological, with era-styled photos
 * ──────────────────────────────────────────────────────────────────────────── */

interface PhotoSpec {
  /** cache filename stem, also the deterministic S3 key stem */
  file: string;
  prompt: string;
  caption: string;
  width: number;
  height: number;
}

interface StorySpec {
  slug: string;
  title: string;
  summary: string;
  inputType: 'text' | 'voice' | 'chat';
  eventDate: Date;
  eventDatePrecision: 'day' | 'month' | 'year' | 'circa';
  people: string[];
  raw: string;
  styled: string;
  photos: PhotoSpec[];
  /** index into photos[] to use as the book cover */
  coverPhoto?: number;
}

const BW_40s =
  'Authentic vintage black and white photograph from late 1940s Germany, amateur photo, film grain, slightly faded and scratched scanned print, soft focus. No text, no watermark.';
const BW_50s =
  'Authentic vintage black and white photograph from 1950s West Germany, amateur photo, film grain, slightly faded scanned print. No text, no watermark.';
const BW_60s =
  'Authentic vintage black and white photograph from 1960s West Germany, amateur snapshot, film grain, slightly faded scanned print. No text, no watermark.';
const COLOR_70s =
  'Faded color photograph from the mid 1970s, Agfacolor film tones with orange-brown color shift, amateur snapshot, film grain, scanned print. No text, no watermark.';
const COLOR_80s =
  'Faded color photograph from the mid 1980s, Kodak film tones, slightly washed out colors, amateur family snapshot, film grain, scanned print. No text, no watermark.';
const COLOR_90s =
  'Color photograph from the mid 1990s taken with a compact film camera and flash, warm slightly grainy tones, amateur family snapshot. No text, no watermark.';
const DIGITAL_00s =
  'Photograph from 2008 taken with an early consumer digital camera, natural colors, slight softness. No text, no watermark.';
const MODERN =
  'Modern smartphone photograph, crisp and natural colors, realistic amateur family photo. No text, no watermark.';

const STORIES: StorySpec[] = [
  {
    slug: 'erntedankfest',
    title: 'Wie Heinrich und Käthe sich fanden',
    summary:
      'Käthe kommt 1946 mit einem einzigen Koffer aus Pommern nach Lüneburg — und ein junger Tischler tritt ihr beim Erntedankfest dreimal auf die Füße.',
    inputType: 'voice',
    eventDate: new Date(Date.UTC(1947, 9, 5)),
    eventDatePrecision: 'year',
    people: ['heinrich', 'kaethe'],
    raw: 'Also, das hat Oma Käthe immer wieder erzählt, jedes Weihnachten eigentlich. Sie ist ja sechsundvierzig aus Pommern nach Lüneburg gekommen, mit ihrer Mutter und einem einzigen Koffer, mehr war nicht. Sie hat dann in der Wäscherei am Sande gearbeitet. Und beim Erntedankfest siebenundvierzig, in der Gaststätte Zur Krone, da hat Opa Heinrich sie zum Tanzen aufgefordert. Er konnte überhaupt nicht tanzen, sagt sie, er hat ihr dreimal auf die Füße getreten. Aber er hat sich so umständlich entschuldigt, dass sie lachen musste. Danach stand er jeden Sonntag um Punkt drei zum Kaffee vor der Tür, bis Uroma irgendwann gesagt hat: Nun heiratet doch endlich, das spart Kaffee. Achtundvierzig haben sie dann geheiratet.',
    styled:
      'Käthe war einundzwanzig, als sie im Herbst 1946 mit ihrer Mutter und einem einzigen Koffer in Lüneburg ankam. Pommern, ihre Heimat, gab es für sie von da an nur noch in Erzählungen. Sie fand Arbeit in der Wäscherei am Sande und teilte sich mit der Mutter ein Zimmer, in dem der Ofen mehr rauchte als heizte.\n\nEin Jahr später, beim Erntedankfest in der Gaststätte „Zur Krone", fasste sich ein junger Tischler ein Herz. Heinrich Müller konnte nicht tanzen — er trat ihr, so erzählte Käthe es ihr Leben lang, gleich dreimal auf die Füße. Aber er entschuldigte sich so ernsthaft und so umständlich, dass sie lachen musste. Und wer sie zum Lachen brachte, in diesem Herbst, in dieser Stadt, in der sie niemanden kannte, der hatte gewonnen.\n\nVon da an erschien Heinrich jeden Sonntag um Punkt drei zum Kaffee, bis Käthes Mutter eines Tages trocken bemerkte, nun könne man auch heiraten, das spare Kaffee. Im Frühjahr 1948 taten die beiden ihr den Gefallen. Es war, wie Käthe später sagte, die beste Entscheidung, die je ein Mann beim Tanzen für sie getroffen hat.',
    photos: [
      {
        file: 'erntedankfest-paar',
        prompt: `${BW_40s} A young German couple in their twenties posing arm in arm in front of a rural half-timbered tavern decorated with harvest garlands, the man in a plain suit, the woman in a simple knee-length dress, both smiling shyly. Portrait orientation.`,
        caption: 'Heinrich und Käthe beim Erntedankfest, 1947',
        width: 1200,
        height: 1600,
      },
    ],
  },
  {
    slug: 'werkstatt',
    title: 'Die Werkstatt in der Salzstraße',
    summary:
      'Mit einem Kredit von 3.000 Mark und dreißig bestellten Schulbänken beginnt 1952 die Geschichte der Tischlerei Müller.',
    inputType: 'text',
    eventDate: new Date(Date.UTC(1952, 3, 1)),
    eventDatePrecision: 'year',
    people: ['heinrich', 'kaethe', 'werner'],
    raw: 'Opa Heinrich hat 1952 die Tischlerei in der Salzstraße aufgemacht. Das Startkapital war ein Kredit über 3.000 Mark — dafür hat Oma Käthe heimlich einen Teil ihrer Aussteuer verkauft, das hat sie ihm erst Jahre später gebeichtet. Die erste große Bestellung waren dreißig Schulbänke für die neue Volksschule. Papa (Werner) war damals vier und hat einen eigenen kleinen Besen bekommen, um die Späne zu fegen. Er hat später immer gesagt, so hätte alles angefangen.',
    styled:
      'Im Frühjahr 1952 drehte Heinrich Müller zum ersten Mal den Schlüssel im Schloss der eigenen Werkstatt. Die Salzstraße roch nach frischem Holz, nach Leim und nach Anfang. Das Startkapital: ein Kredit über 3.000 Mark, für den Käthe heimlich einen Teil ihrer Aussteuer verkauft hatte — eine Beichte, die sie ihm erst Jahre später machte, als die Werkstatt längst lief.\n\nDie erste große Bestellung waren dreißig Schulbänke für die neue Volksschule. Heinrich arbeitete sechs Wochen lang bis in die Nacht, und als die Bänke ausgeliefert waren, kaufte er Käthe vom ersten verdienten Geld einen Wintermantel und sich selbst — nichts.\n\nDer kleine Werner, damals vier Jahre alt, bekam einen eigenen Besen, kindgerecht abgesägt, und fegte mit großem Ernst die Hobelspäne zusammen. „So hat alles angefangen", sagte er später, wenn er die Geschichte erzählte — und man wusste nie genau, ob er die Werkstatt meinte oder sich selbst.',
    photos: [
      {
        file: 'werkstatt-heinrich',
        prompt: `${BW_50s} A proud German carpenter in work clothes standing in front of a small workshop with a wooden sign above the door, workbenches and stacked timber visible through the open door, 1950s street. Landscape orientation.`,
        caption: 'Heinrich vor der neuen Werkstatt, 1952',
        width: 1600,
        height: 1200,
      },
    ],
  },
  {
    slug: 'schrebergarten',
    title: 'Ottos Schrebergarten',
    summary:
      'Feierabend hieß für Otto Brandt: Kolonie „Morgensonne", Parzelle 14 — und der ewige Wettstreit mit Nachbar Paulsen um die dicksten Tomaten.',
    inputType: 'voice',
    eventDate: new Date(Date.UTC(1963, 6, 1)),
    eventDatePrecision: 'circa',
    people: ['otto', 'elfriede', 'ingrid'],
    raw: 'Mama erzählt das so: Opa Otto war Lokführer, und wenn er von der Schicht kam, ist er nicht nach Hause, sondern erstmal in den Garten. Kolonie Morgensonne, Parzelle vierzehn. Er hatte da diesen ewigen Wettstreit mit Nachbar Paulsen, wer die dickeren Tomaten zieht. Einmal hat Paulsen nachts heimlich gegossen, das hat Opa ihm nie verziehen. Oma Elfriede hat aus allem, was der Garten hergab, Eingemachtes gemacht, der Keller stand voll bis unter die Decke. Und Mama saß als Kind im Himbeerstrauch und hat mehr gegessen als gepflückt.',
    styled:
      'Wenn Otto Brandt seine Lok abgestellt hatte und aus der Schicht kam, führte sein Heimweg selten direkt nach Hause. Er führte in die Kolonie „Morgensonne", Parzelle 14 — sechshundert Quadratmeter Königreich mit Laube, Fahnenstange und den geradesten Gemüsebeeten der ganzen Anlage.\n\nMit Nachbar Paulsen von Parzelle 15 verband ihn eine Männerfreundschaft, die im Sommer regelmäßig zum Tomatenkrieg wurde. Wer zog die dicksten? Als Paulsen in einem trockenen Juli nachts heimlich goss, während Otto im Führerstand nach Bremen unterwegs war, sprachen die beiden drei Wochen kein Wort — gewogen wurde trotzdem.\n\nElfriede verwandelte alles, was die Parzelle hergab, in Eingemachtes: Bohnen, Gurken, Mirabellen, Apfelmus. Der Kellerregale bogen sich bis unter die Decke. Und die kleine Ingrid saß derweil im Himbeerstrauch und aß, wie sie heute freimütig zugibt, deutlich mehr, als sie pflückte.\n\nAls Otto 1989 starb, fand die Familie in der Laube ein Heft, in dem er dreißig Jahre lang jede Ernte notiert hatte. Die letzte Zeile lautet: „Tomaten dieses Jahr besser als Paulsen. Endlich."',
    photos: [
      {
        file: 'schrebergarten-otto',
        prompt: `${BW_60s} A sturdy German man in his 40s wearing suspenders and a flat cap, proudly holding a wooden crate of tomatoes and vegetables in an allotment garden, neat vegetable beds and a small garden shed behind him. Landscape orientation.`,
        caption: 'Otto mit der Ernte, Parzelle 14',
        width: 1600,
        height: 1200,
      },
      {
        file: 'schrebergarten-laube',
        prompt: `${BW_60s} A small German allotment garden summer house (Laube) with a little flag pole, dahlias and bean poles in front, a woman in an apron setting a small garden table with coffee. Square format.`,
        caption: 'Die Laube in der Kolonie „Morgensonne", um 1963',
        width: 1400,
        height: 1400,
      },
    ],
  },
  {
    slug: 'kaefer',
    title: 'Werners erster Käfer',
    summary:
      'Ein gebrauchter VW Käfer, Baujahr 58, das ganze Lehrlingsgeld — und eine Panne auf der ersten Fahrt nach Hamburg.',
    inputType: 'text',
    eventDate: new Date(Date.UTC(1968, 3, 1)),
    eventDatePrecision: 'month',
    people: ['werner', 'heinrich'],
    raw: 'Papa hat sich 1968 mit zwanzig seinen ersten Käfer gekauft, Baujahr 58, taubenblau, das ganze gesparte Lehrlingsgeld. Opa Heinrich fand das Unsinn — ein Tischler braucht einen Kombi, hat er gesagt. Auf der ersten großen Fahrt nach Hamburg ist ihm dann bei Maschen der Keilriemen gerissen. Er hat ihn mit Omas Nylonstrumpf geflickt, den er noch vom Umzug im Handschuhfach hatte, und ist tatsächlich angekommen. Opa hat drei Tage nichts gesagt und dann nur: Aber gefahren ist er.',
    styled:
      'Im April 1968 stand er dann vor der Tür: ein VW Käfer, Baujahr 58, taubenblau, mit 62.000 Kilometern und einem Preis, der exakt Werners gesamtem erspartem Lehrlingsgeld entsprach. Heinrich umrundete das Auto zweimal, klopfte aufs Blech und sprach das Urteil: „Unsinn. Ein Tischler braucht einen Kombi."\n\nWerner fuhr trotzdem. Die erste große Fahrt sollte nach Hamburg gehen, zum Hafen, einfach weil es ging. Bei Maschen riss der Keilriemen. Ein Ingenieur wäre verzweifelt — Werner fand im Handschuhfach einen Nylonstrumpf, den Käthe beim Umzug dort vergessen hatte, knotete ihn um die Riemenscheiben und tuckerte mit vierzig Sachen weiter. Er erreichte Hamburg, den Hafen und, wichtiger noch, wieder Lüneburg.\n\nHeinrich sagte drei Tage lang nichts. Dann, beim Abendbrot, ohne von seinem Teller aufzusehen: „Aber gefahren ist er." Es war, in der Sprache der Familie Müller, eine Liebeserklärung.',
    photos: [
      {
        file: 'kaefer-werner',
        prompt: `${BW_60s} A young German man around 20 with sideburns proudly leaning against a Volkswagen Beetle from the late 1950s parked on a cobblestone street, polishing cloth in hand. Landscape orientation.`,
        caption: 'Werner und der Käfer, April 1968',
        width: 1600,
        height: 1067,
      },
    ],
  },
  {
    slug: 'hochzeit-1974',
    title: 'Eine Hochzeit im Mai',
    summary:
      'Werner und Ingrid heiraten am 17. Mai 1974 — es regnet bis mittags, Otto weint völlig überraschend, und gefeiert wird wieder in der „Krone".',
    inputType: 'text',
    eventDate: new Date(Date.UTC(1974, 4, 17)),
    eventDatePrecision: 'day',
    people: ['werner', 'ingrid', 'heinrich', 'kaethe', 'otto', 'elfriede'],
    raw: 'Am 17. Mai 1974 haben Papa und Mama in St. Johannis geheiratet. Es hat den ganzen Vormittag geregnet, und Punkt zwölf, als sie aus der Kirche kamen, kam die Sonne raus — das schwört Mama bis heute. Opa Otto, von dem alle dachten, ihn bringt nichts aus der Ruhe, hat in der Kirche geweint wie ein Schlosshund. Gefeiert wurde in der Krone, im selben Saal, in dem sich Oma Käthe und Opa Heinrich 27 Jahre vorher kennengelernt hatten. Oma Elfriede hat für alle 60 Gäste Apfelkuchen gebacken, und Opa Heinrich hat mit Oma Käthe eröffnet — er konnte immer noch nicht tanzen.',
    styled:
      'Es regnete am Morgen des 17. Mai 1974, es regnete während der Trauung, und um Punkt zwölf, als sich die Türen von St. Johannis öffneten und Werner und Ingrid auf die Treppe traten, riss der Himmel auf. Ingrid schwört das bis heute, und niemand in der Familie wagt zu widersprechen.\n\nDie größte Überraschung des Tages aber lieferte Otto Brandt. Der Mann, der dreißig Jahre lang schwere Loks durch Norddeutschland gefahren hatte und den nach Familienmeinung nichts, aber auch gar nichts erschüttern konnte, saß in der ersten Reihe und weinte hemmungslos in sein Taschentuch, als seine Tochter Ja sagte.\n\nGefeiert wurde in der „Krone" — im selben Saal, in dem Heinrich siebenundzwanzig Jahre zuvor einer jungen Frau aus Pommern dreimal auf die Füße getreten war. Elfriede hatte für alle sechzig Gäste Apfelkuchen gebacken, nach dem Rezept, das nie jemand zu Gesicht bekam. Und als die Kapelle aufspielte, eröffneten Heinrich und Käthe den Tanz. Er konnte es immer noch nicht. Sie lachte immer noch.',
    photos: [
      {
        file: 'hochzeit74-paar',
        prompt: `${COLOR_70s} German wedding couple 1974 on church steps: the groom around 26 with sideburns in a dark suit with wide lapels and ruffled shirt, the bride in a simple white dress with daisies, confetti in the air, wet cobblestones reflecting sunlight. Portrait orientation.`,
        caption: 'Werner und Ingrid vor St. Johannis, 17. Mai 1974',
        width: 1200,
        height: 1600,
      },
      {
        file: 'hochzeit74-familie',
        prompt: `${COLOR_70s} Wedding group photo 1974 in front of a north German brick church: bride and groom in the center, two older couples in their 50s and 60s in festive 1970s clothing beside them, everyone smiling, slightly stiff formal pose. Landscape orientation.`,
        caption: 'Beide Familien vereint, Mai 1974',
        width: 1600,
        height: 1067,
      },
    ],
    coverPhoto: 0,
  },
  {
    slug: 'einschulung-martin',
    title: 'Martins Einschulung',
    summary:
      'Eine selbstgebaute Schultüte aus der Werkstatt, ein umgeknickter Kegel Zuckerzeug — und eine Mutter, die plötzlich „Frau Müller" heißt.',
    inputType: 'text',
    eventDate: new Date(Date.UTC(1984, 8, 3)),
    eventDatePrecision: 'day',
    people: ['martin', 'ingrid', 'werner'],
    raw: 'An meine Einschulung 1984 erinnere ich mich vor allem wegen der Schultüte. Papa hat sie in der Werkstatt gebaut, aus dünnem Sperrholz, bespannt mit blauem Papier — die stabilste Schultüte der Schulgeschichte, sie existiert heute noch. Oma Käthe hat sie so vollgepackt, dass ich sie nicht tragen konnte und sie mir beim Gruppenfoto umgekippt ist. Und das Merkwürdigste war, dass Mama an meiner Schule unterrichtet hat — alle Kinder nannten meine Mutter Frau Müller, und ich dachte, die kennen sie alle.',
    styled:
      'Die Schultüte, mit der Martin am 3. September 1984 vor der Grundschule stand, war keine gewöhnliche. Werner hatte sie in der Werkstatt gebaut: ein Kegel aus dünnem Sperrholz, bespannt mit blauem Glanzpapier — vermutlich die stabilste Schultüte der niedersächsischen Schulgeschichte. Sie existiert bis heute und hat seither drei weitere Einschulungen erlebt.\n\nKäthe hatte sie mit einer Hingabe gefüllt, die ihre Enkel kannten und fürchteten: Schokolade, Brausepulver, Buntstifte, ein Springseil und, ganz unten, ein Fünfmarkstück „für den Notfall". Das Ergebnis wog gut sechs Kilo. Beim Gruppenfoto kippte die Tüte dem Erstklässler würdevoll aus dem Arm, und das Brausepulver rollte über den Schulhof.\n\nDie eigentliche Verwirrung des Tages aber war eine andere: Ingrid unterrichtete an ebendieser Schule. Den ganzen Vormittag riefen fremde Kinder seiner Mutter „Guten Tag, Frau Müller!" zu, und Martin kam zu dem Schluss, seine Mutter sei offenbar berühmt. So gesehen, sagt er heute, hat ihn die Schule vom ersten Tag an etwas gelehrt: Man kennt seine Eltern nie ganz.',
    photos: [
      {
        file: 'einschulung-martin',
        prompt: `${COLOR_80s} A six year old German boy with a bowl haircut in a knitted sweater proudly holding an oversized blue cone-shaped Schultüte (German first-day-of-school cone) almost as tall as himself, standing in front of a 1980s school building, leather satchel on his back. Portrait orientation.`,
        caption: 'Martin mit der Sperrholz-Schultüte, 3. September 1984',
        width: 1200,
        height: 1600,
      },
    ],
  },
  {
    slug: 'ostsee',
    title: 'Sommer an der Ostsee',
    summary:
      'Drei Wochen Timmendorfer Strand 1985: Strandkorb 127, eine Qualle im Eimer, Werners legendärer Sonnenbrand — und Ingrid fotografiert alles.',
    inputType: 'text',
    eventDate: new Date(Date.UTC(1985, 6, 15)),
    eventDatePrecision: 'month',
    people: ['werner', 'ingrid', 'martin', 'claudia'],
    raw: 'Der Ostsee-Urlaub 1985 in Timmendorf ist unser Familien-Mythos. Drei Wochen, Strandkorb Nummer 127, jeden Tag. Claudia und ich haben eine Qualle im Eimer gefangen und wollten sie als Haustier behalten, „Quallo". Papa ist am zweiten Tag beim Mittagsschlaf in der Sonne eingeschlafen und war danach zwei Wochen krebsrot, er hat trotzdem behauptet, das sei „gesunde Farbe". Und Mama hat drei Filme vollfotografiert — die Bilder sind der Grundstock von diesem ganzen Archiv hier.',
    styled:
      'Es gibt Urlaube, und es gibt den Sommer 1985. Drei Wochen Timmendorfer Strand, und das Zentrum der Welt war ein Strandkorb mit der Nummer 127, den Werner jeden Morgen um acht mit Handtüchern besetzte, als gälte es, Neuland zu erschließen.\n\nClaudia, zehn, und Martin, sieben, fingen in der zweiten Woche eine Qualle, tauften sie „Quallo" und hielten sie zwei Tage in einem gelben Eimer als Haustier, ehe Ingrid eine Beisetzung auf See verfügte. Werner wiederum schlief am zweiten Tag beim Mittagsschlaf in der prallen Sonne ein und trug fortan einen Sonnenbrand, der noch auf den Fotos der dritten Woche leuchtet. Er bestand bis zuletzt darauf, das sei „gesunde Farbe".\n\nIngrid aber fotografierte. Drei volle Filme: die Kinder beim Buddeln, Werner rot wie eine Boje, Wolken über der Ostsee, Fischbrötchen, den Strandkorb 127 aus allen Himmelsrichtungen. Es sind diese Bilder, die vier Jahrzehnte später den Grundstock der Familienchronik legen sollten. Man kann sagen: Der Sommer 1985 war der Anfang dieses Buches — er wusste es nur noch nicht.',
    photos: [
      {
        file: 'ostsee-strandkoerbe',
        prompt: `${COLOR_80s} Baltic Sea beach at Timmendorfer Strand 1985: rows of white-and-blue wicker beach chairs (Strandkörbe) on white sand, families with windbreaks, calm sea. Landscape orientation.`,
        caption: 'Timmendorfer Strand, Juli 1985',
        width: 1600,
        height: 1067,
      },
      {
        file: 'ostsee-sandburg',
        prompt: `${COLOR_80s} Two German children — a girl around 10 and a boy around 7 in 1980s swimwear — building a large sandcastle with a small paper flag on a Baltic beach, yellow bucket beside them. Landscape orientation.`,
        caption: 'Claudia und Martin, Baumeister — daneben Quallos Eimer',
        width: 1600,
        height: 1200,
      },
      {
        file: 'ostsee-picknick',
        prompt: `${COLOR_80s} German family picnic in a wicker beach chair on the Baltic coast in 1985: a mother in her early 30s with a camera around her neck handing out sandwiches to two children, thermos flask, checkered blanket. Portrait orientation.`,
        caption: 'Pause am Korb 127 — Ingrid, wie immer, mit Kamera',
        width: 1200,
        height: 1600,
      },
    ],
  },
  {
    slug: 'apfelkuchen',
    title: 'Elfriedes Apfelkuchen',
    summary:
      'Das berühmteste Rezept der Familie stand nie auf Papier — bis Claudia sich in Omas Küche stellte und einfach mitschrieb.',
    inputType: 'chat',
    eventDate: new Date(Date.UTC(1995, 9, 1)),
    eventDatePrecision: 'circa',
    people: ['elfriede', 'claudia', 'martin'],
    raw: 'Omas Apfelkuchen gab es zu jedem Anlass — Hochzeiten, Beerdigungen, bestandene Führerscheine. Das Rezept stand nie auf Papier, sie hat immer gesagt: „Das hat man in den Händen." Die Äpfel waren Boskoop, früher aus Opas Garten. Das eigentliche Geheimnis, das hat sie erst ganz spät verraten: ein Löffel Schmand im Teig und die Rosinen über Nacht in Rum. Mitte der Neunziger, ich glaube 95, hat Claudia sich dann einfach mit einem Block in die Küche gestellt und jeden Handgriff mitgeschrieben, während Oma gebacken hat. Oma fand das „übertrieben". Zum Glück hat Claudia nicht auf sie gehört — es ist das einzige Dokument dieses Kuchens.',
    styled:
      'Es gab in der Familie ein Gericht mit Verfassungsrang: Elfriedes Apfelkuchen. Er erschien zu Hochzeiten, Beerdigungen, Konfirmationen und bestandenen Führerscheinprüfungen, immer gleich hoch, immer gleich golden. Ein Rezept dazu existierte nicht. „Das hat man in den Händen", sagte Elfriede, und damit war die Sache besprochen.\n\nDie Äpfel waren selbstverständlich Boskoop, in den guten Jahren aus Ottos Garten. Das eigentliche Geheimnis gab sie erst spät preis, und auch dann nur beiläufig, über die Schulter: ein Löffel Schmand in den Teig, und die Rosinen über Nacht in Rum. „Aber das sagt ihr niemandem."\n\nIrgendwann Mitte der Neunziger stellte sich Claudia mit einem Schreibblock in die Küche und notierte einfach jeden Handgriff, während ihre Großmutter buk. Elfriede fand das „übertrieben". Heute ist Claudias Mitschrift — vier Seiten, mehlbestäubt, mit der Randnotiz „Ofen: Gefühl" — das einzige schriftliche Zeugnis dieses Kuchens und vermutlich das wertvollste Dokument im Besitz der Familie.\n\nGebacken wird er bis heute. Er wird, da sind sich alle einig, nie ganz so wie bei ihr. Aber die Rosinen liegen über Nacht in Rum, in jeder Küche der Familie, und das ist vielleicht die Hauptsache.',
    photos: [
      {
        file: 'apfelkuchen-kueche',
        prompt: `${COLOR_90s} A German grandmother in her early 70s with an apron in a cozy 1990s kitchen, sliding a golden apple cake out of the oven, a younger woman with glasses taking notes on a pad beside her, flour on the counter. Square format.`,
        caption: 'Elfriede und die Protokollantin, um 1995',
        width: 1400,
        height: 1400,
      },
    ],
  },
  {
    slug: 'hochzeit-2008',
    title: 'Martin und Sabine sagen Ja',
    summary:
      'Am längsten Tag des Jahres 2008 heiraten Martin und Sabine am alten Wasserturm — und eine Familientradition setzt sich beim Eröffnungstanz fort.',
    inputType: 'text',
    eventDate: new Date(Date.UTC(2008, 5, 21)),
    eventDatePrecision: 'day',
    people: ['martin', 'sabine', 'werner', 'ingrid', 'claudia'],
    raw: 'Sabine und ich haben am 21. Juni 2008 geheiratet, am alten Wasserturm in Lüneburg. Kennengelernt hatten wir uns 2003 im Studium in Hamburg, in der Bibliothek, sie hat mir ihren Platz nicht überlassen. Papa hat eine Rede gehalten, in der er behauptete, er habe „nie Zweifel gehabt" — Claudia hat laut gelacht. Und beim Eröffnungstanz bin ich Sabine zweimal auf die Füße getreten. Papa rief über die Tanzfläche: „Familientradition!" Er hatte recht, Opa Heinrich hat 1947 genauso angefangen.',
    styled:
      'Sie hatten sich 2003 in der Universitätsbibliothek in Hamburg kennengelernt, als Sabine Weber sich weigerte, den letzten freien Fensterplatz zu räumen, den Martin für seinen hielt. Fünf Jahre später, am 21. Juni 2008 — dem längsten Tag des Jahres, was Sabine für ein gutes Omen hielt — standen die beiden am alten Wasserturm in Lüneburg und sagten Ja.\n\nWerner hielt eine Rede, in der er versicherte, er habe „vom ersten Tag an nie Zweifel gehabt". Claudia lachte an dieser Stelle so laut, dass er eine Kunstpause einlegen musste; es existiert eine Tonaufnahme. Ingrid fotografierte, natürlich, obwohl ein bezahlter Fotograf anwesend war. Sie traute Profis in dieser Frage grundsätzlich nicht.\n\nBeim Eröffnungstanz dann geschah das Unvermeidliche: Martin trat seiner Braut zweimal auf die Füße. Über die Tanzfläche hinweg rief Werner nur ein Wort: „Familientradition!" Er hatte recht. Einundsechzig Jahre zuvor hatte ein junger Tischler beim Erntedankfest genauso angefangen — und es war, wie die Familie wusste, kein schlechtes Zeichen.',
    photos: [
      {
        file: 'hochzeit08-paar',
        prompt: `${DIGITAL_00s} Wedding photo 2008: a groom around 30 in a modern slim dark suit and a bride with blonde pinned-up hair in an elegant simple white dress, laughing together in front of an old brick water tower in golden evening light. Portrait orientation.`,
        caption: 'Martin und Sabine am Wasserturm, 21. Juni 2008',
        width: 1200,
        height: 1600,
      },
      {
        file: 'hochzeit08-tanz',
        prompt: `${DIGITAL_00s} Candid wedding reception photo 2008: bride and groom dancing the opening dance under string lights in a rustic hall, guests laughing and clapping in the background, slight motion blur. Landscape orientation.`,
        caption: 'Der Eröffnungstanz — kurz vor dem zweiten Tritt',
        width: 1600,
        height: 1067,
      },
    ],
  },
  {
    slug: 'einschulung-lena',
    title: 'Lenas erster Schultag',
    summary:
      'Die Sperrholz-Schultüte von 1984 erlebt ihre vierte Einschulung — und Lena interessiert sich vor allem für ihre neue Brotdose.',
    inputType: 'voice',
    eventDate: new Date(Date.UTC(2016, 8, 1)),
    eventDatePrecision: 'day',
    people: ['lena', 'martin', 'sabine', 'ingrid'],
    raw: 'Bei Lenas Einschulung 2016 haben wir natürlich wieder Papas Sperrholz-Schultüte von 1984 genommen, neu bespannt, diesmal mit rotem Papier — die Tüte hat jetzt vier Einschulungen hinter sich. Oma Ingrid hat schon beim Frühstück geweint, „vorsorglich", wie sie sagte. Und Lena selbst war das alles ziemlich egal, die fand vor allem ihre neue Brotdose mit dem Fuchs gut und hat gefragt, ob sie morgen wieder hin muss oder ob das jetzt reicht.',
    styled:
      'Am 1. September 2016 trat ein Erbstück zu seinem vierten Einsatz an: die Sperrholz-Schultüte, die Werner 1984 in der Werkstatt gebaut hatte. Neu bespannt mit rotem Glanzpapier, innen unverändert stabil genug für sechs Kilo Zuckerzeug, stand sie neben Lena vor der Grundschule — dieselbe Tüte, die einst ihrem Vater beim Gruppenfoto aus dem Arm gekippt war. Lena hielt sie fest. Sie war vorgewarnt worden.\n\nIngrid weinte bereits beim Frühstück, nach eigener Auskunft „vorsorglich, dann habe ich es hinter mir". Es half nichts; sie weinte auf dem Schulhof trotzdem noch einmal. Sabine fotografierte, Martin trug die Tüte die letzten Meter, und irgendwo, da war sich die Familie einig, hätte Werner dazu nur genickt: Gebaut ist gebaut.\n\nDie Hauptperson selbst nahm den historischen Tag mit bemerkenswerter Nüchternheit. Am besten, erklärte Lena abends, sei die neue Brotdose mit dem Fuchs gewesen. Dann fragte sie, ob sie da morgen wirklich schon wieder hinmüsse oder ob das jetzt reiche. Es war, fand ihr Vater, eine sehr vernünftige Frage.',
    photos: [
      {
        file: 'einschulung-lena',
        prompt: `${MODERN} A six year old German girl with light brown braids and a gap-toothed grin holding a large red cone-shaped Schultüte (German school cone) and a fox-print lunchbox in front of a school entrance, modern colorful school bag. Portrait orientation.`,
        caption: 'Lena, die Schultüte (Baujahr 1984) und die Fuchs-Brotdose',
        width: 1200,
        height: 1600,
      },
    ],
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Chat conversation seeded around the Apfelkuchen story
 * ──────────────────────────────────────────────────────────────────────────── */

const CHAT_TITLE = 'Elfriedes Apfelkuchen';
const CHAT_MESSAGES: Array<{ role: 'user' | 'assistant'; content: string }> = [
  {
    role: 'user',
    content:
      'Ich möchte endlich die Geschichte von Omas Apfelkuchen festhalten, bevor sie verloren geht. Claudia hat das Rezept damals aufgeschrieben, aber die Geschichte dahinter kennt kaum noch jemand.',
  },
  {
    role: 'assistant',
    content:
      'Eine schöne Idee! Erzähl mir einfach, was du noch weißt: Wer hat den Kuchen gebacken, zu welchen Anlässen gab es ihn — und was machte ihn so besonders? Ich forme daraus einen Eintrag für eure Chronik.',
  },
  {
    role: 'user',
    content: STORIES.find((s) => s.slug === 'apfelkuchen')!.raw,
  },
  {
    role: 'assistant',
    content:
      'Was für eine Geschichte — ein Rezept mit Verfassungsrang! Ich habe daraus einen Eintrag gemacht und ihn mit Elfriede, Claudia und Martin verknüpft. Du findest ihn in der Chronik unter „Elfriedes Apfelkuchen".',
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Image generation (cached to IMAGE_DIR so reruns and prod reuse the files)
 * ──────────────────────────────────────────────────────────────────────────── */

async function generateImage(prompt: string): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // `modalities`/`images` are OpenRouter extensions the SDK types don't know.
      const completion = (await openrouter.chat.completions.create({
        model: IMAGE_MODEL,
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
      } as never)) as unknown as {
        choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
      };
      const url = completion.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (typeof url === 'string' && url.startsWith('data:')) {
        return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
      }
      console.warn(`  ! no image in response (attempt ${attempt})`);
    } catch (err) {
      console.warn(`  ! image generation failed (attempt ${attempt}):`, err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return null;
}

/** Last-resort placeholder so the seeding never blocks on image generation. */
function makePlaceholder(label: string, width: number, height: number): Promise<Buffer> {
  const fontSize = Math.max(28, Math.round(Math.min(width, height) * 0.05));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#8a7a66"/>
    <rect x="20" y="20" width="${width - 40}" height="${height - 40}" fill="none" stroke="#ffffff55" stroke-width="6"/>
    <text x="${width / 2}" y="${height / 2}" font-family="Georgia" font-size="${fontSize}" fill="#ffffffcc" text-anchor="middle">${label
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

/** Cached era photo, cropped to the exact target dimensions. */
async function getImage(file: string, prompt: string, width: number, height: number, label: string): Promise<Buffer> {
  const cached = path.join(IMAGE_DIR, `${file}.jpg`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached);

  console.log(`  generating image: ${file}`);
  const raw = await generateImage(
    `${prompt} The image must look like a real photograph, not an illustration. Fictional people only.`,
  );
  const buffer = raw
    ? await sharp(raw).resize(width, height, { fit: 'cover' }).jpeg({ quality: 86 }).toBuffer()
    : await makePlaceholder(label, width, height);
  if (!raw) console.warn(`  ! using placeholder for ${file}`);
  fs.writeFileSync(cached, buffer);
  return buffer;
}

/** Pre-generate every image with limited concurrency, before any DB writes. */
async function pregenerateImages() {
  const jobs: Array<() => Promise<unknown>> = [];
  for (const p of PEOPLE) {
    jobs.push(() => getImage(`avatar-${p.key}`, `${p.avatarPrompt} Square head-and-shoulders crop.`, 512, 512, p.displayName));
  }
  for (const s of STORIES) {
    for (const photo of s.photos) {
      jobs.push(() => getImage(photo.file, photo.prompt, photo.width, photo.height, photo.caption));
    }
  }
  const CONCURRENCY = 3;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await job();
      }
    }),
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Seeding
 * ──────────────────────────────────────────────────────────────────────────── */

function toDate(d: [number, number, number] | number | undefined): { on: Date | null; precision: 'day' | 'year' | null } {
  if (d === undefined) return { on: null, precision: null };
  if (typeof d === 'number') return { on: new Date(Date.UTC(d, 5, 30)), precision: 'year' };
  return { on: new Date(Date.UTC(d[0], d[1] - 1, d[2])), precision: 'day' };
}

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error('Usage: npx tsx scripts/seed-demo-account.ts <user-email>');

  const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!u) throw new Error(`No user with email ${email}`);
  console.log(`Seeding demo data for ${u.name} <${u.email}>`);

  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  console.log(`Preparing images (cache: ${IMAGE_DIR}, model: ${IMAGE_MODEL}) …`);
  await pregenerateImages();

  /* Chronicle — reuse the user's first one, create if none. */
  const CHRONICLE_DESCRIPTION =
    'Die Geschichten der Familien Müller und Brandt aus Lüneburg — vier Generationen, erzählt von denen, die dabei waren.';
  const [membership] = await db
    .select({ chronicleId: memberships.chronicleId })
    .from(memberships)
    .where(eq(memberships.userId, u.id))
    .limit(1);
  let chronicleId: string;
  if (membership) {
    chronicleId = membership.chronicleId;
    console.log(`Reusing existing chronicle ${chronicleId}`);
  } else {
    const [created] = await db
      .insert(chronicles)
      .values({
        name: 'Familie Müller',
        description: CHRONICLE_DESCRIPTION,
        storyLanguage: 'de',
        createdBy: u.id,
      })
      .returning();
    await db.insert(memberships).values({ chronicleId: created.id, userId: u.id, accessRole: 'owner' });
    chronicleId = created.id;
    console.log(`Created chronicle "Familie Müller" (${chronicleId})`);
  }

  /* People + tree */
  const personIds = new Map<string, string>();
  for (const spec of PEOPLE) {
    let personId: string;
    if (spec.isSelf) {
      personId = await ensurePersonForUser({ userId: u.id, name: spec.displayName });
    } else {
      const [existing] = await db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.displayName, spec.displayName), eq(people.createdBy, u.id)))
        .limit(1);
      personId = existing?.id ?? '';
    }
    const born = toDate(spec.born);
    const died = toDate(spec.died);
    const values = {
      displayName: spec.displayName,
      givenName: spec.givenName,
      familyName: spec.familyName,
      birthFamilyName: spec.birthFamilyName ?? null,
      gender: spec.gender,
      bornOn: born.on,
      bornPrecision: spec.bornCirca ? ('circa' as const) : born.precision,
      diedOn: died.on,
      diedPrecision: died.precision,
      notes: spec.notes ?? null,
    };
    if (personId) {
      await db.update(people).set({ ...values, updatedAt: new Date() }).where(eq(people.id, personId));
    } else {
      const [created] = await db
        .insert(people)
        .values({ ...values, createdBy: u.id })
        .returning({ id: people.id });
      personId = created.id;
    }
    await addPersonToChronicle(chronicleId, personId);
    personIds.set(spec.key, personId);

    const [row] = await db.select({ avatar: people.avatarS3Key }).from(people).where(eq(people.id, personId)).limit(1);
    if (!row?.avatar) {
      const buf = await getImage(`avatar-${spec.key}`, `${spec.avatarPrompt} Square head-and-shoulders crop.`, 512, 512, spec.displayName);
      const key = `avatars/demo-${spec.key}.jpg`;
      await putObjectBuffer(key, buf, 'image/jpeg');
      await db.update(people).set({ avatarS3Key: key, updatedAt: new Date() }).where(eq(people.id, personId));
    }
    console.log(`person ready: ${spec.displayName}`);
  }

  for (const edge of EDGES) {
    await connectPeople({
      type: edge.type,
      personFromId: personIds.get(edge.from)!,
      personToId: personIds.get(edge.to)!,
      createdBy: u.id,
    });
  }
  console.log(`tree ready: ${PEOPLE.length} people, ${EDGES.length} edges`);

  /* Chat conversation (created first so the chat-born story can reference it) */
  let [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.userId, u.id), eq(conversations.title, CHAT_TITLE)))
    .limit(1);
  if (!conversation) {
    const [created] = await db
      .insert(conversations)
      .values({ chronicleId, userId: u.id, title: CHAT_TITLE, closedAt: new Date() })
      .returning({ id: conversations.id });
    conversation = created;
    for (const m of CHAT_MESSAGES) {
      await db.insert(messages).values({ conversationId: created.id, role: m.role, content: m.content });
    }
    console.log(`chat seeded: "${CHAT_TITLE}"`);
  }

  /* Stories with contributions + photos */
  const storyIds: string[] = [];
  let coverAssetId: string | null = null;
  for (const spec of STORIES) {
    const [existing] = await db
      .select({ id: stories.id })
      .from(stories)
      .innerJoin(storyChronicles, eq(storyChronicles.storyId, stories.id))
      .where(and(eq(storyChronicles.chronicleId, chronicleId), eq(stories.title, spec.title)))
      .limit(1);
    if (existing) {
      storyIds.push(existing.id);
      console.log(`skipping story "${spec.title}" — already seeded`);
      continue;
    }

    const [story] = await db
      .insert(stories)
      .values({
        submittedBy: u.id,
        title: spec.title,
        summary: spec.summary,
        bodyOriginal: spec.raw,
        bodyStyled: spec.styled,
        inputType: spec.inputType,
        status: 'ready',
        eventDate: spec.eventDate,
        eventDatePrecision: spec.eventDatePrecision,
        conversationId: spec.inputType === 'chat' ? conversation.id : null,
      })
      .returning();
    storyIds.push(story.id);
    await db.insert(storyChronicles).values({ storyId: story.id, chronicleId, sharedBy: u.id });
    await db
      .insert(storyPeople)
      .values(spec.people.map((key) => ({ storyId: story.id, personId: personIds.get(key)! })))
      .onConflictDoNothing();
    const [contribution] = await db
      .insert(contributions)
      .values({ storyId: story.id, contributedBy: u.id, text: spec.raw })
      .returning({ id: contributions.id });

    for (const photo of spec.photos) {
      const buf = await getImage(photo.file, photo.prompt, photo.width, photo.height, photo.caption);
      const key = `stories/photos/demo-${photo.file}.jpg`;
      await putObjectBuffer(key, buf, 'image/jpeg');
      const [asset] = await db
        .insert(assets)
        .values({
          storyId: story.id,
          contributionId: contribution.id,
          kind: 'photo',
          s3Key: key,
          mimeType: 'image/jpeg',
          bytes: buf.length,
          width: photo.width,
          height: photo.height,
          caption: photo.caption,
        })
        .onConflictDoNothing()
        .returning({ id: assets.id });
      if (asset) await generateThumbnail(key);
      if (asset && spec.coverPhoto !== undefined && spec.photos[spec.coverPhoto] === photo) {
        coverAssetId = asset.id;
      }
    }
    console.log(`seeded story "${spec.title}" (${spec.photos.length} photo${spec.photos.length === 1 ? '' : 's'})`);
  }

  /* Book with every story, in chronological order */
  const BOOK_TITLE = 'Familie Müller';
  const [existingBook] = await db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.chronicleId, chronicleId), eq(books.title, BOOK_TITLE)))
    .limit(1);
  if (existingBook) {
    console.log('skipping book — already seeded');
  } else {
    const [book] = await db
      .insert(books)
      .values({
        chronicleId,
        createdBy: u.id,
        title: BOOK_TITLE,
        subtitle: 'Geschichten aus vier Generationen',
        dedication: 'Für Lena — und für alle, die eines Tages fragen werden, wie es früher war.',
        coverAssetId,
      })
      .returning({ id: books.id });
    await db
      .insert(bookStories)
      .values(storyIds.map((storyId, position) => ({ bookId: book.id, storyId, position })));
    console.log(`seeded book "${BOOK_TITLE}" with ${storyIds.length} stories`);
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
