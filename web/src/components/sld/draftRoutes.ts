/**
 * The routes the lines take round the drafts, for as long as the drafts
 * stand where they stand.
 *
 * A draft is a placeholder: an element that was placed on the diagram and
 * is not in the system yet (`store/drafts.ts`). It is drawn among
 * everything else, so a line it stands on is routed round it
 * (`routing.ts`), like a line a device was dropped on. But where a route
 * made for a device becomes the route the diagram keeps, one made for a
 * draft does not: the diagram keeps the route the line had, and the way
 * round the draft is only what is drawn while the draft is there. Move the
 * draft, delete it or add it to the system, and every line is drawn from
 * the route it keeps again, so a placeholder leaves no mark on the lines of
 * the system. Nor does it reach what is made from the routes the diagram
 * keeps: the layout written beside the case, the arrangement an Undo puts
 * back, the figure of the diagram.
 *
 * `DraftRoutes` is what the canvas holds for that: by edge, the route round
 * the drafts, made for the drafts as they stood (`stand`) and in the place
 * of one route the line keeps (`from`). `withDraftRoutes` puts them on the
 * edges a picture is made from, so the picture finds them in place and
 * searches for nothing. With a draft anywhere else, or the line keeping
 * another route, it leaves the edge as it is, and the picture works the way
 * round out afresh from the route the line keeps. `settleDraftRoutes` reads
 * a picture at rest: which of the routes it made are the diagram's own to
 * keep (a bus was moved, a layout brought no routes), and which only the
 * drafts ask for. It tells them apart by routing the diagram once more
 * without its drafts, and only when the picture made a route at all.
 *
 * What the canvas holds goes when the canvas does, and a diagram that is
 * opened again would work every way round its drafts out afresh: in one
 * pass, where they were made one after the other as the drafts were placed
 * and the devices moved, so the lines could come back on other ways than
 * they were left on. So the ways are kept with the drafts (`KeptDraftRoutes`,
 * in `store/drafts.ts`), and with them the route of each draft that is
 * drawn as a line itself: `draftRoutesKept` is what a diagram at rest
 * leaves to be kept, and `draftRoutesFrom` what the canvas holds of it when
 * the case is opened again. They are kept for the system they were drawn
 * for, which `systemOf` names.
 *
 * Pure: no React, nothing read but the arguments.
 */
import type { TopologySummary } from '@/api/types';
import { fnv1a32 } from '@/lib/runIdToColor';
import type { KeptDraftRoutes, KeptRoute } from '@/store/drafts';
import type { ConnectionEdge } from './connections';
import { DRAFT_NODE_TYPE, draftIdOf } from './drafts';
import type { LabelNode } from './labels';
import { routesOf, type PictureOptions } from './picture';
import type { RouteAnchors, RoutedDiagram } from './routing';

/** The route a line is drawn along while a draft stands in the way of the one it keeps. */
export interface DraftRoute {
  points: [number, number][];
  /** Where the two buses of the line stood when the route was made. */
  anchors: RouteAnchors;
  /** The route the line keeps, in the place of which this one is drawn (`routeKey`). */
  from: string;
}

export interface DraftRoutes {
  /** Where the drafts stood when the routes were made (`draftsStand`). */
  stand: string;
  /** The routes, by edge id. */
  routes: ReadonlyMap<string, DraftRoute>;
}

/** No line has to go round a draft. */
export const NO_DRAFT_ROUTES: DraftRoutes = { stand: '', routes: new Map() };

/** A route the diagram keeps for an edge, as text: what `DraftRoute.from` holds. */
function routeKey(points: unknown): string {
  return JSON.stringify(Array.isArray(points) ? points : null);
}

/** Whether two routes run through the same points. */
function sameRoute(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 0.01 && Math.abs(p[1] - b[i]![1]) < 0.01)
  );
}

/**
 * Where the drafts of a diagram stand and what each is connected to, as one
 * text: the same for two diagrams whose lines have the same drafts to go
 * round, and empty for a diagram without a draft.
 */
export function draftsStand(
  nodes: readonly Pick<LabelNode, 'id' | 'type' | 'position'>[],
  edges: readonly ConnectionEdge[],
): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.type !== DRAFT_NODE_TYPE) continue;
    parts.push(`${node.id}@${node.position.x},${node.position.y}`);
  }
  for (const edge of edges) {
    if (draftIdOf(edge) !== null) parts.push(`${edge.id}:${edge.source}>${edge.target}`);
  }
  return parts.join(';');
}

