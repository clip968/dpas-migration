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

  it('includes the current code-change learning cards from the history log', () => {
    const cardIds = new Set(graphCards.map((card) => card.id));

    for (const cardId of [
      'dpas-71-submit-helper',
      'dpas-71-mode-switching-direct-fields',
      'validation-full-mode-static-test',
      'validation-optane-knob-reset',
      'validation-colima-build-loop',
    ]) {
      expect(cardIds.has(cardId), `${cardId} exists`).toBe(true);
    }
  });

  it('does not keep the superseded q->dpas pointer plan as the Step 4 state story', () => {
    const step4Cards = graphCards.filter((card) => card.community === 'step4-diff-decision');
    const step4Text = step4Cards
      .flatMap((card) => [
        card.title,
        card.summary,
        ...card.details,
        ...card.sections.commonConfusions,
        ...card.sections.nextSteps,
      ])
      .join('\n');

    expect(step4Text).not.toContain('q->dpas');
    expect(step4Text).not.toContain('struct dpas_queue');
  });

  it('keeps handwritten ASCII diagrams visible in rendered card sections', () => {
    const interruptRisk = graphCards.find((card) => card.id === 'risk-interrupt-submission');

    expect(interruptRisk?.sections.visual.body).toContain('이미 poll 전용 queue로 들어감');
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

  it('keeps every card in the learning-tree card-writer schema', () => {
    for (const card of graphCards) {
      const sections = card.sections as Record<string, unknown>;
      const visual = sections.visual as { kind?: unknown; body?: unknown; caption?: unknown } | undefined;
      const model = sections.inputTransformOutput as { input?: unknown; transform?: unknown; output?: unknown } | undefined;

      for (const key of ['oneLineConclusion', 'keyQuestion', 'plainExplanation', 'workedExample', 'whyItMatters']) {
        expect(typeof sections[key], `${card.id} ${key}`).toBe('string');
        expect((sections[key] as string).trim().length, `${card.id} ${key}`).toBeGreaterThan(0);
      }

      expect((sections.keyQuestion as string).match(/\?/g)?.length, `${card.id} keyQuestion`).toBe(1);
      expect(sections.prerequisites, `${card.id} prerequisites`).toEqual(expect.any(Array));
      expect((sections.prerequisites as unknown[]).length, `${card.id} prerequisites length`).toBeLessThanOrEqual(3);

      expect(model, `${card.id} inputTransformOutput`).toBeDefined();
      expect(typeof model?.input, `${card.id} input`).toBe('string');
      expect(typeof model?.transform, `${card.id} transform`).toBe('string');
      expect(typeof model?.output, `${card.id} output`).toBe('string');

      expect(visual, `${card.id} visual`).toBeDefined();
      expect(['mermaid', 'ascii', 'table']).toContain(visual?.kind);
      expect(typeof visual?.body, `${card.id} visual body`).toBe('string');
      expect((visual?.body as string).trim().length, `${card.id} visual body`).toBeGreaterThan(0);
      expect(visual?.caption, `${card.id} visual caption`).toMatch(/^이 그림에서 봐야 할 것:/);

      for (const key of ['commonConfusions', 'codeEvidence', 'checkQuestions', 'nextSteps', 'sources']) {
        expect(sections[key], `${card.id} ${key}`).toEqual(expect.any(Array));
        expect((sections[key] as unknown[]).length, `${card.id} ${key} length`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps the core model vertical instead of using a wide diagram', () => {
    for (const card of graphCards) {
      const { inputTransformOutput, visual } = card.sections;
      const duplicatedInternalModel = [
        '[입력]',
        inputTransformOutput.input,
        '  -- maps -->',
        '[변환]',
        inputTransformOutput.transform,
        '  -- produces -->',
        '[출력]',
        inputTransformOutput.output,
      ].join('\n');

      expect(visual.kind, `${card.id} visual kind`).toBe('ascii');
      expect(visual.body, `${card.id} visual is vertical`).toContain('\n');
      expect(visual.body, `${card.id} visual is not duplicated inputTransformOutput`).not.toBe(duplicatedInternalModel);
      expect(visual.body, `${card.id} visual avoids mechanical arrow prose`).not.toMatch(/-- .* -->/);
    }
  });
});
