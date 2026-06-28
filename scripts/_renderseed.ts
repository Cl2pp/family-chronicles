import 'dotenv/config';
import { createChronicle } from '@/lib/chronicles';
import { createTextStory } from '@/lib/stories';

(async () => {
  const userId = process.argv[2];
  const c = await createChronicle({ name: 'Render C', userId, description: 'A test chronicle' });
  const s1 = await createTextStory({
    chronicleId: c.id, userId, title: 'Dated story', body: 'x',
    eventDate: new Date('1985-04-01'), eventDatePrecision: 'year',
  });
  await createTextStory({
    chronicleId: c.id, userId, title: 'Undated story', body: 'y',
    eventDate: null, eventDatePrecision: null,
  });
  console.log('CHRONICLE=' + c.id);
  console.log('STORY=' + s1.id);
  process.exit(0);
})();
