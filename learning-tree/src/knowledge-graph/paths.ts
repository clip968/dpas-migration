import type { LearningPath } from './types';

export const learningPaths: LearningPath[] = [
  {
    id: 'path-migration-roadmap',
    title: 'Dpas-migration 전체 흐름',
    description: 'Notion index의 Part 1-9를 구현 순서가 아니라 이해 의존성 순서로 훑습니다.',
    cardIds: ['repo-overview', 'part1-build-boot-loop', 'kernel-io-completion-model', 'path-submit-polled', 'step2-req-polled-submission', 'step2-flag-propagation', 'path-poll-completion', 'part4-minimal-pas', 'concept-dpas-mode', 'risk-interrupt-submission', 'part7-validation'],
  },
  {
    id: 'path-kernel-first',
    title: 'Kernel 용어부터 이해하기',
    description: 'DPAS migration을 바로 보지 않고 bio/request/hctx/REQ_POLLED/cookie부터 잡습니다.',
    cardIds: ['repo-overview', 'part1-build-boot-loop', 'kernel-io-completion-model', 'concept-blk-mq', 'concept-ctx', 'concept-bio', 'concept-request', 'concept-hctx', 'concept-mq-ops', 'concept-req-polled', 'concept-bi-cookie-tag'],
  },
  {
    id: 'path-step1-polled-io',
    title: 'Step 1: polled I/O 경로',
    description: 'submit 때 cookie가 생기고 poll 때 hctx를 다시 찾는 흐름을 따라갑니다.',
    cardIds: ['path-submit-polled', 'function-blk-mq-start-request', 'concept-bi-cookie-tag', 'path-io-uring-iopoll', 'step2-req-polled-submission', 'step2-kiocb-hipri', 'step2-flag-propagation', 'path-poll-completion', 'path-interrupt-completion', 'function-bio-poll', 'function-blk-mq-poll', 'function-blk-hctx-poll', 'function-nvme-poll'],
  },
  {
    id: 'path-step2-submission-control',
    title: 'Step 2: REQ_POLLED submission 제어',
    description: 'RWF_HIPRI/IOCB_HIPRI가 REQ_POLLED request로 바뀌는 순간과 interrupt mode hook 후보를 봅니다.',
    cardIds: ['path-io-uring-iopoll', 'step2-req-polled-submission', 'step2-kiocb-hipri', 'step2-flag-propagation', 'concept-req-polled', 'function-blk-mq-start-request', 'concept-bi-cookie-tag', 'step2-dpas-518-comparison', 'step2-hook-candidates', 'risk-interrupt-submission', 'part6-interrupt-mode'],
  },
  {
    id: 'path-paper-to-kernel-hook',
    title: '논문을 kernel hook으로 연결',
    description: 'PAS/DPAS 논문 아이디어를 실제 polling 함수 후보로 옮깁니다.',
    cardIds: ['paper-pas-core', 'concept-pas-sleep-before-poll', 'path-poll-completion', 'function-bio-poll', 'function-blk-mq-poll', 'part4-minimal-pas'],
  },
  {
    id: 'path-migration-minimal-to-full',
    title: 'Minimal PAS에서 full DPAS',
    description: 'PAS-only 이후 mode switching과 interrupt risk를 분리해서 봅니다.',
    cardIds: ['part4-minimal-pas', 'part5-mode-switching', 'concept-dpas-mode', 'paper-dpas-state-machine', 'part6-interrupt-mode', 'risk-interrupt-submission', 'part7-validation'],
  },
  {
    id: 'path-common-misconceptions',
    title: '오해 먼저 제거',
    description: 'Step 1에서 반복해서 헷갈린 지점을 먼저 정리합니다.',
    cardIds: ['concept-bi-cookie-tag', 'mis-submit-vs-poll', 'step2-req-polled-submission', 'step2-dpas-518-comparison', 'mis-cpu-relax-sleep', 'risk-interrupt-submission'],
  },
];
