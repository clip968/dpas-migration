import type { VisualModel } from '../../types';

export const step3OverviewVisual: VisualModel = {
  title: 'Step 3를 카테고리로 나누는 이유',
  description: 'Step 1/2에서 본 poll path와 submission flag를 queue foundation, DPAS hook, Part 4 판단으로 분해합니다.',
  flowSteps: [
    { title: '1. 최신 queue foundation', description: 'REQ_POLLED가 HCTX_TYPE_POLL로 가는 구조를 확인', tone: 'blue' },
    { title: '2. NVMe poll queue', description: 'poll queue 수, IRQ affinity 제외, CPU mapping 확인', tone: 'teal' },
    { title: '3. DPAS 5.18 hook', description: 'PAS state, sleep, result update, interrupt fops hook 추출', tone: 'violet' },
    { title: '4. Part 4 boundary', description: 'queue mapping은 건드리지 않고 PAS-only policy만 이식', tone: 'amber' },
  ],
  notes: [
    'Step 3의 목적은 Step 1/2를 반복하는 것이 아니라, 이미 있는 queue 구조와 새로 이식할 DPAS policy를 분리하는 것입니다.',
    '카드는 category별로 나누어 Part 4에서 무엇을 이식할지 바로 판단할 수 있게 구성합니다.',
  ],
};

export const step3QueueMappingVisual: VisualModel = {
  title: 'REQ_POLLED가 poll hctx를 고르는 흐름',
  description: '최신 kernel에서 request allocation 전후로 queue type이 정해지는 흐름입니다.',
  asciiArts: [
    {
      title: 'submission-side queue selection',
      art: [
        'bio->bi_opf',
        '  |',
        '  | contains REQ_POLLED',
        '  v',
        'blk_mq_get_hctx_type(opf)',
        '  |',
        '  +-- REQ_POLLED yes -> HCTX_TYPE_POLL',
        '  +-- READ only      -> HCTX_TYPE_READ',
        '  +-- otherwise      -> HCTX_TYPE_DEFAULT',
        '  |',
        '  v',
        'blk_mq_map_queue(opf, ctx)',
        '  |',
        '  v',
        'ctx->hctxs[HCTX_TYPE_POLL]',
      ].join('\n'),
      caption: 'poll queue 선택은 poll loop가 아니라 request allocation 시점에 이미 결정됩니다.',
    },
  ],
  notes: [
    'src/linux-upstream/block/blk-mq.h:90-113이 핵심 근거입니다.',
    'REQ_POLLED 검사가 READ 검사보다 먼저 오므로 READ | REQ_POLLED도 poll hctx가 우선입니다.',
  ],
};

export const step3NvmeQueueVisual: VisualModel = {
  title: 'NVMe poll queue는 별도 map이며 여러 개일 수 있음',
  description: 'poll queue는 IRQ가 없고 generic CPU mapping으로 분산됩니다.',
  metricTable: {
    title: 'queue type별 차이',
    columns: ['선택 조건', 'NVMe mapping', 'DPAS 판단'],
    rows: [
      { label: 'DEFAULT', cells: ['poll/read 전용 조건 없음', 'IRQ affinity 사용 가능', 'interrupt baseline'], tone: 'slate' },
      { label: 'READ', cells: ['REQ_POLLED 없는 read', 'IRQ affinity 사용 가능', 'PAS-only 핵심 대상 아님'], tone: 'blue' },
      { label: 'POLL', cells: ['REQ_POLLED 있음', 'IRQ 없음, blk_mq_map_queues()', 'PAS sleep-before-poll 대상'], tone: 'violet' },
    ],
  },
  asciiArts: [
    {
      title: 'poll queue count',
      art: [
        'poll_queues = min(dev->nr_poll_queues, nr_io_queues - 1)',
        '',
        '전체 I/O queue 중 최소 1개는 non-polled I/O용으로 남김',
        '나머지 범위 안에서 poll queue를 여러 개 만들 수 있음',
      ].join('\n'),
      caption: 'src/linux-upstream/drivers/nvme/host/pci.c:2898-2903',
    },
  ],
  notes: [
    'poll queue 구조 자체는 최신 kernel에도 있으므로 Part 4 이식 대상이 아닙니다.',
    'poll queue는 IRQ affinity가 없기 때문에 CPU를 queue에 고르게 나누는 generic mapping을 씁니다.',
  ],
};

