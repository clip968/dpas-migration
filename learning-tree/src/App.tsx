import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  NodeProps,
  Position,
  ReactFlow,
  type Edge,
  type FitViewOptions,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import { AnimatePresence, motion } from 'framer-motion';
import mermaid from 'mermaid';
import { AlertTriangle, BookOpen, CheckCircle2, CircleHelp, Crosshair, Filter, GitCommit, GitBranch, Inbox, Route, Target, X } from 'lucide-react';
import {
  defaultEdgeKinds,
  edgeKindLabels,
  getCardRelations,
  getFocusGraph,
  graphCards,
  graphCommunities,
  learningPaths,
  getRelatedCards,
  type EdgeKind,
  type EvidenceSource,
  type FocusDepth,
  type GraphCard,
  type GraphCommunity,
  type GraphEdge as KnowledgeGraphEdge,
  type VisualModel,
  updateCandidates,
  updateSnapshot,
} from './knowledgeGraph';

type KnowledgeNodeData = {
  card: GraphCard;
  selected: boolean;
  related: boolean;
};

type CommunityNodeData = {
  community: GraphCommunity;
  visibleCount: number;
};

const treeFitViewOptions: FitViewOptions = {
  includeHiddenNodes: false,
  maxZoom: 0.95,
  minZoom: 0.35,
  padding: 0.18,
};

const kindConfig = {
  Repo: { className: 'kind-repo', icon: Target },
  모듈: { className: 'kind-module', icon: GitBranch },
  '현재 작업': { className: 'kind-current', icon: Target },
  개념: { className: 'kind-concept', icon: BookOpen },
  사건: { className: 'kind-event', icon: GitBranch },
  오해: { className: 'kind-misconception', icon: AlertTriangle },
  미해결: { className: 'kind-gap', icon: CircleHelp },
} satisfies Record<GraphCard['kind'], { className: string; icon: typeof Target }>;

const edgeKindClass: Record<EdgeKind, string> = {
  '이해 필요': 'edge-required',
  '코드 흐름': 'edge-flow',
  '논문 대응': 'edge-paper',
  마이그레이션: 'edge-migration',
  '검증 근거': 'edge-evidence',
  '오해 방지': 'edge-guard',
  리스크: 'edge-risk',
  미해결: 'edge-open',
  원인: 'edge-cause',
  증거: 'edge-evidence',
  정정: 'edge-correction',
};

const edgeKindColor: Record<EdgeKind, string> = {
  '이해 필요': '#1b365d',
  '코드 흐름': '#0f766e',
  '논문 대응': '#6842a0',
  마이그레이션: '#b7791f',
  '검증 근거': '#2d5a8a',
  '오해 방지': '#b42318',
  리스크: '#b42318',
  미해결: '#746f64',
  원인: '#9a6420',
  증거: '#2d5a8a',
  정정: '#0f766e',
};

