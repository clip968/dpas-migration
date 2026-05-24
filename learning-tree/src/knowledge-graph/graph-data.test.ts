import { describe, expect, it } from 'vitest';
import { graphCards, graphCommunities } from './cards';
import { graphEdges } from './edges';
import { learningPaths } from './paths';

const CARD_WIDTH = 240;
const CARD_HEIGHT = 180;

describe('knowledge graph data', () => {
  it('keeps card ids unique', () => {
    const ids = graphCards.map((card) => card.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every edge connected to existing cards', () => {
    const cardIds = new Set(graphCards.map((card) => card.id));

    for (const edge of graphEdges) {
      expect(cardIds.has(edge.source), `${edge.id} source ${edge.source}`).toBe(true);
      expect(cardIds.has(edge.target), `${edge.id} target ${edge.target}`).toBe(true);
    }
  });

  it('keeps learning paths connected to existing cards', () => {
    const cardIds = new Set(graphCards.map((card) => card.id));

    for (const path of learningPaths) {
      for (const cardId of path.cardIds) {
        expect(cardIds.has(cardId), `${path.id} card ${cardId}`).toBe(true);
      }
    }
  });

  it('places every card inside its declared community box', () => {
    const communities = new Map(graphCommunities.map((community) => [community.id, community]));

    for (const card of graphCards) {
      const community = communities.get(card.community);

      expect(community, `${card.id} community ${card.community}`).toBeDefined();
      if (!community) continue;

      expect(card.position.x, `${card.id} x`).toBeGreaterThanOrEqual(community.position.x);
      expect(card.position.y, `${card.id} y`).toBeGreaterThanOrEqual(community.position.y);
      expect(card.position.x + CARD_WIDTH, `${card.id} width`).toBeLessThanOrEqual(community.position.x + community.size.width);
      expect(card.position.y + CARD_HEIGHT, `${card.id} height`).toBeLessThanOrEqual(community.position.y + community.size.height);
    }
  });
});
