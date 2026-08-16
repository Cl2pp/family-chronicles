'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconBook, IconInfoCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import posthog from 'posthog-js';
import { useI18n } from '@/lib/i18n/client';
import type { BookShippingAddress } from '@/lib/book-orders';
import { placeBookOrderAction } from '../../actions';
import { ORDER_COUNTRY_CODES, countryLabel } from './order-shared';

/** Field lengths Gelato's address API accepts — enforced here as `maxLength` so the user
 *  can't type past them, rather than only finding out from a rejected submission. */
const MAX = {
  name: 25,
  addressLine: 35,
  city: 30,
  postCode: 15,
  phone: 25,
  email: 100,
} as const;

const REQUIRED = ['firstName', 'lastName', 'addressLine1', 'postCode', 'city', 'email'] as const;

/** Splits a display name into first/last on the LAST space — "Anna Maria Müller" becomes
 *  "Anna Maria" + "Müller". A single word becomes the first name with an empty last name
 *  (the user fills the rest in); both fields stay editable either way. */
function splitName(name: string | null): { first: string; last: string } {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { first: '', last: '' };
  const cut = trimmed.lastIndexOf(' ');
  if (cut < 0) return { first: trimmed, last: '' };
  return { first: trimmed.slice(0, cut).trim(), last: trimmed.slice(cut + 1).trim() };
}

/**
 * The real ordering form — only rendered for accounts `canUserOrderBooks` allows, and
 * only when the book has a fresh print proof, a live price and a Gelato-format print
 * file. Submitting hands the address to `placeBookOrderAction`, which creates the order
 * row and sends it to Gelato; the page then re-renders as the status card
 * (`order-status-card.tsx`) because an order now exists.
 *
 * No payment fields on purpose: Gelato bills the account's own card, so nothing is
 * charged in the app (see the note above the button).
 */
export function OrderAddressForm({
  bookId,
  priceLabel,
  userEmail,
  userName,
}: {
  bookId: string;
  /** Already-formatted total, e.g. "89,00 €" — shown inside the primary button. */
  priceLabel: string;
  userEmail: string;
  userName: string | null;
}) {
  const { t } = useI18n();
  const to = t.books.order;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const initial = splitName(userName);
  const [values, setValues] = useState<BookShippingAddress>({
    firstName: initial.first,
    lastName: initial.last,
    addressLine1: '',
    addressLine2: '',
    postCode: '',
    city: '',
    country: 'DE',
    email: userEmail,
    phone: '',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof BookShippingAddress, string>>>({});

  function set<K extends keyof BookShippingAddress>(key: K, value: BookShippingAddress[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Clear this field's error as soon as it's touched — re-validated on submit anyway.
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  function submit() {
    const found: Partial<Record<keyof BookShippingAddress, string>> = {};
    for (const key of REQUIRED) {
      if (!values[key]?.trim()) found[key] = to.fieldRequired;
    }
    if (!found.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
      found.email = to.fieldInvalidEmail;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    // Optional fields go out as `undefined` rather than an empty string, so the server
    // never forwards a blank line to Gelato.
    const address: BookShippingAddress = {
      firstName: values.firstName.trim(),
      lastName: values.lastName.trim(),
      addressLine1: values.addressLine1.trim(),
      addressLine2: values.addressLine2?.trim() || undefined,
      postCode: values.postCode.trim(),
      city: values.city.trim(),
      country: values.country,
      email: values.email.trim(),
      phone: values.phone?.trim() || undefined,
    };

    startTransition(async () => {
      const result = await placeBookOrderAction(bookId, address);
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      if (posthog.__loaded) posthog.capture('book_order_placed_ui', { book_id: bookId });
      notifications.show({ message: to.orderPlacedNotice, color: 'green' });
      router.refresh();
    });
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Title order={4} mb="md">
        {to.addressTitle}
      </Title>

      <Stack gap="sm">
        <Group grow align="flex-start">
          <TextInput
            label={to.fieldFirstName}
            required
            maxLength={MAX.name}
            value={values.firstName}
            error={errors.firstName}
            onChange={(e) => set('firstName', e.currentTarget.value)}
          />
          <TextInput
            label={to.fieldLastName}
            required
            maxLength={MAX.name}
            value={values.lastName}
            error={errors.lastName}
            onChange={(e) => set('lastName', e.currentTarget.value)}
          />
        </Group>

        <TextInput
          label={to.fieldAddressLine1}
          required
          maxLength={MAX.addressLine}
          value={values.addressLine1}
          error={errors.addressLine1}
          onChange={(e) => set('addressLine1', e.currentTarget.value)}
        />
        <TextInput
          label={to.fieldAddressLine2}
          maxLength={MAX.addressLine}
          value={values.addressLine2 ?? ''}
          onChange={(e) => set('addressLine2', e.currentTarget.value)}
        />

        <Group grow align="flex-start">
          <TextInput
            label={to.fieldPostCode}
            required
            maxLength={MAX.postCode}
            value={values.postCode}
            error={errors.postCode}
            onChange={(e) => set('postCode', e.currentTarget.value)}
          />
          <TextInput
            label={to.fieldCity}
            required
            maxLength={MAX.city}
            value={values.city}
            error={errors.city}
            onChange={(e) => set('city', e.currentTarget.value)}
          />
        </Group>

        <Select
          label={to.fieldCountry}
          required
          allowDeselect={false}
          data={ORDER_COUNTRY_CODES.map((code) => ({ value: code, label: countryLabel(to, code) }))}
          value={values.country}
          onChange={(value) => value && set('country', value)}
        />

        <Group grow align="flex-start">
          <TextInput
            label={to.fieldEmail}
            required
            type="email"
            maxLength={MAX.email}
            value={values.email}
            error={errors.email}
            onChange={(e) => set('email', e.currentTarget.value)}
          />
          <TextInput
            label={to.fieldPhone}
            type="tel"
            maxLength={MAX.phone}
            value={values.phone ?? ''}
            onChange={(e) => set('phone', e.currentTarget.value)}
          />
        </Group>
      </Stack>

      <Alert color="blue" icon={<IconInfoCircle size={16} />} mt="lg">
        <Text fz={13}>{to.orderPaymentNote}</Text>
        <Text fz={13} mt={4}>
          {to.orderNoReturnsNote}
        </Text>
      </Alert>

      <Button
        size="lg"
        mt="md"
        fullWidth
        loading={pending}
        leftSection={<IconBook size={18} />}
        onClick={submit}
      >
        {to.orderNowCta(priceLabel)}
      </Button>
    </Card>
  );
}