function KnowledgeNode({ data }: NodeProps<Node<KnowledgeNodeData>>) {
  const { card, selected, related } = data;
  const config = kindConfig[card.kind];
  const Icon = config.icon;

  return (
    <motion.div
      className={['graph-node', config.className, selected ? 'is-selected' : '', related ? 'is-related' : ''].join(' ')}
      initial={false}
      animate={{ scale: selected ? 1.045 : 1, opacity: related || selected ? 1 : 0.78 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <Handle id="target-top" type="target" position={Position.Top} />
      <Handle id="target-right" type="target" position={Position.Right} />
      <Handle id="target-bottom" type="target" position={Position.Bottom} />
      <Handle id="target-left" type="target" position={Position.Left} />
      <div className="node-topline">
        <span className="node-kind">
          <Icon size={14} />
          {card.kind}
        </span>
        <span className="node-status">{card.status}</span>
      </div>
      <strong>{card.shortTitle}</strong>
      <p>{card.summary}</p>
      <Handle id="source-top" type="source" position={Position.Top} />
      <Handle id="source-right" type="source" position={Position.Right} />
      <Handle id="source-bottom" type="source" position={Position.Bottom} />
      <Handle id="source-left" type="source" position={Position.Left} />
    </motion.div>
  );
}

function CommunityNode({ data }: NodeProps<Node<CommunityNodeData>>) {
  const { community, visibleCount } = data;

  return (
    <div className={['community-node', `community-${community.tone}`].join(' ')}>
      <div className="community-heading">
        <strong>{community.title}</strong>
        <span>{visibleCount} cards</span>
      </div>
      <p>{community.description}</p>
    </div>
  );
}

const nodeTypes = { knowledge: KnowledgeNode, community: CommunityNode };

function buildNodes(cards: GraphCard[], selectedId: string): Node[] {
  const relatedIds = new Set(getRelatedCards(selectedId).map((card) => card.id));
  const visibleCommunityIds = new Set(cards.map((card) => card.community));
  const communityNodes: Node<CommunityNodeData>[] = graphCommunities
    .filter((community) => visibleCommunityIds.has(community.id))
    .map((community) => ({
      id: `community-${community.id}`,
      type: 'community',
      position: community.position,
      data: {
        community,
        visibleCount: cards.filter((card) => card.community === community.id).length,
      },
      draggable: false,
      selectable: false,
      zIndex: -1,
      style: {
        width: community.size.width,
        height: community.size.height,
      },
    }));

  const cardNodes: Node<KnowledgeNodeData>[] = cards.map((card) => ({
    id: card.id,
    type: 'knowledge',
    position: card.position,
    data: {
      card,
      selected: card.id === selectedId,
      related: relatedIds.has(card.id),
    },
  }));

  return [...communityNodes, ...cardNodes];
}

function buildEdges(edges: KnowledgeGraphEdge[], selectedId: string): Edge[] {
  return edges.map((edge) => {
    const active = edge.source === selectedId || edge.target === selectedId;
    const sourceCard = graphCards.find((card) => card.id === edge.source);
    const targetCard = graphCards.find((card) => card.id === edge.target);
    const dx = (targetCard?.position.x ?? 0) - (sourceCard?.position.x ?? 0);
    const dy = (targetCard?.position.y ?? 0) - (sourceCard?.position.y ?? 0);
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const sourceHandle = horizontal
      ? dx >= 0 ? 'source-right' : 'source-left'
      : dy >= 0 ? 'source-bottom' : 'source-top';
    const targetHandle = horizontal
      ? dx >= 0 ? 'target-left' : 'target-right'
      : dy >= 0 ? 'target-top' : 'target-bottom';

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle,
      targetHandle,
      type: 'smoothstep',
      animated: active,
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeKindColor[edge.kind] },
      className: [active ? 'edge-active' : 'edge-muted', edgeKindClass[edge.kind]].join(' '),
      style: {
        stroke: edgeKindColor[edge.kind],
        strokeWidth: active ? 2.8 : 2.1,
      },
    };
  });
}

function statusIcon(status: GraphCard['status']) {
  if (status === '확정') return <CheckCircle2 size={16} />;
  if (status === '검증 필요') return <CircleHelp size={16} />;
  if (status === '철회' || status === '충돌 있음' || status === '오래됨') return <AlertTriangle size={16} />;
  return <GitBranch size={16} />;
}

function shortHash(hash: string) {
  return hash.slice(0, 12);
}

function SourceList({ sources }: { sources: EvidenceSource[] }) {
  return (
    <div className="source-list">
      {sources.map((source) => (
        <div className="source-item" key={source.id}>
          <div className="source-head">
            <span>
              <GitCommit size={14} />
              {shortHash(source.commitHash)}
            </span>
            <time>{source.commitDate}</time>
          </div>
          <strong>{source.label}</strong>
          <p>{source.note}</p>
          <code>{source.path}</code>
        </div>
      ))}
    </div>
  );
}

mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  fontFamily: '"Noto Serif KR", "Noto Serif CJK KR", "Source Han Serif KR", "Nanum Myeongjo", Georgia, serif',
  flowchart: {
    curve: 'basis',
    htmlLabels: true,
    nodeSpacing: 28,
    rankSpacing: 44,
    padding: 16,
  },
  themeVariables: {
    background: '#f5f4ed',
    mainBkg: '#fffdf8',
    primaryColor: '#fffdf8',
    primaryBorderColor: '#1b365d',
    primaryTextColor: '#141413',
    secondaryColor: '#faf9f5',
    tertiaryColor: '#e8e6dc',
    lineColor: '#1b365d',
    edgeLabelBackground: '#faf9f5',
    fontFamily: '"Noto Serif KR", "Noto Serif CJK KR", "Source Han Serif KR", "Nanum Myeongjo", Georgia, serif',
    fontSize: '16px',
  },
});

function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const safeId = useMemo(() => `m${reactId.replace(/[^a-zA-Z0-9]/g, '')}`, [reactId]);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!containerRef.current) return;
      try {
        const { svg } = await mermaid.render(safeId, code);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch (error) {
        if (!cancelled && containerRef.current) {
          const message = error instanceof Error ? error.message : String(error);
          containerRef.current.innerHTML = `<pre class="mermaid-error">mermaid render error\n${message}</pre>`;
        }
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [code, safeId]);

  return <div ref={containerRef} className="mermaid-host" />;
}

