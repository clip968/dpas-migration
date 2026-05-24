export type CardKind = 'Repo' | '모듈' | '현재 작업' | '개념' | '사건' | '오해' | '미해결';
export type CardStatus = '확정' | '잠정' | '철회' | '검증 필요' | '충돌 있음' | '오래됨' | '대체됨';

export interface EvidenceSource {
  id: string;
  label: string;
  path: string;
  commitHash: string;
  commitDate: string;
  commitTitle: string;
  note: string;
}

export interface CardSections {
  plainExplanation: string;
  whyItMatters: string;
  repoContext: string;
  commonConfusions: string[];
  nextSteps: string[];
}

export type VisualTone = 'blue' | 'teal' | 'amber' | 'rose' | 'violet' | 'slate';

export type CommunityId =
  | 'overview'
  | 'foundation'
  | 'step1-polling'
  | 'step2-submission'
  | 'step3-queue-hooks'
  | 'dpas-policy'
  | 'misconceptions'
  | 'validation';

export interface GraphCommunity {
  id: CommunityId;
  title: string;
  shortTitle: string;
  description: string;
  tone: VisualTone;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

export interface VisualFlowStep {
  title: string;
  description: string;
  tone: VisualTone;
}

export interface VisualSlot {
  label: string;
  description: string;
  tone: VisualTone;
}

export interface VisualSlotGroup {
  title: string;
  description: string;
  slots: VisualSlot[];
}

export interface VisualMetricRow {
  label: string;
  cells: string[];
  tone?: VisualTone;
}

export interface VisualMetricTable {
  title: string;
  description?: string;
  columns: string[];
  rows: VisualMetricRow[];
}

export interface VisualAsciiArt {
  title: string;
  art: string;
  caption?: string;
}

export interface VisualMermaid {
  title: string;
  description?: string;
  code: string;
}

export type VisualTimelineState = 'busy' | 'sleep' | 'idle' | 'check' | 'submit' | 'done';

export interface VisualTimelineSegment {
  label: string;
  duration: string;
  state: VisualTimelineState;
  description?: string;
}

export interface VisualTimelineRow {
  label: string;
  description?: string;
  segments: VisualTimelineSegment[];
}

export interface VisualTimeline {
  title: string;
  description?: string;
  rows: VisualTimelineRow[];
  legend?: Array<{ state: VisualTimelineState; label: string }>;
}

export interface VisualComparisonRow {
  label: string;
  left: string;
  right: string;
  tone?: VisualTone;
}

export interface VisualComparison {
  title: string;
  description?: string;
  leftLabel: string;
  rightLabel: string;
  leftTone?: VisualTone;
  rightTone?: VisualTone;
  rows: VisualComparisonRow[];
}

export interface VisualModel {
  title: string;
  description: string;
  flowSteps?: VisualFlowStep[];
  slotGroups?: VisualSlotGroup[];
  metricTable?: VisualMetricTable;
  asciiArts?: VisualAsciiArt[];
  mermaid?: VisualMermaid;
  timeline?: VisualTimeline;
  comparison?: VisualComparison;
  notes: string[];
}

export interface GraphCard {
  id: string;
  kind: CardKind;
  status: CardStatus;
  community: CommunityId;
  title: string;
  shortTitle: string;
  summary: string;
  details: string[];
  sections: CardSections;
  visual?: VisualModel;
  sourcePath: string;
  sources: EvidenceSource[];
  position: { x: number; y: number };
}

export type EdgeKind =
  | '이해 필요'
  | '코드 흐름'
  | '논문 대응'
  | '마이그레이션'
  | '검증 근거'
  | '오해 방지'
  | '리스크'
  | '미해결'
  | '원인'
  | '증거'
  | '정정';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: EdgeKind;
}

export interface CardRelation {
  edge: GraphEdge;
  otherCard: GraphCard;
  direction: 'outgoing' | 'incoming';
  label: string;
}

export type FocusDepth = 1 | 2 | 'all';

export interface FocusGraphOptions {
  depth: FocusDepth;
  edgeKinds: EdgeKind[];
}

export interface LearningPath {
  id: string;
  title: string;
  description: string;
  cardIds: string[];
}

export type UpdateCandidateKind = '신규 후보' | '수정 후보' | '충돌 후보' | '근거 보강';
export type UpdateCandidateStatus = '승인 대기' | '보류' | '반려';

export interface UpdateCandidate {
  id: string;
  kind: UpdateCandidateKind;
  status: UpdateCandidateStatus;
  title: string;
  summary: string;
  affectedCardIds: string[];
  sources: EvidenceSource[];
}