export const step3DpasHookInventoryVisual: VisualModel = {
  title: 'DPAS 5.18 hook inventory',
  description: 'DPAS artifact가 queue foundation 위에 추가한 상태와 함수를 한눈에 봅니다.',
  slotGroups: [
    {
      title: 'state',
      description: 'PAS/DPAS가 기억해야 하는 값',
      slots: [
        { label: 'blk_rq_pas_stat', description: 'dur, adj, up/dn, sr_pnlt/sr_last, update_req', tone: 'teal' },
        { label: 'request_queue fields', description: 'pas_stat, pas_enabled, pas_adaptive_enabled, switch_enabled', tone: 'violet' },
        { label: 'blk_switch', description: 'CPU별 CP/PAS/OL/INT mode와 counter', tone: 'amber' },
      ],
    },
    {
      title: 'code hooks',
      description: '실제로 policy가 실행되는 위치',
      slots: [
        { label: 'blk_mq_poll_pas_nsecs()', description: '다음 sleep duration 계산', tone: 'teal' },
        { label: 'blk_mq_poll_hybrid_sleep()', description: 'hrtimer_sleeper + io_schedule()', tone: 'blue' },
        { label: 'blk_mq_poll_classic()', description: 'poll_count로 sleep result 기록', tone: 'rose' },
      ],
    },
  ],
  notes: [
    'DPAS 5.18은 단일 함수 patch가 아니라 state, sysfs, sleep, result update, mode switching이 묶인 변경입니다.',
    'Part 4에서는 이 중 PAS-only에 필요한 최소 subset만 고릅니다.',
  ],
};

export const step3PasStateVisual: VisualModel = {
  title: 'PAS state가 움직이는 방식',
  description: 'dur 하나가 아니라 recent result, update flag, generation counter가 함께 움직입니다.',
  mermaid: {
    title: 'PAS duration feedback loop',
    description: 'sleep 결과가 다음 duration 계산으로 돌아갑니다.',
    code: [
      'flowchart TD',
      '  A["1. duration 계산\\nblk_mq_poll_pas_nsecs()"] --> B["2. sleep 시간 선택\\nstat[bucket].dur"]',
      '  B --> C["3. request sleep\\nhrtimer + io_schedule()"]',
      '  C --> D["4. poll 실행\\nblk_mq_poll_classic()"]',
      '  D --> E["5. 결과 기록\\nsr_last / update_req"]',
      '  E --> F["6. 다음 I/O에서 조정\\nadj -> dur update"]',
      '  F -. feedback .-> A',
    ].join('\n'),
  },
  metricTable: {
    title: 'blk_rq_pas_stat 주요 field',
    columns: ['역할', '왜 필요한가'],
    rows: [
      { label: 'dur', cells: ['다음 sleep 시간', 'PAS의 직접 제어값'], tone: 'teal' },
      { label: 'adj/up/dn', cells: ['duration 조정 계수', 'UNDER/OVER history에 따라 dur 변경'], tone: 'violet' },
      { label: 'sr_pnlt/sr_last', cells: ['최근 결과 2개', 'cur_case = sr_pnlt * 2 + sr_last'], tone: 'amber' },
      { label: 'dur_cnt', cells: ['generation counter', 'request가 사용한 dur 세대 추적'], tone: 'blue' },
      { label: 'dur_cnt_checked', cells: ['중복 update 방지', '같은 결과를 두 번 반영하지 않음'], tone: 'rose' },
    ],
  },
  notes: [
    'kernel/include/linux/blk_types.h:536-548이 구조체 근거입니다.',
    'Part 4에서는 이 state를 request_queue에 직접 흩뿌릴지 dpas_queue로 감쌀지 결정해야 합니다.',
  ],
};