/** The routes of `held` that fit `edges` with the drafts standing as `stand` says, by edge id. */
function inPlace(
  edges: readonly ConnectionEdge[],
  held: DraftRoutes,
  stand: string,
): Map<string, DraftRoute> {
  const fitting = new Map<string, DraftRoute>();
  if (held.stand !== stand || held.routes.size === 0) return fitting;
  for (const edge of edges) {
    const route = held.routes.get(edge.id);
    if (route !== undefined && route.from === routeKey(edge.data?.bendPoints)) {
      fitting.set(edge.id, route);
    }
  }
  return fitting;
}

/**
 * `edges` as a picture is made from them while drafts stand on the
 * diagram: each line that goes round a draft with that route in the place
 * of the one it keeps. The routes of `held` count only for the drafts as
 * they stood when it was made (`stand`, which is `draftsStand` of the
 * diagram now), and each only for the route its line kept then.
 */
export function withDraftRoutes<E extends ConnectionEdge>(
  edges: readonly E[],
  held: DraftRoutes,
  stand: string,
): readonly E[] {
  const fitting = inPlace(edges, held, stand);
  if (fitting.size === 0) return edges;
  return edges.map((edge): E => {
    const route = fitting.get(edge.id);
    if (route === undefined) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        bendPoints: route.points,
        bendAnchors: route.anchors,
        // The way round a draft is the diagram's, whoever drew the route it stands in for.
        bendManual: undefined,
      },
    };
  });
}

function sameDraftRoutes(a: DraftRoutes, stand: string, routes: ReadonlyMap<string, DraftRoute>) {
  if (a.stand !== stand || a.routes.size !== routes.size) return false;
  for (const [id, route] of routes) {
    const other = a.routes.get(id);
    if (
      other === undefined ||
      other.from !== route.from ||
      !sameRoute(other.points, route.points) ||
      JSON.stringify(other.anchors) !== JSON.stringify(route.anchors)
    ) {
      return false;
    }
  }
  return true;
}

/** What a picture at rest leaves to be kept (`settleDraftRoutes`). */
export interface SettledRoutes<E extends ConnectionEdge> {
  /** The routes that become the ones the diagram keeps (`RoutedDiagram.changed`). */
  changed: RoutedDiagram<E>['changed'];
  /** The routes drawn by hand that are the user's no longer (`RoutedDiagram.released`). */
  released: string[];
  /** The routes round the drafts as they are drawn now: `held` itself where nothing of it changed. */
  routes: DraftRoutes;
}

/**
 * What is kept of `picture`, the picture at rest of `nodes` and of `edges`
 * with the routes `held` in place (`withDraftRoutes`). `edges` are the
 * edges as the diagram keeps them.
 *
 * Without a draft on the diagram every route the picture made is the
 * diagram's to keep. With one, and a route made, the diagram is routed
 * once more without its drafts (`routesOf`): what that makes afresh is what
 * the diagram keeps, and a line the picture draws another way than the
 * diagram keeps it goes round a draft, so that way is held in `routes` and
 * kept nowhere else. The route of a draft that is drawn as a branch is the
 * draft's own, and is kept as the picture made it.
 */
export function settleDraftRoutes<E extends ConnectionEdge>(
  nodes: readonly LabelNode[],
  edges: readonly E[],
  picture: Pick<RoutedDiagram<E>, 'changed' | 'released'>,
  held: DraftRoutes,
  options: PictureOptions,
): SettledRoutes<E> {
  const stand = draftsStand(nodes, edges);
  if (stand === '') {
    return { changed: picture.changed, released: picture.released, routes: NO_DRAFT_ROUTES };
  }
  const fitting = inPlace(edges, held, stand);
  const routesAs = (routes: ReadonlyMap<string, DraftRoute>): DraftRoutes =>
    sameDraftRoutes(held, stand, routes) ? held : { stand, routes };
  if (picture.changed.size === 0 && picture.released.length === 0) {
    return { changed: picture.changed, released: picture.released, routes: routesAs(fitting) };
  }
  const ofDraft = new Set(edges.filter((edge) => draftIdOf(edge) !== null).map((edge) => edge.id));
  const own = routesOf(
    nodes.filter((node) => node.type !== DRAFT_NODE_TYPE),
    edges.filter((edge) => !ofDraft.has(edge.id)),
    { ...options, dragging: false },
  );
  const changed: RoutedDiagram<E>['changed'] = new Map(own.changed);
  for (const [id, route] of picture.changed) if (ofDraft.has(id)) changed.set(id, route);
  const routes = new Map(fitting);
  for (const edge of edges) {
    if (edge.type === 'stub' || ofDraft.has(edge.id)) continue;
    const made = picture.changed.get(edge.id) ?? fitting.get(edge.id);
    const keeps = own.changed.get(edge.id);
    // Drawn along the route the diagram keeps for it, as before.
    if (made === undefined && keeps === undefined) continue;
    const kept = keeps?.points ?? edge.data?.bendPoints;
    // Where the picture made none, it is drawn along the one it kept so far.
    const points = made?.points ?? edge.data?.bendPoints;
    const anchors = made?.anchors ?? (edge.data?.bendAnchors as RouteAnchors | undefined);
    if (
      !Array.isArray(points) ||
      anchors === undefined ||
      (Array.isArray(kept) && sameRoute(points as [number, number][], kept as [number, number][]))
    ) {
      routes.delete(edge.id);
      continue;
    }
    routes.set(edge.id, {
      points: (points as [number, number][]).map(([x, y]): [number, number] => [x, y]),
      anchors,
      from: routeKey(kept),
    });
  }
  return { changed, released: own.released, routes: routesAs(routes) };
}

