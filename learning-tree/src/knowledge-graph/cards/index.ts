import type { GraphCard } from '../types';
import { evidenceSources } from './evidence';
import { expandedSections, sections } from './sections';
import type { CardDraft } from './types';
import {
  dpasPolicyCards,
  foundationCards,
  misconceptionCards,
  overviewCards,
  step1PollingCards,
  step2SubmissionCards,
  step3QueueHookCards,
  validationCards,
} from './drafts';

export { cardContentTemplate } from './template';
export { evidenceSources } from './evidence';
export { graphCommunities } from './layout';

export const draftCards: CardDraft[] = [
  ...overviewCards,
  ...foundationCards,
  ...step2SubmissionCards,
  ...step3QueueHookCards,
  ...step1PollingCards,
  ...dpasPolicyCards,
  ...misconceptionCards,
  ...validationCards,
];

export const graphCards: GraphCard[] = draftCards.map((card) => {
  const sources = (card.sourceKeys ?? ['notionStep1']).map((key) => evidenceSources[key]);
  const expanded = expandedSections[card.id];
  const commonConfusions = expanded?.commonConfusions ?? card.confusions ?? [
    'migration Part 번호만 따라가면 kernel 객체 관계를 놓치기 쉽습니다.',
    '논문 용어와 kernel 함수 이름은 1:1로 바로 대응되지 않습니다.',
  ];
  const nextSteps = expanded?.nextSteps ?? card.next ?? ['연결된 코드 흐름 카드를 확인합니다.', '관련 Notion Part와 local kernel source를 대조합니다.'];
  const cardSections = expanded ?? sections(card.plain, card.why, card.context, commonConfusions, nextSteps);

  return {
    id: card.id,
    kind: card.kind,
    status: card.status,
    community: card.community,
    title: card.title,
    shortTitle: card.shortTitle,
    summary: card.summary,
    details: [cardSections.plainExplanation, cardSections.whyItMatters, cardSections.repoContext],
    sections: cardSections,
    visual: card.visual,
    sourcePath: card.sourcePath ?? `src/knowledge-graph/cards/drafts/${card.community}.ts#${card.id}`,
    sources,
    position: card.position,
  };
});