export const step3PasSleepUpdateVisual: VisualModel = {
  title: 'PAS는 sleep과 update가 한 세트',
  description: 'sleep-before-poll만 넣으면 PAS가 아니라 fixed delay에 가깝습니다.',
  timeline: {
    title: '한 request가 PAS feedback을 만드는 시간축',
    rows: [
      {
        label: 'request',
        segments: [
          { label: 'submit', duration: '1', state: 'submit', description: 'REQ_POLLED로 poll hctx에 들어감' },
          { label: 'duration calc', duration: '1', state: 'check', description: 'blk_mq_poll_pas_nsecs()' },
          { label: 'sleep', duration: '2', state: 'sleep', description: 'hrtimer_sleeper + io_schedule()' },
          { label: 'poll loop', duration: '2', state: 'busy', description: 'q->mq_ops->poll() 반복' },
          { label: 'update', duration: '1', state: 'done', description: 'sr_last/update_req 기록' },
        ],
      },
    ],
    legend: [
      { state: 'submit', label: '제출' },
      { state: 'check', label: 'duration 계산' },
      { state: 'sleep', label: 'CPU 양보' },
      { state: 'busy', label: 'polling' },
      { state: 'done', label: 'result update' },
    ],
  },
  notes: [
    'blk_mq_poll_hybrid_sleep()는 실제 sleep 위치입니다.',
    'blk_mq_poll_classic()은 poll_count == 0인지 여부로 sleep result를 기록합니다.',
    'request별 RQF_MQ_POLL_SLEPT와 dur_cnt tracking이 중복 sleep/update를 막습니다.',
  ],
};

export const step3InterruptFopsVisual: VisualModel = {
  title: 'DPAS interrupt mode는 fops.c에서 submit 전에 끊음',
  description: 'bio_poll()을 안 부르는 것보다 먼저 IOCB_HIPRI/REQ_POLLED를 제거해 poll hctx 선택을 막습니다.',
  comparison: {
    title: 'polled mode vs interrupt mode',
    leftLabel: 'CP/PAS/OL mode',
    rightLabel: 'INT mode',
    leftTone: 'violet',
    rightTone: 'rose',
    rows: [
      { label: 'fops.c 조건', left: 'sc->mode != 0', right: 'sc->mode == 0' },
      { label: 'submit 전 처리', left: 'bio_set_polled(&bio, iocb)', right: 'IOCB_HIPRI 제거, REQ_POLLED 제거' },
      { label: 'hctx 선택', left: 'HCTX_TYPE_POLL', right: 'DEFAULT/READ hctx' },
      { label: 'wait loop', left: 'bio_poll()', right: 'blk_io_schedule()' },
      { label: '이식 판단', left: 'PAS-only Part 4 대상', right: 'full DPAS Part 5/6 대상' },
    ],
  },
  asciiArts: [
    {
      title: 'interrupt mode 핵심',
      art: [
        'if sc->mode == 0:',
        '  iocb->ki_flags &= ~IOCB_HIPRI',
        '  bio.bi_opf &= ~REQ_POLLED',
        '  submit_bio(&bio)',
        '  wait with blk_io_schedule()',
      ].join('\n'),
      caption: 'kernel/block/fops.c:110-174',
    },
  ],
  notes: [
    'Step 3에서 보정된 핵심: 기존 DPAS는 completion-only skip이 아니라 submission-side enforcement를 사용했습니다.',
    '최신 kernel 이식에서는 이 path가 그대로 남아 있는지, iomap direct I/O 쪽도 별도 hook이 필요한지 Step 4/6에서 봐야 합니다.',
  ],
};

export const step3Part4BoundaryVisual: VisualModel = {
  title: 'Step 3에서 Part 4로 넘기는 경계선',
  description: '이식할 것과 건드리지 않을 것을 분리해 첫 구현 범위를 줄입니다.',
  metricTable: {
    title: 'Part 4 판단표',
    columns: ['Part 4 포함', 'Part 4 제외'],
    rows: [
      { label: 'queue infra', cells: ['기존 HCTX_TYPE_POLL 사용', 'HCTX_TYPE_POLL enum 재작성 금지'], tone: 'slate' },
      { label: 'NVMe mapping', cells: ['기존 poll queue map 관찰', 'nvme_pci_map_queues() 수정 보류'], tone: 'blue' },
      { label: 'PAS policy', cells: ['sleep-before-poll, duration state, result update', 'full DPAS mode switching 제외'], tone: 'teal' },
      { label: 'interrupt mode', cells: ['fops.c hook을 문서상 추적', 'Part 4 구현 대상에서는 제외'], tone: 'rose' },
    ],
  },
  notes: [
    'Step 3의 결론은 "queue mapping을 이식"이 아니라 "queue mapping은 이미 있으니 PAS policy만 최소 이식"입니다.',
    'full interrupt mode는 fops.c submission hook과 NVMe/default queue 검증까지 포함하므로 Part 4보다 큽니다.',
  ],
};
