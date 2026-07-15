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
  Badge,
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
  IconMaximize,
  IconMinus,
  IconPencil,
  IconPlus,
  IconUnlink,
} from '@tabler/icons-react';
import type { Gender, PersonRelation, TreeEdge, TreePerson } from '@/lib/people';
import { layoutFamilyTree } from '@/lib/tree-layout';
import { birthSurname, personFullName } from '@/lib/person-name';
import { formatEventDate } from '@/lib/dates';
import type { DatePrecision } from '@/lib/stories';
import { useI18n } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/config';
import { relatePeopleAction, removeRelationshipAction } from './actions';
import { DeletePersonButton } from './delete-person-button';
import type { AddTarget } from './types';

const CARD_WIDTH = 150;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const clampZoom = (s: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

function yearOf(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return date.getUTCFullYear();
}

/** Compact years for the tree card: "1948–2019", "born 1948", or "–2019". */
function lifeSpan(person: TreePerson, t: Dictionary): string {
  const born = yearOf(person.bornOn);
  const died = yearOf(person.diedOn);
  if (born && died) return `${born}–${died}`;
  if (born) return t.person.bornOnly(String(born));
  if (died) return `–${died}`;
  return '';
}

/** Same shape as lifeSpan, but at full stored precision — for the person drawer. */
function lifeSpanFull(person: TreePerson, t: Dictionary, locale: Locale): string {
  const born = formatEventDate(person.bornOn, person.bornPrecision as DatePrecision | null, locale);
  const died = formatEventDate(person.diedOn, person.diedPrecision as DatePrecision | null, locale);
  if (born && died) return `${born} – ${died}`;
  if (born) return t.person.bornOnly(born);
  if (died) return `– ${died}`;
  return '';
}

function GenderIcon({ gender, size = 14 }: { gender: Gender; size?: number }) {
  const { t } = useI18n();
  return gender === 'male' ? (
    <IconGenderMale size={size} color="var(--mantine-color-blue-6)" aria-label={t.tree.maleAria} />
  ) : (
    <IconGenderFemale
      size={size}
      color="var(--mantine-color-pink-6)"
      aria-label={t.tree.femaleAria}
    />
  );
}

const LINK_RELATIONS: { value: PersonRelation; label: (t: Dictionary) => string }[] = [
  { value: 'parent', label: (t) => t.tree.isParentOf },
  { value: 'child', label: (t) => t.tree.isChildOf },
  { value: 'partner', label: (t) => t.tree.isPartnerOf },
];

/** Stable key for a connection from the selected person's point of view. */
type RelationKey = 'parent' | 'child' | 'partner';

function relationLabel(key: RelationKey, t: Dictionary): string {
  return key === 'parent'
    ? t.tree.relationParent
    : key === 'child'
      ? t.tree.relationChild
      : t.tree.relationPartner;
}

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
  /** Color per derived family tag (surname) — drives the dots under each card. */
  colorByTag: Record<string, string>;
  currentUserId: string;
  activeChronicleId: string;
  canEdit: boolean;
  onAddPerson: (target?: AddTarget) => void;
  onEditPerson: (person: TreePerson) => void;
}

