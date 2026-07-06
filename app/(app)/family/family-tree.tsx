'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  ActionIcon,
  Avatar,
  Box,
  Button,
  Card,
  Drawer,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowDown,
  IconArrowUp,
  IconGenderFemale,
  IconGenderMale,
  IconHeart,
  IconLink,
  IconPencil,
  IconPlus,
  IconUnlink,
} from '@tabler/icons-react';
import type { Gender, PersonRelation, TreeEdge, TreePerson } from '@/lib/people';
import { relatePeopleAction, removeRelationshipAction } from './actions';
import { DeletePersonButton } from './delete-person-button';
import type { AddTarget } from './types';

const CARD_WIDTH = 150;

function yearOf(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return date.getUTCFullYear();
}

function lifeSpan(person: TreePerson): string {
  const born = yearOf(person.bornOn);
  const died = yearOf(person.diedOn);
  if (born && died) return `${born}–${died}`;
  if (born) return `${born}–`;
  if (died) return `–${died}`;
  return '';
}

function GenderIcon({ gender, size = 14 }: { gender: Gender; size?: number }) {
  return gender === 'male' ? (
    <IconGenderMale size={size} color="var(--mantine-color-blue-6)" aria-label="Male" />
  ) : (
    <IconGenderFemale size={size} color="var(--mantine-color-pink-6)" aria-label="Female" />
  );
}