function VisualModelPanel({ visual }: { visual: VisualModel }) {
  return (
    <div className="visual-panel">
      <div className="visual-head">
        <strong>{visual.title}</strong>
        <p>{visual.description}</p>
      </div>

      {visual.mermaid ? (
        <div className="visual-block visual-mermaid">
          <strong>{visual.mermaid.title}</strong>
          {visual.mermaid.description ? <p>{visual.mermaid.description}</p> : null}
          <MermaidDiagram code={visual.mermaid.code} />
        </div>
      ) : null}

      {visual.asciiArts && visual.asciiArts.length > 0 ? (
        <div className="visual-ascii-list">
          {visual.asciiArts.map((art) => (
            <div className="visual-block visual-ascii" key={art.title}>
              <strong>{art.title}</strong>
              <pre>{art.art}</pre>
              {art.caption ? <small>{art.caption}</small> : null}
            </div>
          ))}
        </div>
      ) : null}

      {visual.timeline ? (
        <div className="visual-block visual-timeline">
          <strong>{visual.timeline.title}</strong>
          {visual.timeline.description ? <p>{visual.timeline.description}</p> : null}
          <div className="timeline-rows">
            {visual.timeline.rows.map((row) => {
              const total = row.segments.reduce((sum, segment) => sum + Math.max(1, parseInt(segment.duration, 10) || 1), 0) || 1;
              return (
                <div className="timeline-row" key={row.label}>
                  <div className="timeline-row-head">
                    <strong>{row.label}</strong>
                    {row.description ? <small>{row.description}</small> : null}
                  </div>
                  <div className="timeline-track">
                    {row.segments.map((segment, index) => {
                      const value = Math.max(1, parseInt(segment.duration, 10) || 1);
                      const flexBasis = `${(value / total) * 100}%`;
                      return (
                        <div
                          key={`${row.label}-${index}`}
                          className={`timeline-segment timeline-${segment.state}`}
                          style={{ flexBasis }}
                          title={segment.description ?? segment.label}
                        >
                          <span className="timeline-segment-label">{segment.label}</span>
                          <small>{segment.duration}</small>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {visual.timeline.legend ? (
            <div className="timeline-legend">
              {visual.timeline.legend.map((entry) => (
                <span key={entry.state} className={`timeline-${entry.state}`}>
                  <i />
                  {entry.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {visual.comparison ? (
        <div className="visual-block visual-comparison">
          <strong>{visual.comparison.title}</strong>
          {visual.comparison.description ? <p>{visual.comparison.description}</p> : null}
          <table className="comparison-table">
            <thead>
              <tr>
                <th scope="col">항목</th>
                <th scope="col" className={`tone-${visual.comparison.leftTone ?? 'slate'}`}>{visual.comparison.leftLabel}</th>
                <th scope="col" className={`tone-${visual.comparison.rightTone ?? 'slate'}`}>{visual.comparison.rightLabel}</th>
              </tr>
            </thead>
            <tbody>
              {visual.comparison.rows.map((row) => (
                <tr key={row.label} className={row.tone ? `tone-${row.tone}` : undefined}>
                  <th scope="row">{row.label}</th>
                  <td>{row.left}</td>
                  <td>{row.right}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {visual.flowSteps ? (
        <div className="visual-block visual-flow">
          <strong>단계 흐름</strong>
          <ol>
            {visual.flowSteps.map((step) => (
              <li key={step.title}>
                <span className={`visual-step-marker tone-${step.tone}`} />
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {visual.metricTable ? (
        <div className="visual-block visual-metric-table-wrap">
          <strong>{visual.metricTable.title}</strong>
          {visual.metricTable.description ? <p>{visual.metricTable.description}</p> : null}
          <table className="visual-metric-table">
            <thead>
              <tr>
                <th scope="col">항목</th>
                {visual.metricTable.columns.map((column) => (
                  <th key={column} scope="col">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visual.metricTable.rows.map((row) => (
                <tr key={row.label} className={row.tone ? `tone-${row.tone}` : undefined}>
                  <th scope="row">{row.label}</th>
                  {row.cells.map((cell, index) => <td key={`${row.label}-${index}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {visual.slotGroups ? (
        <div className="visual-block visual-slot-groups">
          {visual.slotGroups.map((group) => (
            <div className="visual-slot-group" key={group.title}>
              <div className="visual-slot-group-head">
                <strong>{group.title}</strong>
                <p>{group.description}</p>
              </div>
              <div className="visual-slots">
                {group.slots.map((slot) => (
                  <div className={`visual-slot tone-${slot.tone}`} key={`${group.title}-${slot.label}`}>
                    <strong>{slot.label}</strong>
                    <span>{slot.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {visual.notes && visual.notes.length > 0 ? (
        <ul className="visual-notes">
          {visual.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

const focusOptions: Array<{ id: FocusDepth; label: string }> = [
  { id: 1, label: '1-hop' },
  { id: 2, label: '2-hop' },
  { id: 'all', label: '전체' },
];

export function App() {
  const [selectedId, setSelectedId] = useState('repo-overview');
  const [selectedPathId, setSelectedPathId] = useState(learningPaths[0]?.id ?? '');
  const [focusDepth, setFocusDepth] = useState<FocusDepth>(2);
  const [enabledEdgeKinds, setEnabledEdgeKinds] = useState<EdgeKind[]>(defaultEdgeKinds);
  const [modalOpen, setModalOpen] = useState(false);
  const flowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const selected = graphCards.find((card) => card.id === selectedId) ?? graphCards[0];
  const relations = getCardRelations(selected.id);
  const affectedCandidates = updateCandidates.filter((candidate) => candidate.affectedCardIds.includes(selected.id));
  const selectedLearningPath = learningPaths.find((path) => path.id === selectedPathId) ?? learningPaths[0];
  const detailModalClassName = 'detail-modal detail-modal-kami';

  const focusGraph = useMemo(
    () => getFocusGraph(selected.id, { depth: focusDepth, edgeKinds: enabledEdgeKinds }),
    [enabledEdgeKinds, focusDepth, selected.id],
  );

  const nodes = useMemo(() => buildNodes(focusGraph.cards, selected.id), [focusGraph.cards, selected.id]);
  const edges = useMemo(() => buildEdges(focusGraph.edges, selected.id), [focusGraph.edges, selected.id]);

  const centerTree = useCallback((duration = 420) => {
    void flowInstanceRef.current?.fitView({
      ...treeFitViewOptions,
      duration,
    });
  }, []);

  const handleFlowInit = useCallback((instance: ReactFlowInstance) => {
    flowInstanceRef.current = instance;
    window.setTimeout(() => centerTree(0), 0);
  }, [centerTree]);

  useEffect(() => {
    if (!flowInstanceRef.current) return;

    const timeoutId = window.setTimeout(() => centerTree(240), 0);
    return () => window.clearTimeout(timeoutId);
  }, [centerTree, enabledEdgeKinds, focusDepth, selected.id]);

  function toggleEdgeKind(kind: EdgeKind) {
    setEnabledEdgeKinds((current) => {
      if (current.includes(kind)) return current.length === 1 ? current : current.filter((item) => item !== kind);
      return [...current, kind];
    });
  }

  function openCard(cardId: string) {
    setSelectedId(cardId);
    setModalOpen(true);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="app-title">
          <span>DPAS Migration</span>
          <strong>Kernel I/O 이해 지도</strong>
        </div>

        <div className="learning-panel">
          <div className="panel-heading">
            <Route size={14} />
            <span>학습 경로</span>
          </div>
          <div className="path-tabs">
            {learningPaths.map((path) => (
              <button className={path.id === selectedLearningPath.id ? 'is-active' : ''} key={path.id} onClick={() => setSelectedPathId(path.id)}>
                {path.title}
              </button>
            ))}
          </div>
          <p>{selectedLearningPath.description}</p>
          <div className="path-list">
            {selectedLearningPath.cardIds.map((cardId, index) => {
              const card = graphCards.find((item) => item.id === cardId);
              if (!card) return null;
              return (
                <button className={`path-step ${card.id === selected.id ? 'is-active' : ''}`} key={card.id} onClick={() => openCard(card.id)}>
                  <span>{index + 1}</span>
                  {card.shortTitle}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sync-card">
          <span>
            <GitCommit size={14} />
            마지막 반영 기준
          </span>
          <strong>{shortHash(updateSnapshot.lastProcessedCommit.hash)}</strong>
          <small>{updateSnapshot.lastProcessedCommit.title}</small>
        </div>
      </aside>

      <section className="map-panel">
        <div className="map-header">
          <div>
            <span>{selected.kind}</span>
            <h1>{selected.title}</h1>
          </div>
          <div className="status-pill">
            {statusIcon(selected.status)}
            {selected.status}
          </div>
          <button className="detail-open-button" onClick={() => setModalOpen(true)}>상세 보기</button>
        </div>

        <div className="map-toolbar">
          <div className="control-group">
            <span>Focus</span>
            <div className="segmented-control">
              {focusOptions.map((option) => (
                <button className={focusDepth === option.id ? 'is-active' : ''} key={String(option.id)} onClick={() => setFocusDepth(option.id)}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="control-group edge-filter">
            <span>
              <Filter size={14} />
              관계 필터
            </span>
            <div className="filter-chips">
              {edgeKindLabels.map((kind) => (
                <button className={enabledEdgeKinds.includes(kind.id) ? 'is-active' : ''} key={kind.id} onClick={() => toggleEdgeKind(kind.id)} title={kind.description}>
                  {kind.label}
                </button>
              ))}
            </div>
          </div>

          <div className="visible-count">{focusGraph.cards.length} cards · {focusGraph.edges.length} edges</div>
        </div>

        <div className="flow-frame">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={treeFitViewOptions} minZoom={0.35} maxZoom={1.25} onInit={handleFlowInit} onNodeClick={(_, node) => {
            if (node.type === 'knowledge') openCard(node.id);
          }} proOptions={{ hideAttribution: true }}>
            <Background gap={22} color="#d8ceb9" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
            <Panel position="bottom-right" className="tree-center-panel">
              <button className="tree-center-button" type="button" onClick={() => centerTree()} title="트리 중앙으로 이동" aria-label="트리 중앙으로 이동">
                <Crosshair size={16} />
                <span>트리 중앙으로</span>
              </button>
            </Panel>
          </ReactFlow>
        </div>
      </section>

      <AnimatePresence>
        {modalOpen ? (
          <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setModalOpen(false)}>
            <motion.article className={detailModalClassName} role="dialog" aria-modal="true" aria-labelledby="detail-modal-title" initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }} transition={{ duration: 0.18, ease: 'easeOut' }} onMouseDown={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <div className="detail-kind">{selected.kind}</div>
                  <h2 id="detail-modal-title">{selected.title}</h2>
                  <p className="summary">{selected.summary}</p>
                </div>
                <button className="modal-close" onClick={() => setModalOpen(false)} aria-label="상세 창 닫기">
                  <X size={20} />
                </button>
              </div>

              <div className="modal-content">
                <div className="modal-main">
                  <section className="detail-section">
                    <h3>이게 뭔가요?</h3>
                    <p>{selected.sections.plainExplanation}</p>
                  </section>
                  {selected.visual ? (
                    <section className="detail-section">
                      <h3>시각 모델</h3>
                      <VisualModelPanel visual={selected.visual} />
                    </section>
                  ) : null}
                  <section className="detail-section">
                    <h3>왜 중요한가요?</h3>
                    <p>{selected.sections.whyItMatters}</p>
                  </section>
                  <section className="detail-section">
                    <h3>repo/Notion에서 어디에 쓰이나요?</h3>
                    <p>{selected.sections.repoContext}</p>
                  </section>
                  <section className="detail-section">
                    <h3>헷갈리기 쉬운 지점</h3>
                    <ul>{selected.sections.commonConfusions.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                  </section>
                  <section className="detail-section">
                    <h3>다음에 볼 것</h3>
                    <ul>{selected.sections.nextSteps.map((step) => <li key={step}>{step}</li>)}</ul>
                  </section>
                </div>

                <aside className="modal-side">
                  <section className="detail-section">
                    <h3>연결 관계</h3>
                    <div className="related-list">
                      {relations.map((relation) => (
                        <button key={relation.edge.id} onClick={() => openCard(relation.otherCard.id)}>
                          <span>{relation.label}</span>
                          {relation.otherCard.shortTitle}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="detail-section">
                    <h3>근거</h3>
                    <SourceList sources={selected.sources} />
                  </section>
                  <section className="detail-section">
                    <h3>
                      <Inbox size={15} />
                      업데이트 후보
                    </h3>
                    {affectedCandidates.length > 0 ? (
                      <div className="candidate-list">
                        {affectedCandidates.map((candidate) => (
                          <div className="candidate-item" key={candidate.id}>
                            <div className="candidate-topline">
                              <span>{candidate.kind}</span>
                              <small>{candidate.status}</small>
                            </div>
                            <strong>{candidate.title}</strong>
                            <p>{candidate.summary}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="empty-note">이 카드에 연결된 새 후보는 아직 없습니다.</p>
                    )}
                  </section>
                </aside>
              </div>
            </motion.article>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </main>
  );
}
