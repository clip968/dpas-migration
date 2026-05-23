import { evidenceSources } from './cards';
import type { UpdateCandidate } from './types';

export const updateSnapshot = {
  lastProcessedCommit: {
    hash: 'local-dpas-tree-2026-05-23',
    title: 'DPAS migration learning tree local snapshot',
    date: '2026-05-23',
  },
};

export const updateCandidates: UpdateCandidate[] = [
  {
    id: 'candidate-dpas-518-hook-extraction',
    kind: '신규 후보',
    status: '승인 대기',
    title: 'Linux 5.18 PAS hook extraction',
    summary: '원본 DPAS artifact에서 실제 sleep-before-poll hook 위치와 최소 diff를 카드화해야 합니다.',
    affectedCardIds: ['concept-pas-sleep-before-poll', 'part4-minimal-pas', 'function-blk-mq-poll'],
    sources: [evidenceSources.notionPart4, evidenceSources.localKernel],
  },
  {
    id: 'candidate-part8-part9-stabilization-report',
    kind: '근거 보강',
    status: '보류',
    title: 'Part 8/9 stabilization and report cards',
    summary: '안정화/최종 보고 내용을 kernel-first tree에 붙이는 후속 카드가 필요합니다.',
    affectedCardIds: ['repo-overview', 'part7-validation'],
    sources: [evidenceSources.notionPart7],
  },
  {
    id: 'candidate-visual-ascii-models',
    kind: '수정 후보',
    status: '승인 대기',
    title: 'Step 1 ASCII visual model 강화',
    summary: 'submit 시점과 poll 시점을 한 화면에서 비교하는 visual을 더 강하게 만들 수 있습니다.',
    affectedCardIds: ['path-submit-polled', 'path-poll-completion', 'concept-bi-cookie-tag'],
    sources: [evidenceSources.notionStep1],
  },
];
