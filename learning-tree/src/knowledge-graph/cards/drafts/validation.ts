import type { CardDraft } from '../types';
import { communitySlot } from '../layout';
import { part7Visual } from '../visuals';

export const validationCards: CardDraft[] = [
  {
    id: 'part7-validation',
    kind: '사건',
    status: '잠정',
    community: 'validation',
    title: 'Part 7 FIO validation',
    shortTitle: 'FIO validation',
    summary: 'FIO로 latency/CPU/IOPS와 mode breakdown을 검증하는 단계입니다.',
    position: communitySlot('validation', 0, 0),
    sourceKeys: ['notionPart7'],
    visual: part7Visual,
    plain: 'Part 7은 구현이 맞는지 성능과 mode counter로 확인하는 검증 계획입니다.',
    why: 'DPAS는 정책 연구이므로 코드가 동작하는 것만으로는 충분하지 않습니다.',
    context: 'FIO microbenchmark, latency percentile, CPU 사용량, mode counter가 필요합니다.',
  },
];
