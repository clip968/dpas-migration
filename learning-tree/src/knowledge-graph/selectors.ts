import { graphCards } from './cards';
import { graphEdges } from './edges';
import type { CardRelation, FocusGraphOptions, GraphCard } from './types';

export function getRelatedCards(cardId: string): GraphCard[] {
  const relatedIds = new Set(
    graphEdges
      .filter((edge) => edge.source === cardId || edge.target === cardId)
      .map((edge) => (edge.source === cardId ? edge.target : edge.source)),
  );

  return graphCards.filter((card) => relatedIds.has(card.id));
}

export function getCardRelations(cardId: string): CardRelation[] {
  return graphEdges
    .filter((edge) => edge.source === cardId || edge.target === cardId)
    .map((edge) => {
      const direction = edge.source === cardId ? 'outgoing' : 'incoming';
      const otherId = direction === 'outgoing' ? edge.target : edge.source;
      const otherCard = graphCards.find((card) => card.id === otherId);

      if (!otherCard) return null;

      return {
        edge,
        otherCard,
        direction,
        label: `${edge.kind}: ${edge.label}`,
      } satisfies CardRelation;
    })
    .filter((relation): relation is CardRelation => relation !== null);
}

export function getFocusGraph(selectedId: string, options: FocusGraphOptions) {
  const allowedEdges = graphEdges.filter((edge) => options.edgeKinds.includes(edge.kind));

  if (options.depth === 'all') {
    return { cards: graphCards, edges: allowedEdges };
  }

  const visited = new Set([selectedId]);
  let frontier = new Set([selectedId]);

  for (let depth = 0; depth < options.depth; depth += 1) {
    const nextFrontier = new Set<string>();

    for (const edge of allowedEdges) {
      if (frontier.has(edge.source) && !visited.has(edge.target)) nextFrontier.add(edge.target);
      if (frontier.has(edge.target) && !visited.has(edge.source)) nextFrontier.add(edge.source);
    }

    for (const id of nextFrontier) visited.add(id);
    frontier = nextFrontier;
  }

  return {
    cards: graphCards.filter((card) => visited.has(card.id)),
    edges: allowedEdges.filter((edge) => visited.has(edge.source) && visited.has(edge.target)),
  };
}