const LINK_RELATIONS: { value: PersonRelation; label: string }[] = [
  { value: 'parent', label: 'is a parent of' },
  { value: 'child', label: 'is a child of' },
  { value: 'partner', label: 'is a partner of' },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface Pos {
  cx: number;
  top: number;
  bottom: number;
  midY: number;
  left: number;
  right: number;
}

interface Connectors {
  width: number;
  height: number;
  parents: string[]; // svg path `d` strings
  spouses: { x1: number; x2: number; y: number }[];
}

export interface FamilyTreeProps {
  people: TreePerson[];
  edges: TreeEdge[];
  colorByFamily: Record<string, string>;
  currentUserId: string;
  activeFamilyId: string;
  canEdit: boolean;
  onAddPerson: (target?: AddTarget) => void;
  onEditPerson: (person: TreePerson) => void;
}

export function FamilyTree({
  people,
  edges,
  colorByFamily,
  currentUserId,
  activeFamilyId,
  canEdit,
  onAddPerson,
  onEditPerson,
}: FamilyTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [connectors, setConnectors] = useState<Connectors | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkRelation, setLinkRelation] = useState<PersonRelation>('parent');
  const [linkPersonId, setLinkPersonId] = useState<string | null>(null);
  const [linking, startLinking] = useTransition();

  const peopleById = useMemo(() => {
    const m = new Map<string, TreePerson>();
    for (const p of people) m.set(p.id, p);
    return m;
  }, [people]);

  // Build adjacency + generation layout.
  const { rows, validEdges } = useMemo(() => {
    const ids = new Set(people.map((p) => p.id));
    const parentsOf = new Map<string, string[]>();
    const spousesOf = new Map<string, string[]>();
    const valid: TreeEdge[] = [];

    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };

    for (const e of edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      valid.push(e);
      if (e.type === 'parent') {
        push(parentsOf, e.to, e.from);
      } else {
        push(spousesOf, e.from, e.to);
        push(spousesOf, e.to, e.from);
      }
    }

    // Generation via monotonic relaxation (gens only ever increase).
    const gen = new Map<string, number>();
    for (const id of ids) gen.set(id, 0);
    const cap = people.length * 4 + 4;
    for (let iter = 0; iter < cap; iter++) {
      let changed = false;
      for (const e of valid) {
        if (e.type === 'parent') {
          const want = (gen.get(e.from) ?? 0) + 1;
          if (want > (gen.get(e.to) ?? 0)) {
            gen.set(e.to, want);
            changed = true;
          }
        } else {
          const g = Math.max(gen.get(e.from) ?? 0, gen.get(e.to) ?? 0);
          if (g > (gen.get(e.from) ?? 0)) {
            gen.set(e.from, g);
            changed = true;
          }
          if (g > (gen.get(e.to) ?? 0)) {
            gen.set(e.to, g);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }

    const sortedGens = [...new Set([...gen.values()])].sort((a, b) => a - b);
    const genOrder = new Map<number, string[]>();
    const nameOf = (id: string) => peopleById.get(id)?.displayName ?? '';

    for (const g of sortedGens) {
      const members = people
        .filter((p) => gen.get(p.id) === g)
        .map((p) => p.id)
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const memberSet = new Set(members);
      const prev = genOrder.get(g - 1) ?? [];

      const keyOf = (id: string): number => {
        const parents = (parentsOf.get(id) ?? []).filter((pid) => gen.get(pid) === g - 1);
        const idxs = parents.map((pid) => prev.indexOf(pid)).filter((i) => i >= 0);
        if (idxs.length === 0) return 1e9;
        return idxs.reduce((s, v) => s + v, 0) / idxs.length;
      };

      // Group spouse-linked members into adjacent components.
      const visited = new Set<string>();
      const comps: string[][] = [];
      for (const id of members) {
        if (visited.has(id)) continue;
        const comp: string[] = [];
        const stack = [id];
        while (stack.length) {
          const c = stack.pop()!;
          if (visited.has(c)) continue;
          visited.add(c);
          comp.push(c);
          for (const s of spousesOf.get(c) ?? []) {
            if (memberSet.has(s) && !visited.has(s)) stack.push(s);
          }
        }
        comp.sort((a, b) => keyOf(a) - keyOf(b) || nameOf(a).localeCompare(nameOf(b)));
        comps.push(comp);
      }
      // Order groups by the barycenter (average) of their members' parent positions.
      // Using the minimum instead would let a couple that straddles two families
      // claim the leftmost slot and push a sibling in between another family's
      // children, making the connector lines cross.
      const compKey = (comp: string[]) => {
        const keys = comp.map(keyOf).filter((k) => k < 1e9);
        return keys.length ? keys.reduce((s, v) => s + v, 0) / keys.length : 1e9;
      };
      comps.sort(
        (a, b) => compKey(a) - compKey(b) || nameOf(a[0]).localeCompare(nameOf(b[0])),
      );
      genOrder.set(g, comps.flat());
    }

    const builtRows = sortedGens.map((g) => ({
      gen: g,
      ids: genOrder.get(g) ?? [],
    }));

    return { rows: builtRows, validEdges: valid };
  }, [people, edges, peopleById]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container || cardRefs.current.size === 0) return;
    const crect = container.getBoundingClientRect();
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;
    const pos = new Map<string, Pos>();
    for (const [id, el] of cardRefs.current) {
      const r = el.getBoundingClientRect();
      const left = r.left - crect.left + scrollLeft;
      const top = r.top - crect.top + scrollTop;
      pos.set(id, {
        left,
        right: left + r.width,
        cx: left + r.width / 2,
        top,
        bottom: top + r.height,
        midY: top + r.height / 2,
      });
    }

    const parents: string[] = [];
    const spouses: { x1: number; x2: number; y: number }[] = [];
    const parentPosOfChild = new Map<string, Pos[]>();
    for (const e of validEdges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      if (e.type === 'parent') {
        const arr = parentPosOfChild.get(e.to) ?? [];
        arr.push(a);
        parentPosOfChild.set(e.to, arr);
      } else {
        const [l, r] = a.cx <= b.cx ? [a, b] : [b, a];
        const y = (l.midY + r.midY) / 2;
        spouses.push({ x1: l.right, x2: r.left, y });
      }
    }

    // Parent connectors. When both parents sit side by side, drop ONE line from
    // the middle of the couple (the spouse bar) — two separate elbows read as if
    // the child descended from several couples at once.
    for (const [childId, pps] of parentPosOfChild) {
      const child = pos.get(childId);
      if (!child) continue;
      const sideBySide =
        pps.length === 2 &&
        Math.abs(pps[0].midY - pps[1].midY) < 4 &&
        Math.abs(pps[0].cx - pps[1].cx) < CARD_WIDTH * 2;
      if (sideBySide) {
        const x = (pps[0].cx + pps[1].cx) / 2;
        const startY = (pps[0].midY + pps[1].midY) / 2;
        const busY = (Math.max(pps[0].bottom, pps[1].bottom) + child.top) / 2;
        parents.push(`M ${x} ${startY} V ${busY} H ${child.cx} V ${child.top}`);
      } else {
        for (const p of pps) {
          const busY = (p.bottom + child.top) / 2;
          parents.push(`M ${p.cx} ${p.bottom} V ${busY} H ${child.cx} V ${child.top}`);
        }
      }
    }

    setConnectors({
      width: container.scrollWidth,
      height: container.scrollHeight,
      parents,
      spouses,
    });
  }, [validEdges]);

  useLayoutEffect(() => {
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure, rows]);

  useEffect(() => {
    const container = containerRef.current;
    window.addEventListener('resize', measure);
    let ro: ResizeObserver | undefined;
    if (container && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure());
      ro.observe(container);
    }
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [measure]);

  const selected = selectedId ? peopleById.get(selectedId) : undefined;
  const [unlinking, startUnlink] = useTransition();
  // Edits/links act on the active family, so the person must be one of its members.
  const canEditSelected =
    canEdit && !!selected && selected.familyIds.includes(activeFamilyId);
  const linkCandidates = useMemo(
    () =>
      selected
        ? people
            .filter((p) => p.id !== selected.id && p.familyIds.includes(activeFamilyId))
            .map((p) => ({ value: p.id, label: p.displayName }))
        : [],
    [people, selected, activeFamilyId],
  );

  // The selected person's existing edges, labelled from their point of view.
  const connections = useMemo(() => {
    if (!selectedId) return [];
    const rows: { label: string; other: TreePerson; edge: TreeEdge }[] = [];
    for (const e of validEdges) {
      let label: string | null = null;
      let otherId: string | null = null;
      if (e.type === 'parent' && e.to === selectedId) {
        label = 'Parent';
        otherId = e.from;
      } else if (e.type === 'parent' && e.from === selectedId) {
        label = 'Child';
        otherId = e.to;
      } else if (e.type === 'spouse' && (e.from === selectedId || e.to === selectedId)) {
        label = 'Partner';
        otherId = e.from === selectedId ? e.to : e.from;
      }
      const other = otherId ? peopleById.get(otherId) : undefined;
      if (label && other) rows.push({ label, other, edge: e });
    }
    const order: Record<string, number> = { Parent: 0, Partner: 1, Child: 2 };
    rows.sort(
      (a, b) =>
        (order[a.label] ?? 9) - (order[b.label] ?? 9) ||
        a.other.displayName.localeCompare(b.other.displayName),
    );
    return rows;
  }, [selectedId, validEdges, peopleById]);

  function selectPerson(id: string | null) {
    setSelectedId(id);
    setLinkRelation('parent');
    setLinkPersonId(null);
  }

  function handleUnlink(edge: TreeEdge) {
    startUnlink(async () => {
      try {
        await removeRelationshipAction({
          type: edge.type,
          personFromId: edge.from,
          personToId: edge.to,
        });
        notifications.show({ message: 'Connection removed' });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not remove the connection',
        });
      }
    });
  }

  function handleLink() {
    if (!selected || !linkPersonId) return;
    const relativeName = peopleById.get(linkPersonId)?.displayName ?? 'them';
    startLinking(async () => {
      try {
        await relatePeopleAction({
          familyId: activeFamilyId,
          personId: selected.id,
          relativeId: linkPersonId,
          relation: linkRelation,
        });
        const label = LINK_RELATIONS.find((r) => r.value === linkRelation)?.label;
        notifications.show({
          message: `Linked: ${selected.displayName} ${label} ${relativeName}.`,
        });
        setLinkPersonId(null);
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not link those people',
        });
      }
    });
  }

  return (
    <Stack gap="md">
      {canEdit && (
        <Group justify="flex-end">
          <Button
            leftSection={<IconPlus size={16} />}
            variant="light"
            onClick={() => onAddPerson()}
          >
            Add person
          </Button>
        </Group>
      )}

      {people.length === 0 ? (
        <Paper withBorder radius="md" p="xl">
          <Text c="dimmed" ta="center">
            No people in the tree yet.
            {canEdit ? ' Add the first person to get started.' : ''}
          </Text>
        </Paper>
      ) : (
        <Box
          ref={containerRef}
          style={{ position: 'relative', overflowX: 'auto', paddingBottom: 8 }}
        >
          {connectors && (
            <svg
              width={connectors.width}
              height={connectors.height}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                pointerEvents: 'none',
                zIndex: 0,
              }}
            >
              {connectors.parents.map((d, i) => (
                <path
                  key={`p-${i}`}
                  d={d}
                  fill="none"
                  stroke="var(--mantine-color-slate-3)"
                  strokeWidth={1.5}
                />
              ))}
              {connectors.spouses.map((s, i) => (
                <g key={`s-${i}`} stroke="var(--mantine-color-slate-4)" strokeWidth={1.5}>
                  <line x1={s.x1} y1={s.y - 2} x2={s.x2} y2={s.y - 2} />
                  <line x1={s.x1} y1={s.y + 2} x2={s.x2} y2={s.y + 2} />
                </g>
              ))}
            </svg>
          )}

          <Stack gap={56} style={{ position: 'relative', zIndex: 1, minWidth: 'fit-content' }}>
            {rows.map((row) => (
              <Group key={row.gen} justify="center" gap="lg" wrap="nowrap" align="flex-start">
                {row.ids.map((id) => {
                  const person = peopleById.get(id);
                  if (!person) return null;
                  const isMe = person.userId === currentUserId;
                  return (
                    <Card
                      key={id}
                      ref={(el: HTMLDivElement | null) => {
                        if (el) cardRefs.current.set(id, el);
                        else cardRefs.current.delete(id);
                      }}
                      withBorder
                      radius="md"
                      padding="sm"
                      onClick={() => selectPerson(id)}
                      style={{
                        position: 'relative',
                        width: CARD_WIDTH,
                        flex: '0 0 auto',
                        cursor: 'pointer',
                        borderColor: isMe ? 'var(--mantine-color-brand-6)' : undefined,
                        borderWidth: isMe ? 2 : undefined,
                        boxShadow: isMe ? '0 0 0 2px var(--mantine-color-brand-1)' : undefined,
                      }}
                    >
                      {person.gender && (
                        <Box
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            display: 'flex',
                          }}
                        >
                          <GenderIcon gender={person.gender} />
                        </Box>
                      )}
                      <Stack align="center" gap={6}>
                        <Avatar radius="xl" size={48} color={isMe ? 'brand' : 'slate'}>
                          {initials(person.displayName)}
                        </Avatar>
                        <Text fw={600} size="sm" ta="center" lineClamp={2}>
                          {person.displayName}
                        </Text>
                        {lifeSpan(person) && (
                          <Text size="xs" c="dimmed">
                            {lifeSpan(person)}
                          </Text>
                        )}
                        {person.familyIds.length > 0 && (
                          <Group gap={4} justify="center">
                            {person.familyIds.map((fid) => (
                              <Box
                                key={fid}
                                w={8}
                                h={8}
                                style={{
                                  borderRadius: '50%',
                                  background:
                                    colorByFamily[fid] ?? 'var(--mantine-color-slate-4)',
                                }}
                              />
                            ))}
                          </Group>
                        )}
                      </Stack>
                    </Card>
                  );
                })}
              </Group>
            ))}
          </Stack>
        </Box>
      )}

      <Drawer
        opened={!!selected}
        onClose={() => selectPerson(null)}
        position="right"
        title="Person"
        padding="lg"
      >
        {selected && (
          <Stack>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Group wrap="nowrap">
                <Avatar
                  radius="xl"
                  size={56}
                  color={selected.userId === currentUserId ? 'brand' : 'slate'}
                >
                  {initials(selected.displayName)}
                </Avatar>
                <div>
                  <Group gap={6} wrap="nowrap">
                    <Title order={4}>{selected.displayName}</Title>
                    {selected.gender && <GenderIcon gender={selected.gender} size={18} />}
                  </Group>
                  {lifeSpan(selected) && (
                    <Text size="sm" c="dimmed">
                      {lifeSpan(selected)}
                    </Text>
                  )}
                </div>
              </Group>
              {canEditSelected && !selected.userId && (
                <DeletePersonButton
                  familyId={activeFamilyId}
                  personId={selected.id}
                  name={selected.displayName}
                />
              )}
            </Group>

            {selected.familyName && (
              <Text size="sm">
                <Text span c="dimmed">
                  Family name:{' '}
                </Text>
                {selected.familyName}
              </Text>
            )}
            {selected.userId && (
              <Text size="sm" c="brand">
                Linked to an account
              </Text>
            )}

            {canEditSelected && (
              <Button
                variant="default"
                leftSection={<IconPencil size={16} />}
                onClick={() => {
                  const person = selected;
                  selectPerson(null);
                  onEditPerson(person);
                }}
              >
                Edit details
              </Button>
            )}

            {connections.length > 0 && (
              <Stack gap="xs" mt="md">
                <Text size="sm" fw={600}>
                  Connections
                </Text>
                {connections.map(({ label, other, edge }) => (
                  <Group
                    key={`${edge.type}-${edge.from}-${edge.to}-${label}`}
                    justify="space-between"
                    wrap="nowrap"
                  >
                    <Text size="sm">
                      <Text span c="dimmed">
                        {label}:{' '}
                      </Text>
                      {other.displayName}
                    </Text>
                    {canEditSelected && (
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Remove ${label.toLowerCase()} connection to ${other.displayName}`}
                        loading={unlinking}
                        onClick={() => handleUnlink(edge)}
                      >
                        <IconUnlink size={16} />
                      </ActionIcon>
                    )}
                  </Group>
                ))}
              </Stack>
            )}

            {canEditSelected && (
              <Stack gap="xs" mt="md">
                <Text size="sm" fw={600}>
                  Connect a new person
                </Text>
                <Button
                  variant="light"
                  leftSection={<IconArrowUp size={16} />}
                  disabled={connections.filter((c) => c.label === 'Parent').length >= 2}
                  onClick={() =>
                    onAddPerson({
                      personId: selected.id,
                      personName: selected.displayName,
                      relation: 'parent',
                    })
                  }
                >
                  Add parent
                </Button>
                {connections.filter((c) => c.label === 'Parent').length >= 2 && (
                  <Text size="xs" c="dimmed">
                    Both parents are set — remove one above to change them.
                  </Text>
                )}
                <Button
                  variant="light"
                  leftSection={<IconArrowDown size={16} />}
                  onClick={() =>
                    onAddPerson({
                      personId: selected.id,
                      personName: selected.displayName,
                      relation: 'child',
                    })
                  }
                >
                  Add child
                </Button>
                <Button
                  variant="light"
                  leftSection={<IconHeart size={16} />}
                  onClick={() =>
                    onAddPerson({
                      personId: selected.id,
                      personName: selected.displayName,
                      relation: 'partner',
                    })
                  }
                >
                  Add partner
                </Button>
              </Stack>
            )}

            {canEditSelected && linkCandidates.length > 0 && (
              <Stack gap="xs" mt="md">
                <Text size="sm" fw={600}>
                  Link to an existing person
                </Text>
                <Select
                  aria-label="Relationship"
                  data={LINK_RELATIONS.map((r) => ({
                    value: r.value,
                    label: `${selected.displayName} ${r.label}…`,
                  }))}
                  value={linkRelation}
                  onChange={(v) => v && setLinkRelation(v as PersonRelation)}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                />
                <Select
                  aria-label="Person to link"
                  placeholder="Choose a person"
                  searchable
                  data={linkCandidates}
                  value={linkPersonId}
                  onChange={setLinkPersonId}
                  comboboxProps={{ withinPortal: false }}
                />
                <Button
                  leftSection={<IconLink size={16} />}
                  disabled={!linkPersonId}
                  loading={linking}
                  onClick={handleLink}
                >
                  Link people
                </Button>
              </Stack>
            )}
          </Stack>
        )}
      </Drawer>
    </Stack>
  );
}
