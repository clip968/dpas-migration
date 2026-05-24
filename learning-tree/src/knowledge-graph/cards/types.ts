import type { CardSections, GraphCard } from '../types';
import { evidenceSources } from './evidence';

export type EvidenceKey = keyof typeof evidenceSources;

export type CardDraft = Omit<GraphCard, 'details' | 'sections' | 'sources' | 'sourcePath'> & {
  sourceKeys?: EvidenceKey[];
  sourcePath?: string;
  plain: string;
  why: string;
  context: string;
  confusions?: string[];
  next?: string[];
};