/**
 * A name for the system `topology` is, as short text: the same for two
 * topologies with the same buses, branches, devices and controllers, each
 * of the same model, between the same buses and on the same bus, whatever
 * their other values. What
 * is kept of a diagram with drafts on it is kept under it, so that the
 * picture of another system does not pass for this one's.
 */
export function systemOf(topology: TopologySummary): string {
  const end = (value: unknown): string => (value === undefined || value === null ? '' : `${value}`);
  const parts: string[] = [];
  const list = (name: string, entries: TopologySummary['buses'] | undefined): void => {
    parts.push(name);
    for (const entry of entries ?? []) {
      const { bus, bus1, bus2 } = entry.params ?? {};
      parts.push(`${entry.idx}:${entry.kind}:${end(bus)}:${end(bus1)}:${end(bus2)}`);
    }
  };
  list('buses', topology.buses);
  list('lines', topology.lines);
  list('transformers', topology.transformers);
  list('generators', topology.generators);
  list('loads', topology.loads);
  list('shunts', topology.shunts);
  list('controllers', topology.controllers);
  const branches = topology.lines.length + topology.transformers.length;
  return `b${topology.buses.length}-l${branches}-${fnv1a32(parts.join('|')).toString(36)}`;
}

/**
 * What a diagram at rest leaves to be kept with its drafts: the ways of
 * `held` that are in place on `edges` (the edges as the diagram keeps them)
 * with the drafts standing as `stand` says, and the route each draft that
 * is drawn as a line or a transformer carries. `null` when there is neither.
 */
export function draftRoutesKept(
  edges: readonly ConnectionEdge[],
  held: DraftRoutes,
  stand: string,
): KeptDraftRoutes | null {
  if (stand === '') return null;
  const own: KeptDraftRoutes['own'] = {};
  for (const edge of edges) {
    if (edge.type === 'stub' || draftIdOf(edge) === null) continue;
    const points = edge.data?.bendPoints;
    const anchors = edge.data?.bendAnchors as RouteAnchors | undefined;
    if (!Array.isArray(points) || anchors === undefined) continue;
    own[edge.id] = keptRoute(points as [number, number][], anchors);
  }
  const round: KeptDraftRoutes['round'] = {};
  for (const [id, way] of inPlace(edges, held, stand)) {
    round[id] = { ...keptRoute(way.points, way.anchors), from: way.from };
  }
  if (Object.keys(own).length === 0 && Object.keys(round).length === 0) return null;
  return { stand, own, round };
}

function keptRoute(
  points: readonly (readonly [number, number])[],
  anchors: RouteAnchors,
): KeptRoute {
  return {
    points: points.map(([x, y]): [number, number] => [x, y]),
    anchors: { source: { ...anchors.source }, target: { ...anchors.target } },
  };
}

/**
 * The ways round the drafts that `kept` holds, as the canvas holds them:
 * `NO_DRAFT_ROUTES` when nothing was kept, or no way among it.
 */
export function draftRoutesFrom(kept: KeptDraftRoutes | undefined): DraftRoutes {
  const ways = Object.entries(kept?.round ?? {});
  if (kept === undefined || ways.length === 0) return NO_DRAFT_ROUTES;
  return { stand: kept.stand, routes: new Map(ways) };
}
