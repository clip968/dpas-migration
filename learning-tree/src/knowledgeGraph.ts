export type {
  CardKind,
  CardStatus,
  EvidenceSource,
  CardSections,
  VisualTone,
  VisualFlowStep,
  VisualSlot,
  VisualSlotGroup,
  VisualMetricRow,
  VisualMetricTable,
  VisualModel,
  GraphCard,
  EdgeKind,
  GraphEdge,
  CardRelation,
  FocusDepth,
  FocusGraphOptions,
  LearningPath,
  UpdateCandidateKind,
  UpdateCandidateStatus,
  UpdateCandidate,
} from './knowledge-graph/types';

export { cardContentTemplate, evidenceSources, graphCards } from './knowledge-graph/cards';
export { edgeKindLabels, defaultEdgeKinds } from './knowledge-graph/labels';
export { updateSnapshot, updateCandidates } from './knowledge-graph/updates';
export { learningPaths } from './knowledge-graph/paths';
export { graphEdges } from './knowledge-graph/edges';
export { getRelatedCards, getCardRelations, getFocusGraph } from './knowledge-graph/selectors';
