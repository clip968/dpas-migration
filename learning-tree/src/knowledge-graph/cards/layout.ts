import type { CommunityId, GraphCommunity } from '../types';

const CARD_WIDTH = 240;
const CARD_HEIGHT = 180;
const LAYOUT_COL = 300;
const LAYOUT_ROW = 220;
const COMMUNITY_PAD_X = 48;
const COMMUNITY_PAD_TOP = 76;
const COMMUNITY_PAD_BOTTOM = 42;

type CommunityLayout = Omit<GraphCommunity, 'size'> & {
  columns: number;
  rows: number;
};

const communityLayouts: CommunityLayout[] = [
  {
    id: 'overview',
    title: 'Overview / Build Loop',
    shortTitle: 'Overview',
    description: '학습 트리의 입구와 kernel 작업 안전 루프입니다.',
    tone: 'blue',
    position: { x: -520, y: -260 },
    columns: 2,
    rows: 1,
  },
  {
    id: 'foundation',
    title: 'Foundation: kernel I/O objects',
    shortTitle: 'Foundation',
    description: 'bio, request, ctx, hctx, mq_ops, REQ_POLLED의 기본 관계입니다.',
    tone: 'slate',
    position: { x: -1700, y: 170 },
    columns: 5,
    rows: 2,
  },
  {
    id: 'step2-submission',
    title: 'Step 2: submission-side poll request creation',
    shortTitle: 'Step 2',
    description: 'RWF_HIPRI에서 REQ_POLLED, HCTX_TYPE_POLL, hook 후보까지 이어지는 흐름입니다.',
    tone: 'teal',
    position: { x: 80, y: 170 },
    columns: 3,
    rows: 2,
  },
  {
    id: 'step3-queue-hooks',
    title: 'Step 3: queue mapping and DPAS 5.18 hooks',
    shortTitle: 'Step 3',
    description: '최신 poll queue foundation과 DPAS 5.18 PAS/full interrupt hook을 분리합니다.',
    tone: 'rose',
    position: { x: 1180, y: 40 },
    columns: 4,
    rows: 3,
  },
  {
    id: 'step4-diff-decision',
    title: 'Step 4: diff, state, and hook decision',
    shortTitle: 'Step 4',
    description: '최신 kernel에 DPAS를 옮기기 전 state 위치, poll hook, sysfs lifecycle을 결정합니다.',
    tone: 'amber',
    position: { x: -3020, y: 170 },
    columns: 4,
    rows: 2,
  },
  {
    id: 'step1-polling',
    title: 'Step 1: completion polling path',
    shortTitle: 'Step 1',
    description: 'bio_poll에서 blk_mq_poll, blk_hctx_poll, nvme_poll로 내려가는 완료 확인 경로입니다.',
    tone: 'amber',
    position: { x: -1700, y: 850 },
    columns: 5,
    rows: 2,
  },
  {
    id: 'dpas-policy',
    title: 'DPAS policy / migration milestones',
    shortTitle: 'DPAS Policy',
    description: 'PAS, DPAS mode switching, interrupt mode와 Part 4-6 구현 판단을 묶습니다.',
    tone: 'violet',
    position: { x: 80, y: 850 },
    columns: 5,
    rows: 2,
  },
  {
    id: 'misconceptions',
    title: 'Common misconceptions',
    shortTitle: 'Misreads',
    description: 'submit/poll 혼동, cpu_relax와 PAS sleep 혼동 같은 반복 오해를 모읍니다.',
    tone: 'rose',
    position: { x: -1700, y: 1530 },
    columns: 2,
    rows: 1,
  },
  {
    id: 'validation',
    title: 'Validation and reporting',
    shortTitle: 'Validation',
    description: 'FIO microbenchmark와 이후 regression/final report 증거를 담는 공간입니다.',
    tone: 'blue',
    position: { x: 80, y: 1530 },
    columns: 3,
    rows: 2,
  },
];

function communitySize(layout: CommunityLayout): GraphCommunity['size'] {
  return {
    width: COMMUNITY_PAD_X * 2 + (layout.columns - 1) * LAYOUT_COL + CARD_WIDTH,
    height: COMMUNITY_PAD_TOP + (layout.rows - 1) * LAYOUT_ROW + CARD_HEIGHT + COMMUNITY_PAD_BOTTOM,
  };
}

export const graphCommunities: GraphCommunity[] = communityLayouts.map((layout) => ({
  id: layout.id,
  title: layout.title,
  shortTitle: layout.shortTitle,
  description: layout.description,
  tone: layout.tone,
  position: layout.position,
  size: communitySize(layout),
}));

export function communitySlot(communityId: CommunityId, col: number, row: number): { x: number; y: number } {
  const community = communityLayouts.find((layout) => layout.id === communityId);

  if (!community) {
    throw new Error(`Unknown graph community: ${communityId}`);
  }

  return {
    x: community.position.x + COMMUNITY_PAD_X + col * LAYOUT_COL,
    y: community.position.y + COMMUNITY_PAD_TOP + row * LAYOUT_ROW,
  };
}
