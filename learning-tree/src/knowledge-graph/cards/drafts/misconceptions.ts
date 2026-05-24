import type { CardDraft } from '../types';
import { communitySlot } from '../layout';
import { misCpuRelaxVisual, misSubmitPollVisual } from '../visuals';

export const misconceptionCards: CardDraft[] = [
  {
    id: 'mis-submit-vs-poll',
    kind: '오해',
    status: '확정',
    community: 'misconceptions',
    title: 'submit path와 poll path를 섞으면 안 된다',
    shortTitle: 'submit != poll',
    summary: 'cookie는 submit에서 생기고 poll에서 소비됩니다.',
    position: communitySlot('misconceptions', 0, 0),
    sourceKeys: ['notionStep1'],
    visual: misSubmitPollVisual,
    plain: 'submit 시점은 I/O를 내보내는 시점이고, poll 시점은 완료를 확인하는 시점입니다.',
    why: '두 경로를 섞으면 bi_cookie 생성 위치를 잘못 잡습니다.',
    context: 'Step 1 대화에서 submit 시점 질문을 통해 분리한 개념입니다.',
  },
  {
    id: 'mis-cpu-relax-sleep',
    kind: '오해',
    status: '확정',
    community: 'misconceptions',
    title: 'cpu_relax()는 PAS sleep이 아니다',
    shortTitle: 'relax != sleep',
    summary: 'cpu_relax()는 busy loop hint이지 PAS의 sleep-before-poll이 아닙니다.',
    position: communitySlot('misconceptions', 1, 0),
    sourceKeys: ['notionStep1'],
    visual: misCpuRelaxVisual,
    plain: 'cpu_relax()는 CPU busy-wait loop에서 쓰는 hint입니다.',
    why: 'PAS hook을 cpu_relax와 동일시하면 DPAS 논문 아이디어를 잘못 구현합니다.',
    context: 'blk_hctx_poll() 해석에서 반드시 분리해야 하는 오해입니다.',
  },
];