export function FamilyTree({
  people,
  edges,
  colorByTag,
  currentUserId,
  activeChronicleId,
  canEdit,
  onAddPerson,
  onEditPerson,
}: FamilyTreeProps) {
  const { t, locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Current pan/zoom, applied imperatively to `worldRef` so gestures never
  // trigger a React re-render. `didFit` guards the one-time initial fit;
  // `moved` suppresses the card-select click at the end of a drag/pinch.
  // `interacted` tracks whether the user has panned/zoomed since the last fit:
  // until they do, container/content resizes (fonts and flex settling after
  // mount, window resizes) keep re-fitting the view instead of leaving the
  // tree at a stale — possibly MIN_ZOOM-clamped — initial fit.
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const didFitRef = useRef(false);
  const movedRef = useRef(false);
  const interactedRef = useRef(false);
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

  // Layered layout with couple blocks, crossing minimization and balanced
  // x placement — see lib/tree-layout.ts for the algorithm.
  const { rows, validEdges, margins } = useMemo(
    () => layoutFamilyTree(people, edges, { cardWidth: CARD_WIDTH, hGap: 24 }),
    [people, edges],
  );

  const measure = useCallback(() => {
    const world = worldRef.current;
    if (!world || cardRefs.current.size === 0) return;
    // Measure in the world's own (unscaled) coordinate space: the world may be
    // zoomed via a CSS transform, so divide screen rects by the current scale
    // to recover natural coordinates the SVG (a child of the world) draws in.
    const wrect = world.getBoundingClientRect();
    const s = view.current.scale || 1;
    const pos = new Map<string, Pos>();
    for (const [id, el] of cardRefs.current) {
      const r = el.getBoundingClientRect();
      const left = (r.left - wrect.left) / s;
      const top = (r.top - wrect.top) / s;
      const width = r.width / s;
      const height = r.height / s;
      pos.set(id, {
        left,
        right: left + width,
        cx: left + width / 2,
        top,
        bottom: top + height,
        midY: top + height / 2,
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
      // Rows are top-aligned, so compare tops: cards in the same row can have
      // different heights (born-surname line, life span), which shifts midY.
      const sideBySide =
        pps.length === 2 &&
        Math.abs(pps[0].top - pps[1].top) < 4 &&
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
      width: world.offsetWidth,
      height: world.offsetHeight,
      parents,
      spouses,
    });
  }, [validEdges]);

  // Push the current pan/zoom onto the world element. Called imperatively from
  // gesture handlers (no state update) and re-asserted after every React commit
  // via the deps-less layout effect below, so unrelated re-renders (selecting a
  // person, new connectors) don't wipe out the viewport.
  const applyTransform = useCallback(() => {
    const w = worldRef.current;
    if (!w) return;
    const { x, y, scale } = view.current;
    w.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);

  useLayoutEffect(() => {
    applyTransform();
  });

  // Zoom by `factor` while keeping the point (px, py) — in viewport pixels —
  // pinned under the cursor / pinch midpoint.
  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      interactedRef.current = true;
      const t = view.current;
      const next = clampZoom(t.scale * factor);
      const k = next / t.scale;
      t.x = px - (px - t.x) * k;
      t.y = py - (py - t.y) * k;
      t.scale = next;
      applyTransform();
    },
    [applyTransform],
  );

  // Scale the whole tree to fit the viewport and center it.
  const fitView = useCallback(() => {
    const vp = containerRef.current;
    const w = worldRef.current;
    if (!vp || !w) return;
    const cw = vp.clientWidth;
    const ch = vp.clientHeight;
    const ww = w.offsetWidth;
    const wh = w.offsetHeight;
    if (!ww || !wh) return;
    const scale = clampZoom(Math.min(cw / ww, ch / wh, 1));
    view.current = {
      scale,
      x: (cw - ww * scale) / 2,
      y: (ch - wh * scale) / 2,
    };
    // Fitting (initial, on resize, or via the fit button) re-arms auto-fit.
    interactedRef.current = false;
    applyTransform();
  }, [applyTransform]);

  const zoomFromButton = useCallback(
    (factor: number) => {
      const vp = containerRef.current;
      if (!vp) return;
      zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, factor);
    },
    [zoomAt],
  );

  useLayoutEffect(() => {
    measure();
    if (!didFitRef.current && worldRef.current?.offsetWidth) {
      fitView();
      didFitRef.current = true;
    }
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure, rows, fitView]);

  useEffect(() => {
    const container = containerRef.current;
    window.addEventListener('resize', measure);
    let ro: ResizeObserver | undefined;
    if (container && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        measure();
        // The initial fit can run before fonts/flex settle the container (or
        // the cards), storing a badly clamped scale. Until the user pans or
        // zooms themselves, follow size changes by re-fitting. Transforms
        // don't affect the observed layout sizes, so this can't loop.
        if (!interactedRef.current) fitView();
      });
      ro.observe(container);
      if (worldRef.current) ro.observe(worldRef.current);
    }
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [measure, fitView]);

  // Google-Maps-style navigation: drag to pan, wheel/pinch to zoom. Handlers are
  // native (not React props) so the wheel listener can be non-passive and call
  // preventDefault, and so pointer tracking survives the cursor leaving a card.
  useEffect(() => {
    const vp = containerRef.current;
    if (!vp || people.length === 0) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let startX = 0;
    let startY = 0;
    let pinchDist = 0;

    const twoPointerSpread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const twoPointerMid = () => {
      const [a, b] = [...pointers.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        startX = e.clientX;
        startY = e.clientY;
        movedRef.current = false;
        vp.style.cursor = 'grabbing';
      } else if (pointers.size === 2) {
        pinchDist = twoPointerSpread();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const rect = vp.getBoundingClientRect();
      if (pointers.size >= 2) {
        const dist = twoPointerSpread();
        const mid = twoPointerMid();
        if (pinchDist > 0) zoomAt(mid.x - rect.left, mid.y - rect.top, dist / pinchDist);
        pinchDist = dist;
        movedRef.current = true;
      } else {
        view.current.x += e.clientX - prev.x;
        view.current.y += e.clientY - prev.y;
        interactedRef.current = true;
        applyTransform();
        if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) movedRef.current = true;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) vp.style.cursor = 'grab';
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
    };

    vp.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      vp.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      vp.removeEventListener('wheel', onWheel);
    };
  }, [applyTransform, zoomAt, people.length]);

  const selected = selectedId ? peopleById.get(selectedId) : undefined;
  const [unlinking, startUnlink] = useTransition();
  // Edits/links act on the active family, so the person must be one of its members.
  const canEditSelected =
    canEdit && !!selected && selected.chronicleIds.includes(activeChronicleId);
  const linkCandidates = useMemo(
    () =>
      selected
        ? people
            .filter((p) => p.id !== selected.id && p.chronicleIds.includes(activeChronicleId))
            .map((p) => ({ value: p.id, label: personFullName(p) }))
        : [],
    [people, selected, activeChronicleId],
  );

  // The selected person's existing edges, keyed from their point of view.
  const connections = useMemo(() => {
    if (!selectedId) return [];
    const rows: { key: RelationKey; other: TreePerson; edge: TreeEdge }[] = [];
    for (const e of validEdges) {
      let key: RelationKey | null = null;
      let otherId: string | null = null;
      if (e.type === 'parent' && e.to === selectedId) {
        key = 'parent';
        otherId = e.from;
      } else if (e.type === 'parent' && e.from === selectedId) {
        key = 'child';
        otherId = e.to;
      } else if (e.type === 'spouse' && (e.from === selectedId || e.to === selectedId)) {
        key = 'partner';
        otherId = e.from === selectedId ? e.to : e.from;
      }
      const other = otherId ? peopleById.get(otherId) : undefined;
      if (key && other) rows.push({ key, other, edge: e });
    }
    const order: Record<RelationKey, number> = { parent: 0, partner: 1, child: 2 };
    rows.sort(
      (a, b) =>
        (order[a.key] ?? 9) - (order[b.key] ?? 9) ||
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
        notifications.show({ message: t.tree.connectionRemoved });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.tree.couldNotRemoveConnection,
        });
      }
    });
  }

  function handleLink() {
    if (!selected || !linkPersonId) return;
    const relative = peopleById.get(linkPersonId);
    const relativeName = relative ? personFullName(relative) : '…';
    startLinking(async () => {
      try {
        await relatePeopleAction({
          chronicleId: activeChronicleId,
          personId: selected.id,
          relativeId: linkPersonId,
          relation: linkRelation,
        });
        const label = LINK_RELATIONS.find((r) => r.value === linkRelation)?.label(t) ?? '';
        notifications.show({
          message: t.tree.linked(personFullName(selected), label, relativeName),
        });
        setLinkPersonId(null);
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.tree.couldNotLink,
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
            {t.tree.addPerson}
          </Button>
        </Group>
      )}

      {people.length === 0 ? (
        <Paper withBorder radius="md" p="xl">
          <Text c="dimmed" ta="center">
            {t.tree.emptyTree}
            {canEdit ? t.tree.emptyTreeAddFirst : ''}
          </Text>
        </Paper>
      ) : (
        <Box
          ref={containerRef}
          style={{
            position: 'relative',
            overflow: 'hidden',
            height: 'clamp(360px, 70vh, 760px)',
            touchAction: 'none',
            cursor: 'grab',
            userSelect: 'none',
            borderRadius: 'var(--mantine-radius-md)',
            border: '1px solid var(--mantine-color-slate-2)',
            background: 'var(--mantine-color-slate-0)',
          }}
        >
          <div
            ref={worldRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 'fit-content',
              transformOrigin: '0 0',
              willChange: 'transform',
            }}
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

            <Stack
              gap={56}
              style={{
                position: 'relative',
                zIndex: 1,
                minWidth: 'fit-content',
                width: 'fit-content',
              }}
            >
              {rows.map((row) => (
                <Group key={row.gen} gap={0} wrap="nowrap" align="flex-start">
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
                        onClick={() => {
                          // A drag/pinch ends in a click on the card under the
                          // pointer — don't treat that as a selection.
                          if (movedRef.current) return;
                          selectPerson(id);
                        }}
                          style={{
                          position: 'relative',
                          width: CARD_WIDTH,
                          flex: '0 0 auto',
                          marginLeft: margins.get(id) ?? 0,
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
                            {initials(personFullName(person))}
                          </Avatar>
                          <Text fw={600} size="sm" ta="center" lineClamp={2}>
                            {personFullName(person)}
                          </Text>
                          {birthSurname(person) && (
                            <Text size="xs" c="dimmed" fs="italic" ta="center">
                              ({t.tree.bornSurname(birthSurname(person)!)})
                            </Text>
                          )}
                          {lifeSpan(person, t) && (
                            <Text size="xs" c="dimmed">
                              {lifeSpan(person, t)}
                            </Text>
                          )}
                          {person.familyTags.length > 0 && (
                            <Group gap={4} justify="center">
                              {person.familyTags.map((tag) => (
                                <Box
                                  key={tag}
                                  title={tag}
                                  w={8}
                                  h={8}
                                  style={{
                                    borderRadius: '50%',
                                    background:
                                      colorByTag[tag] ?? 'var(--mantine-color-slate-4)',
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
          </div>

          <Group gap={6} style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 2 }}>
            <ActionIcon
              variant="default"
              size="lg"
              radius="md"
              aria-label={t.tree.zoomOut}
              onClick={() => zoomFromButton(1 / 1.3)}
            >
              <IconMinus size={18} />
            </ActionIcon>
            <ActionIcon
              variant="default"
              size="lg"
              radius="md"
              aria-label={t.tree.resetView}
              onClick={fitView}
            >
              <IconMaximize size={18} />
            </ActionIcon>
            <ActionIcon
              variant="default"
              size="lg"
              radius="md"
              aria-label={t.tree.zoomIn}
              onClick={() => zoomFromButton(1.3)}
            >
              <IconPlus size={18} />
            </ActionIcon>
          </Group>
        </Box>
      )}

      <Drawer
        opened={!!selected}
        onClose={() => selectPerson(null)}
        position="right"
        title={t.tree.personDrawerTitle}
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
                  {initials(personFullName(selected))}
                </Avatar>
                <div>
                  <Group gap={6} wrap="nowrap">
                    <Title order={4}>{personFullName(selected)}</Title>
                    {selected.gender && <GenderIcon gender={selected.gender} size={18} />}
                  </Group>
                  {birthSurname(selected) && (
                    <Text size="sm" c="dimmed" fs="italic">
                      {t.tree.bornSurname(birthSurname(selected)!)}
                    </Text>
                  )}
                  {lifeSpanFull(selected, t, locale) && (
                    <Text size="sm" c="dimmed">
                      {lifeSpanFull(selected, t, locale)}
                    </Text>
                  )}
                </div>
              </Group>
              {canEditSelected && !selected.userId && (
                <DeletePersonButton
                  chronicleId={activeChronicleId}
                  personId={selected.id}
                  name={personFullName(selected)}
                />
              )}
            </Group>

            {selected.familyName && (
              <Text size="sm">
                <Text span c="dimmed">
                  {t.tree.familyNameLabel}:{' '}
                </Text>
                {selected.familyName}
              </Text>
            )}
            {birthSurname(selected) && (
              <Text size="sm">
                <Text span c="dimmed">
                  {t.tree.birthNameLabel}:{' '}
                </Text>
                {birthSurname(selected)}
              </Text>
            )}
            {selected.familyTags.length > 0 && (
              <Group gap={6}>
                {selected.familyTags.map((tag) => (
                  <Badge
                    key={tag}
                    size="sm"
                    variant="light"
                    radius="sm"
                    styles={{
                      root: {
                        background: 'var(--mantine-color-slate-1)',
                        color: 'var(--mantine-color-slate-7)',
                      },
                    }}
                    leftSection={
                      <Box
                        w={8}
                        h={8}
                        style={{
                          borderRadius: '50%',
                          background: colorByTag[tag] ?? 'var(--mantine-color-slate-4)',
                        }}
                      />
                    }
                  >
                    {tag}
                  </Badge>
                ))}
              </Group>
            )}
            {selected.userId && (
              <Text size="sm" c="brand">
                {t.tree.linkedToAccount}
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
                {t.tree.editDetails}
              </Button>
            )}

            {connections.length > 0 && (
              <Stack gap="xs" mt="md">
                <Text size="sm" fw={600}>
                  {t.tree.connections}
                </Text>
                {connections.map(({ key, other, edge }) => (
                  <Group
                    key={`${edge.type}-${edge.from}-${edge.to}-${key}`}
                    justify="space-between"
                    wrap="nowrap"
                  >
                    <Text size="sm">
                      <Text span c="dimmed">
                        {relationLabel(key, t)}:{' '}
                      </Text>
                      {personFullName(other)}
                    </Text>
                    {canEditSelected && (
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={t.tree.removeConnectionAria(
                          relationLabel(key, t),
                          personFullName(other),
                        )}
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
                  {t.tree.connectNewPerson}
                </Text>
                <Button
                  variant="light"
                  leftSection={<IconArrowUp size={16} />}
                  disabled={connections.filter((c) => c.key === 'parent').length >= 2}
                  onClick={() =>
                    onAddPerson({
                      personId: selected.id,
                      personName: personFullName(selected),
                      relation: 'parent',
                    })
                  }
                >
                  {t.tree.addParent}
                </Button>
                {connections.filter((c) => c.key === 'parent').length >= 2 && (
                  <Text size="xs" c="dimmed">
                    {t.tree.bothParentsSet}
                  </Text>
                )}
                <Button
                  variant="light"
                  leftSection={<IconArrowDown size={16} />}
                  onClick={() =>
                    onAddPerson({
                      personId: selected.id,
                      personName: personFullName(selected),
                      relation: 'child',
                    })
                  }
                >
                  {t.tree.addChild}
                </Button>
                <Button
                  variant="light"
                  leftSection={<IconHeart size={16} />}
                  onClick={() =>
                    onAddPerson({
                      personId: selected.id,
                      personName: personFullName(selected),
                      relation: 'partner',
                    })
                  }
                >
                  {t.tree.addPartner}
                </Button>
              </Stack>
            )}

            {canEditSelected && linkCandidates.length > 0 && (
              <Stack gap="xs" mt="md">
                <Text size="sm" fw={600}>
                  {t.tree.linkToExisting}
                </Text>
                <Select
                  aria-label={t.tree.relationshipAria}
                  data={LINK_RELATIONS.map((r) => ({
                    value: r.value,
                    label: `${personFullName(selected)} ${r.label(t)}…`,
                  }))}
                  value={linkRelation}
                  onChange={(v) => v && setLinkRelation(v as PersonRelation)}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                />
                <Select
                  aria-label={t.tree.personToLinkAria}
                  placeholder={t.tree.choosePerson}
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
                  {t.tree.linkPeople}
                </Button>
              </Stack>
            )}
          </Stack>
        )}
      </Drawer>
    </Stack>
  );
}
