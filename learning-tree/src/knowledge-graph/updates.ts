import { evidenceSources } from './cards';
import type { UpdateCandidate } from './types';

export const updateSnapshot = {
  lastProcessedCommit: {
    hash: 'local-dpas-tree-2026-06-17-history-sync',
    title: 'DPAS migration learning tree history sync',
    date: '2026-06-17',
  },
};

export const updateCandidates: UpdateCandidate[] = [
  {
    id: 'candidate-runtime-boot-and-sysfs-validation',
    kind: '근거 보강',
    status: '승인 대기',
    title: 'VM boot and runtime sysfs validation',
    summary: 'bzImage build 이후 새 kernel을 VM에 올려 boot, switch_enabled, DPAS sysfs runtime 동작을 카드화해야 합니다.',
    affectedCardIds: ['validation-colima-build-loop', 'step4-open-questions', 'dpas-71-mode-switching-direct-fields'],
    sources: [evidenceSources.history20260617, evidenceSources.localKernel],
  },
  {
    id: 'candidate-hipri-runtime-mode-evidence',
    kind: '신규 후보',
    status: '승인 대기',
    title: 'HIPRI runtime mode evidence',
    summary: 'raw block과 filesystem DIO에서 blk_dpas_prepare_bio(), PAS sleep, mode switching counter가 실제로 타는지 trace/counter 근거가 필요합니다.',
    affectedCardIds: ['dpas-71-submit-helper', 'validation-full-mode-static-test', 'part7-validation'],
    sources: [evidenceSources.history20260615, evidenceSources.localKernel],
  },
  {
    id: 'candidate-part8-part9-stabilization-report',
    kind: '근거 보강',
    status: '보류',
    title: 'Part 8/9 stabilization and report cards',
    summary: 'runtime 검증과 회귀 테스트가 정리된 뒤 안정화/최종 보고 내용을 validation community에 붙입니다.',
    affectedCardIds: ['repo-overview', 'part7-validation', 'step4-open-questions'],
    sources: [evidenceSources.notionPart7, evidenceSources.history20260617],
  },
];
