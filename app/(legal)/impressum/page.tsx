import type { Metadata } from 'next';
import { Stack, Title, Text, Anchor } from '@mantine/core';
import { Section, P } from '../legal-parts';

export const metadata: Metadata = {
  title: 'Impressum · Familienwerk',
  description: 'Anbieterkennzeichnung gemäß § 5 DDG für Familienwerk.',
};

export default function ImpressumPage() {
  return (
    <Stack gap="xl">
      <Title order={1} fz={{ base: 28, sm: 34 }} c="slate.9">
        Impressum
      </Title>

      <Section title="Angaben gemäß § 5 DDG">
        <Text c="slate.7" fz="sm" lh={1.75}>
          MTX Studio AG
          <br />
          Bahnhofstrasse 20
          <br />
          6300 Zug
          <br />
          Schweiz
        </Text>
        <P>Vertreten durch den Verwaltungsrat.</P>
      </Section>

      <Section title="Handelsregister">
        <P>
          Eingetragen im Handelsregister des Kantons Zug (Schweiz).
          <br />
          Unternehmens-Identifikationsnummer: CHE-477.168.458
        </P>
      </Section>

      <Section title="Kontakt">
        <Text c="slate.7" fz="sm" lh={1.75}>
          Telefon: +49 173 72 94 790
          <br />
          E-Mail:{' '}
          <Anchor href="mailto:contact@mtx.studio" underline="hover">
            contact@mtx.studio
          </Anchor>
        </Text>
      </Section>

      <Section title="Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV">
        <P>MTX Studio AG, Bahnhofstrasse 20, 6300 Zug, Schweiz</P>
      </Section>

      <Section title="Verbraucherstreitbeilegung">
        <P>
          Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer
          Verbraucherschlichtungsstelle teilzunehmen.
        </P>
      </Section>

      <Section title="Haftung für Inhalte">
        <P>
          Als Diensteanbieter sind wir für eigene Inhalte auf diesen Seiten nach den allgemeinen
          Gesetzen verantwortlich. Wir sind jedoch nicht verpflichtet, übermittelte oder gespeicherte
          fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine
          rechtswidrige Tätigkeit hinweisen. Verpflichtungen zur Entfernung oder Sperrung der Nutzung
          von Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt. Eine
          diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten
          Rechtsverletzung möglich. Bei Bekanntwerden von entsprechenden Rechtsverletzungen entfernen
          wir diese Inhalte umgehend.
        </P>
      </Section>

      <Section title="Haftung für Links">
        <P>
          Unser Angebot enthält gegebenenfalls Links zu externen Websites Dritter, auf deren Inhalte
          wir keinen Einfluss haben. Deshalb können wir für diese fremden Inhalte auch keine Gewähr
          übernehmen. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder
          Betreiber der Seiten verantwortlich. Bei Bekanntwerden von Rechtsverletzungen werden wir
          derartige Links umgehend entfernen.
        </P>
      </Section>

      <Section title="Urheberrecht">
        <P>
          Die durch die Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen dem
          Urheberrecht. Die von Nutzerinnen und Nutzern beigetragenen Geschichten, Aufnahmen und Fotos
          verbleiben im Eigentum der jeweiligen Urheberinnen und Urheber. Beiträge Dritter sind als
          solche gekennzeichnet. Vervielfältigung, Bearbeitung, Verbreitung und jede Art der
          Verwertung außerhalb der Grenzen des Urheberrechts bedürfen der schriftlichen Zustimmung der
          jeweiligen Urheberin oder des jeweiligen Urhebers.
        </P>
      </Section>
    </Stack>
  );
}
