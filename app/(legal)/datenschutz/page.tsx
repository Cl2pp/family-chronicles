import type { Metadata } from 'next';
import { Stack, Title, Text, Anchor } from '@mantine/core';
import { Section, P, Bullets } from '../legal-parts';

export const metadata: Metadata = {
  title: 'Datenschutzerklärung · Familienwerk',
  description: 'Informationen zur Verarbeitung personenbezogener Daten bei Familienwerk.',
};

export default function DatenschutzPage() {
  return (
    <Stack gap="xl">
      <Title order={1} fz={{ base: 28, sm: 34 }} c="slate.9">
        Datenschutzerklärung
      </Title>
      <Text c="slate.5" fz="sm">
        Stand: Juli 2026
      </Text>

      <Section title="1. Verantwortlicher">
        <Text c="slate.7" fz="sm" lh={1.75}>
          Verantwortlich für die Datenverarbeitung ist:
          <br />
          MTX Studio AG
          <br />
          Bahnhofstrasse 20
          <br />
          6300 Zug, Schweiz
          <br />
          E-Mail:{' '}
          <Anchor href="mailto:contact@mtx.studio" underline="hover">
            contact@mtx.studio
          </Anchor>
        </Text>
      </Section>

      <Section title="2. Grundlegendes">
        <P>
          Diese Datenschutzerklärung informiert dich über Art, Umfang und Zweck der Verarbeitung
          personenbezogener Daten innerhalb von Familienwerk (nachfolgend „die Anwendung“).
          Rechtsgrundlagen der Verarbeitung sind, soweit nicht anders angegeben, die Vorschriften der
          Datenschutz-Grundverordnung (DSGVO). Familienwerk ist ein privater, ausschließlich
          einladungsbasierter Dienst: Inhalte sind nur für die Mitglieder der jeweiligen
          Familienchronik sichtbar. Es gibt keine öffentlichen Profile, keine Werbung und kein
          Tracking zu Werbezwecken.
        </P>
      </Section>

      <Section title="3. Bereitstellung der Anwendung und Server-Logfiles">
        <P>
          Beim Aufrufen der Anwendung werden technisch notwendige Daten (u. a. IP-Adresse, Datum und
          Uhrzeit des Zugriffs, aufgerufene Seite, Browsertyp) verarbeitet, um die Anwendung
          auszuliefern und ihre Stabilität und Sicherheit zu gewährleisten. Rechtsgrundlage ist
          Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse am sicheren Betrieb).
        </P>
        <P>
          Hosting: Der Betrieb erfolgt auf Servern der Hetzner Online GmbH, Industriestr. 25, 91710
          Gunzenhausen, Deutschland (Rechenzentrum Nürnberg). Mit Hetzner besteht ein Vertrag zur
          Auftragsverarbeitung nach Art. 28 DSGVO.
        </P>
      </Section>

      <Section title="4. Konto und Anmeldung">
        <P>
          Für die Nutzung ist ein Nutzerkonto erforderlich. Dabei verarbeiten wir die von dir
          angegebenen Daten (Name, E-Mail-Adresse sowie das Passwort in ausschließlich gehashter
          Form). Zur Aufrechterhaltung der Anmeldung wird ein technisch notwendiges Sitzungs-Cookie
          gesetzt. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Erfüllung des Nutzungsvertrags).
        </P>
      </Section>

      <Section title="5. Von dir beigetragene Inhalte">
        <P>
          Kern der Anwendung ist das Sammeln von Familiengeschichten. Wir verarbeiten die von dir
          eingegebenen Texte, hochgeladenen Fotos und Sprachaufnahmen sowie die von dir angelegten
          Personen- und Stammbaumdaten. Diese Inhalte können besondere Kategorien personenbezogener
          Daten (z. B. Angaben zu Gesundheit, religiöser Überzeugung oder Herkunft von
          Familienmitgliedern) enthalten. Grundlage der Verarbeitung ist Art. 6 Abs. 1 lit. b DSGVO
          sowie – soweit besondere Kategorien betroffen sind – deine Einwilligung nach Art. 9 Abs. 2
          lit. a DSGVO, die du mit dem Beitrag solcher Inhalte erteilst. Die Dateien (Audio, Fotos)
          werden im Objektspeicher Cloudflare R2 in der EU-Jurisdiktion gespeichert (siehe Ziffer 7).
        </P>
      </Section>

      <Section title="6. Verarbeitung durch KI-Dienste">
        <P>
          Um aus einem Beitrag ein lesbares Kapitel zu erstellen, werden Inhalte an spezialisierte
          Dienstleister übermittelt:
        </P>
        <Bullets
          items={[
            'Sprachaufnahmen werden zur Transkription an Groq, Inc. (USA) übermittelt (Whisper-Modell).',
            'Die Verschriftlichung und Umformulierung der Texte erfolgt über die Programmierschnittstelle von OpenRouter, Inc. (USA), die die Anfrage an ein Sprachmodell weiterleitet.',
          ]}
        />
        <P>
          Es werden nur die für die jeweilige Aufgabe erforderlichen Inhalte übermittelt.
          Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO. Zur Übermittlung in die USA siehe Ziffer 8.
        </P>
      </Section>

      <Section title="7. Auftragsverarbeiter und Empfänger">
        <P>
          Wir setzen sorgfältig ausgewählte Dienstleister ein, mit denen – soweit erforderlich –
          Verträge zur Auftragsverarbeitung nach Art. 28 DSGVO bestehen:
        </P>
        <Bullets
          items={[
            'Hetzner Online GmbH, Deutschland – Server-Hosting.',
            'Cloudflare, Inc. (USA) / Cloudflare Germany GmbH – Objektspeicher (R2, EU-Jurisdiktion) für Audio- und Bilddateien.',
            'OpenRouter, Inc. (USA) – Textveredelung mittels Sprachmodell.',
            'Groq, Inc. (USA) – Transkription von Sprachaufnahmen.',
          ]}
        />
        <P>Eine Weitergabe deiner Daten zu Werbezwecken findet nicht statt.</P>
      </Section>

      <Section title="8. Übermittlung in Drittländer">
        <P>
          Einzelne der genannten Dienstleister haben ihren Sitz in den USA. Sofern Daten dorthin
          übermittelt werden, erfolgt dies auf Grundlage der EU-Standardvertragsklauseln (Art. 46
          DSGVO) und/oder deiner Einwilligung nach Art. 49 Abs. 1 lit. a DSGVO. Der Objektspeicher
          (Cloudflare R2) wird in der EU-Jurisdiktion betrieben.
        </P>
      </Section>

      <Section title="9. Cookies">
        <P>
          Die Anwendung verwendet ausschließlich technisch notwendige Cookies: ein Sitzungs-Cookie zur
          Aufrechterhaltung deiner Anmeldung sowie ein Cookie zum Speichern deiner Spracheinstellung.
          Es werden keine Analyse-, Tracking- oder Werbe-Cookies eingesetzt. Rechtsgrundlage für das
          Setzen technisch notwendiger Cookies ist § 25 Abs. 2 Nr. 2 TDDDG.
        </P>
      </Section>

      <Section title="10. Speicherdauer">
        <P>
          Wir speichern personenbezogene Daten so lange, wie es für die genannten Zwecke erforderlich
          ist bzw. wie du dein Konto und deine Inhalte nutzt. Die Rohdaten (Original-Audioaufnahmen
          und -Fotos) werden zur Nachvollziehbarkeit aufbewahrt, solange die zugehörige Chronik
          besteht. Löschst du dein Konto oder einzelne Inhalte, werden die betroffenen Daten gelöscht,
          soweit keine gesetzlichen Aufbewahrungspflichten entgegenstehen.
        </P>
      </Section>

      <Section title="11. Deine Rechte">
        <P>
          Dir stehen nach der DSGVO folgende Rechte zu: Auskunft (Art. 15), Berichtigung (Art. 16),
          Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit
          (Art. 20) sowie Widerspruch (Art. 21). Eine erteilte Einwilligung kannst du jederzeit mit
          Wirkung für die Zukunft widerrufen (Art. 7 Abs. 3 DSGVO). Zur Ausübung genügt eine Nachricht
          an{' '}
          <Anchor href="mailto:contact@mtx.studio" underline="hover">
            contact@mtx.studio
          </Anchor>
          .
        </P>
      </Section>

      <Section title="12. Beschwerderecht">
        <P>
          Du hast das Recht, dich bei einer Datenschutz-Aufsichtsbehörde über die Verarbeitung deiner
          personenbezogenen Daten zu beschweren.
        </P>
      </Section>
    </Stack>
  );
}
