import type { CardDraft } from '../types';
import { communitySlot } from '../layout';
import { buildLoopVisual, repoOverviewVisual } from '../visuals';

export const overviewCards: CardDraft[] = [
  {
    id: 'repo-overview',
    kind: 'Repo',
    status: '잠정',
    community: 'overview',
    title: 'DPAS Migration Learning Tree',
    shortTitle: 'DPAS Tree',
    summary: 'DPAS migration을 kernel 용어와 I/O path 중심으로 따라가는 학습 지도입니다.',
    position: communitySlot('overview', 0, 0),
    sourceKeys: ['notionMigrationIndex', 'notionPart1BuildLoop', 'notionStep1', 'notionPart2'],
    visual: repoOverviewVisual,
    plain: '이 트리는 migration Part 순서 자체보다 kernel object와 path를 먼저 잡습니다.',
    why: 'bio/request/hctx/REQ_POLLED를 모르면 PAS hook 위치와 interrupt mode 판단이 흔들립니다.',
    context: 'DPAS_FAST26 Notion Part 1-9와 local kernel source reading을 카드로 연결합니다.',
  },
  {
    id: 'part1-build-boot-loop',
    kind: '현재 작업',
    status: '확정',
    community: 'overview',
    title: 'Part 1 Kernel Build/Boot Loop',
    shortTitle: 'build loop',
    summary: 'DPAS 구현 전에 kernel 수정, 빌드, 로그 확인, 복구 루프를 먼저 닫는 준비 단계입니다.',
    position: communitySlot('overview', 1, 0),
    sourceKeys: ['notionPart1BuildLoop', 'notionMigrationIndex'],
    visual: buildLoopVisual,
    plain: 'Part 1은 DPAS 코드를 아직 이식하지 않고 kernel 작업 루프를 검증하는 단계입니다.',
    why: 'block layer hot path를 건드리기 전에 빌드와 복구 루프가 닫혀 있어야 합니다.',
    context: 'Dpas-migration index의 첫 번째 child page이며 Part 3 코드 리딩 전에 필요한 안전장치입니다.',
  },
];
