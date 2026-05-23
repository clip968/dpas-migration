import type { EdgeKind } from './types';

export const edgeKindLabels: Array<{ id: EdgeKind; label: string; description: string }> = [
  { id: '이해 필요', label: '이해 필요', description: '다음 개념을 이해해야 현재 카드를 제대로 읽을 수 있음' },
  { id: '코드 흐름', label: '코드 흐름', description: '실제 kernel function/path 흐름' },
  { id: '논문 대응', label: '논문 대응', description: 'DPAS 논문 figure/idea와 kernel 위치의 대응' },
  { id: '마이그레이션', label: '마이그레이션', description: '포팅 단계와 구현 후보 연결' },
  { id: '검증 근거', label: '검증 근거', description: 'FIO, counter, trace로 확인해야 하는 관계' },
  { id: '오해 방지', label: '오해 방지', description: '자주 틀리는 해석을 막기 위한 관계' },
  { id: '리스크', label: '리스크', description: '구현 판단을 잘못하면 깨질 수 있는 부분' },
  { id: '미해결', label: '미해결', description: '아직 결정되지 않은 hook/검증 후보' },
  { id: '원인', label: '원인', description: '문제의 원인 관계' },
  { id: '증거', label: '증거', description: '근거 자료 관계' },
  { id: '정정', label: '정정', description: '이전 오해를 바로잡는 관계' },
];

export const defaultEdgeKinds: EdgeKind[] = ['이해 필요', '코드 흐름', '오해 방지', '미해결'];
