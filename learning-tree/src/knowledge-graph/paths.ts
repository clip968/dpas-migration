import type { LearningPath } from './types';

export const learningPaths: LearningPath[] = [
  {
    id: 'path-migration-roadmap',
    title: 'Dpas-migration 전체 흐름',
    description: 'Notion index의 Part 1-9를 구현 순서가 아니라 이해 의존성 순서로 훑습니다.',
    cardIds: ['repo-overview', 'part1-build-boot-loop', 'kernel-io-completion-model', 'path-submit-polled', 'step2-req-polled-submission', 'step2-flag-propagation', 'step3-overview', 'step3-queue-mapping-foundation', 'step3-dpas-518-hook-inventory', 'step3-part4-boundary', 'step4-overview', 'step4-state-placement', 'step4-poll-hook-candidates', 'step4-open-questions', 'path-poll-completion', 'part4-minimal-pas', 'concept-dpas-mode', 'risk-interrupt-submission', 'part7-validation'],
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
    id: 'path-step3-queue-hooks',
    title: 'Step 3: queue mapping과 DPAS hook inventory',
    description: '최신 poll queue 구조는 건드리지 않고, DPAS 5.18이 추가한 PAS/full interrupt hook을 category별로 분리합니다.',
    cardIds: ['step3-overview', 'step3-queue-mapping-foundation', 'step3-nvme-poll-queue-map', 'step3-dpas-518-hook-inventory', 'step3-pas-state-duration', 'step3-pas-sleep-update-loop', 'step3-dpas-interrupt-fops-hook', 'step3-part4-boundary'],
  },
  {
    id: 'path-step4-diff-decision',
    title: 'Step 4: diff 분석과 hook/state 결정',
    description: 'Part 4에서 손으로 patch를 쓰기 전에 request_queue state, poll hook 후보, sysfs lifecycle, ctx/hctx map을 한 번에 고정합니다.',
    cardIds: ['step4-overview', 'step4-state-placement', 'step4-poll-hook-candidates', 'step4-sysfs-lifecycle', 'step4-queue-lifecycle', 'step4-request-queue-model', 'step4-hctx-type-init-map', 'step4-open-questions'],
  },
  {
    id: 'path-paper-to-kernel-hook',
    title: '논문을 kernel hook으로 연결',
    description: 'PAS/DPAS 논문 아이디어를 실제 polling 함수 후보로 옮깁니다.',
    cardIds: ['paper-pas-core', 'concept-pas-sleep-before-poll', 'path-poll-completion', 'function-bio-poll', 'function-blk-mq-poll', 'step4-poll-hook-candidates', 'step4-open-questions', 'part4-minimal-pas'],
  },
  {
    id: 'path-migration-minimal-to-full',
    title: 'Minimal PAS에서 full DPAS',
    description: 'PAS-only 이후 mode switching과 interrupt risk를 분리해서 봅니다.',
    cardIds: ['step3-part4-boundary', 'step4-overview', 'step4-state-placement', 'step4-sysfs-lifecycle', 'part4-minimal-pas', 'step3-pas-state-duration', 'step3-pas-sleep-update-loop', 'part5-mode-switching', 'concept-dpas-mode', 'paper-dpas-state-machine', 'step3-dpas-interrupt-fops-hook', 'part6-interrupt-mode', 'risk-interrupt-submission', 'part7-validation'],
  },
  {
    id: 'path-common-misconceptions',
    title: '오해 먼저 제거',
    description: 'Step 1에서 반복해서 헷갈린 지점을 먼저 정리합니다.',
    cardIds: ['concept-bi-cookie-tag', 'mis-submit-vs-poll', 'step2-req-polled-submission', 'step3-queue-mapping-foundation', 'step4-request-queue-model', 'step4-hctx-type-init-map', 'step3-dpas-interrupt-fops-hook', 'step2-dpas-518-comparison', 'mis-cpu-relax-sleep', 'risk-interrupt-submission'],
  },
];
