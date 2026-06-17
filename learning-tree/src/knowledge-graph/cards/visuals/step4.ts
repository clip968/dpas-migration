import type { VisualModel } from '../../types';

export const step4OverviewVisual: VisualModel = {
  title: 'Step 4 결정이 최신 코드로 바뀐 지점',
  description: 'Step 4는 계획 카드에서 현재 dpas-kernel 코드 상태를 읽는 카드로 갱신됩니다.',
  flowSteps: [
    { title: '1. old DPAS diff', description: '5.18 artifact가 request_queue, blk_mq_poll, sysfs에 넣은 state와 hook을 확인', tone: 'rose' },
    { title: '2. direct field 구현', description: '현재 dpas-kernel은 request_queue에 mode/counter/QD/tf를 직접 둠', tone: 'teal' },
    { title: '3. submit helper', description: 'block fops와 iomap submit이 blk_dpas_prepare_bio()로 모임', tone: 'blue' },
    { title: '4. sysfs reset', description: 'switch_enabled store가 lock 안에서 PAS window를 새로 시작', tone: 'amber' },
    { title: '5. static test', description: 'full_mode_switching_static.py가 현재 구조를 회귀 방지 기준으로 잡음', tone: 'violet' },
  ],
  notes: [
    '이제 Step 4의 핵심은 "무엇을 할까"보다 "현재 코드가 어디까지 왔나"를 보여 주는 것입니다.',
    'PAS-only 계획과 full DPAS 구현 상태를 구분해서 읽어야 합니다.',
  ],
};

export const step4StatePlacementVisual: VisualModel = {
  title: 'request_queue direct field 구조',
  description: '현재 구현은 queue 안에 full DPAS state를 직접 두고 submit/sysfs/poll이 같은 window를 봅니다.',
  comparison: {
    title: '계획에서 현재 코드로 바뀐 점',
    leftLabel: '예전 계획/비교 단계',
    rightLabel: '현재 dpas-kernel',
    leftTone: 'rose',
    rightTone: 'teal',
    rows: [
      { label: 'state 위치', left: '별도 state 묶음 후보도 검토', right: 'request_queue direct fields로 구현' },
      { label: 'mode', left: 'Part 5 이후 후보', right: 'enum dpas_mode + dpas_mode 필드' },
      { label: 'counter', left: 'mode counter 필요성만 정리', right: 'dpas_cp/pas/ol/int_cnt와 qd/tf 필드' },
      { label: 'sysfs 접근', left: 'lifetime 정책 미정', right: 'switch_enabled store가 lock 안에서 reset' },
    ],
  },
  asciiArts: [
    {
      title: 'code evidence',
      art: [
        'old kernel/include/linux/blkdev.h:424',
        '  struct blk_rq_pas_stat __percpu *pas_stat;',
        '  int pas_enabled;',
        '  int switch_enabled;',
        '',
        'current dpas-kernel/include/linux/blkdev.h:490',
        '  enum dpas_mode { INT, CP, PAS, OL }',
        '',
        'current request_queue fields',
        '  dpas_lock',
        '  dpas_mode',
        '  dpas_cp_cnt / dpas_pas_cnt / dpas_ol_cnt / dpas_int_cnt',
        '  dpas_qd / dpas_qd_sum / dpas_tf',
        '  switch_enabled / switch_param1..7',
      ].join('\n'),
      caption: '현재 learning tree는 후보 계획보다 실제 dpas-kernel field 배치를 먼저 보여 줍니다.',
    },
  ],
  notes: [
    'direct field 방식은 현재 구현 상태를 설명합니다. 나중에 구조를 다시 정리할 여지는 별도 리팩터링 판단입니다.',
    'submit helper와 poll switcher가 같은 queue state를 읽으므로 locking 설명이 중요합니다.',
  ],
};

export const step4PollHookCandidatesVisual: VisualModel = {
  title: 'PAS sleep-before-poll hook 후보',
  description: 'poll path 계층별 책임과 접근 가능한 정보를 비교해서 blk_mq_poll()을 1차 후보로 둡니다.',
  mermaid: {
    title: 'latest poll path',
    description: '각 단계가 다음 단계에 넘기는 정보가 hook 판단의 기준입니다.',
    code: [
      'flowchart TD',
      '  bio["bio_poll()\\nreads bio->bi_cookie"] -->|calls| mq["blk_mq_poll(q, cookie)"]',
      '  mq -->|selects| hctx["q->queue_hw_ctx[cookie]"]',
      '  hctx -->|passes| loop["blk_hctx_poll(q, hctx)"]',
      '  loop -->|calls| drv["q->mq_ops->poll(hctx, iob)"]',
      '  drv -->|checks| nvme["nvme_poll()\\nchecks NVMe CQ"]',
    ].join('\n'),
  },
  metricTable: {
    title: 'hook 후보 판단표',
    columns: ['볼 수 있는 정보', '장점', '주의'],
    rows: [
      { label: 'bio_poll()', cells: ['bio, bi_bdev, cookie', 'user-facing poll entry에 가까움', 'request/hctx 내부 state 접근이 제한적'], tone: 'blue' },
      { label: 'blk_mq_poll()', cells: ['request_queue, cookie, hctx lookup', 'block layer 공통이고 queue state와 연결 쉬움', 'request-level bucket/generation 정보 확보 방법 확인 필요'], tone: 'teal' },
      { label: 'blk_hctx_poll()', cells: ['q, hctx, mq_ops->poll loop', 'driver callback 직전', '반복 loop 책임과 PAS policy가 섞일 수 있음'], tone: 'amber' },
      { label: 'nvme_poll()', cells: ['NVMe queue, CQ pending', 'NVMe 실험은 빠르게 가능', 'NVMe 전용 hook이 됨'], tone: 'rose' },
    ],
  },
  asciiArts: [
    {
      title: 'code evidence',
      art: [
        'src/linux-upstream/block/blk-core.c:971',
        '  ret = blk_mq_poll(q, cookie, iob, flags);',
        '',
        'src/linux-upstream/block/blk-mq.c:5269',
        '  int blk_mq_poll(struct request_queue *q, blk_qc_t cookie, ...)',
        '  return blk_hctx_poll(q, q->queue_hw_ctx[cookie], iob, flags);',
        '',
        'kernel/block/blk-mq.c:5860',
        '  if (blk_mq_poll_hybrid(q, cookie))',
        '      return 1;',
        '  return blk_mq_poll_classic(q, cookie, iob, flags);',
      ].join('\n'),
      caption: 'latest는 단순 poll dispatch이고 old DPAS는 hybrid sleep과 classic poll/update를 분리했습니다.',
    },
  ],
  notes: [
    'blk_mq_poll()은 1순위 후보일 뿐입니다. request-level 정보가 막히면 bio_poll() 또는 blk_hctx_poll()을 재평가해야 합니다.',
    'nvme_poll()은 completion queue와 가장 가깝지만 block layer 일반성을 잃습니다.',
  ],
};

export const step4SysfsLifecycleVisual: VisualModel = {
  title: 'switch_enabled는 mode window reset entry다',
  description: '현재 sysfs store는 switch_enabled 값을 쓰고 같은 lock 안에서 mode/counter/QD/tf window를 PAS 기준으로 리셋합니다.',
  flowSteps: [
    { title: '1. poll-capable 확인', description: 'queue_dpas_poll_capable(q) 아니면 -EINVAL', tone: 'teal' },
    { title: '2. 0/1 parsing', description: 'kstrtoint 후 val 범위를 확인', tone: 'blue' },
    { title: '3. lock 획득', description: 'submit path와 poll path가 같은 state를 볼 수 있으므로 dpas_lock 사용', tone: 'amber' },
    { title: '4. reset window', description: 'mode를 PAS로 두고 counters, QD, tf를 0으로 초기화', tone: 'violet' },
  ],
  asciiArts: [
    {
      title: 'current store model',
      art: [
        'queue_switch_enabled_store()',
        '  if (!queue_dpas_poll_capable(q))',
        '      return -EINVAL;',
        '',
        '  parse val: only 0 or 1',
        '',
        '  spin_lock_irqsave(&q->dpas_lock, flags)',
        '      q->switch_enabled = val',
        '      q->dpas_mode = DPAS_MODE_PAS',
        '      q->dpas_*_cnt = 0',
        '      q->dpas_qd = 0',
        '      q->dpas_qd_sum = 0',
        '      q->dpas_tf = 0',
        '  spin_unlock_irqrestore(...)',
      ].join('\n'),
      caption: 'switch_enabled를 다시 쓰는 순간 새 측정 window가 PAS에서 시작됩니다.',
    },
  ],
  notes: [
    '이 카드는 sysfs 매크로 문법보다 현재 reset 의미를 먼저 보여 줍니다.',
    'reset은 lock 안에서 해야 submit helper와 poll switcher가 반쯤 초기화된 state를 보지 않습니다.',
  ],
};

export const step4QueueLifecycleVisual: VisualModel = {
  title: 'queue init에서 direct field 기본값을 둔다',
  description: '현재 구현은 queue 생성 후 별도 할당 없이 request_queue direct fields를 초기화합니다.',
  timeline: {
    title: 'queue state initialization order',
    rows: [
      {
        label: 'create',
        segments: [
          { label: 'blk_alloc_queue()', duration: 'q object', state: 'submit', description: 'request_queue 메모리와 기본 lock/ref/stat 준비' },
          { label: 'blk_mq_init_allocated_queue()', duration: 'mq setup', state: 'check', description: 'hctx/tag/context 구조 연결' },
          { label: 'DPAS fields init', duration: 'during init', state: 'done', description: 'dpas_lock, switch_enabled, mode, counters 초기화' },
        ],
      },
      {
        label: 'reset',
        segments: [
          { label: 'switch_enabled store', duration: 'sysfs write', state: 'check', description: '사용자가 새 측정 window를 열거나 닫음' },
          { label: 'queue_dpas_reset_switch_state()', duration: 'locked reset', state: 'done', description: 'mode/counter/QD/tf reset' },
          { label: 'submit/poll observe', duration: 'next I/O', state: 'done', description: '새 window의 mode state를 사용' },
        ],
      },
    ],
  },
  asciiArts: [
    {
      title: 'code evidence',
      art: [
        'dpas-kernel/block/blk-mq.c:4777',
        '  spin_lock_init(&q->dpas_lock);',
        '  q->switch_enabled = 0;',
        '  q->dpas_mode = DPAS_MODE_PAS;',
        '  q->dpas_cp_cnt = 0;',
        '  q->dpas_pas_cnt = 0;',
        '  q->dpas_ol_cnt = 0;',
        '  q->dpas_int_cnt = 0;',
        '',
        'dpas-kernel/block/blk-sysfs.c:788',
        '  queue_dpas_reset_switch_state(q)',
      ].join('\n'),
      caption: '현재는 allocation/free보다 init/reset이 핵심 lifecycle입니다.',
    },
  ],
  notes: [
    '별도 state allocation 실패 경로가 없어진 대신 request_queue 구조체가 직접 커졌습니다.',
    'lifecycle 질문은 이제 "어디서 할당하나"보다 "언제 reset하고 누가 동시에 읽나"로 바뀌었습니다.',
  ],
};

export const step4RequestQueueModelVisual: VisualModel = {
  title: 'request_queue 하나 안의 ctx/hctx 구조',
  description: 'q pointer는 queue 하나의 주소지만, 그 안에 per-CPU ctx와 여러 hctx가 함께 있습니다.',
  asciiArts: [
    {
      title: 'request_queue shape',
      art: [
        'struct request_queue *q',
        '  contains -> q->mq_ops',
        '  contains -> q->queue_ctx       (per-CPU blk_mq_ctx)',
        '  contains -> q->queue_hw_ctx[]  (many blk_mq_hw_ctx)',
        '',
        'CPU0 ctx',
        '  hctxs[DEFAULT] -> hctx 0',
        '  hctxs[READ]    -> hctx 1',
        '  hctxs[POLL]    -> hctx 4',
        '',
        'CPU1 ctx',
        '  hctxs[DEFAULT] -> hctx 0',
        '  hctxs[READ]    -> hctx 1',
        '  hctxs[POLL]    -> hctx 4',
      ].join('\n'),
      caption: '여러 CPU ctx가 같은 hctx를 가리킬 수 있고, q->queue_hw_ctx[cookie]는 poll 대상 hctx를 고릅니다.',
    },
  ],
  notes: [
    'SSD 또는 block device가 늘어나면 보통 request_queue도 늘지만, partition은 parent disk의 queue를 공유할 수 있습니다.',
    'queue에 state를 둔다는 말은 특정 request가 아니라 block device queue 단위의 DPAS state를 둔다는 뜻입니다.',
  ],
};

export const step4HctxTypeMapVisual: VisualModel = {
  title: 'DEFAULT/READ/POLL은 init 때 map을 만들고 request 때 선택한다',
  description: 'request가 들어올 때 새 queue를 만드는 것이 아니라, flag를 보고 이미 준비된 ctx->hctxs[type]을 lookup합니다.',
  metricTable: {
    title: 'hctx type 선택 규칙',
    columns: ['선택 조건', '의미', 'PAS 관련성'],
    rows: [
      { label: 'DEFAULT', cells: ['REQ_POLLED도 read-only 조건도 아님', '일반 write/flush/discard 등', 'interrupt baseline과 비교'], tone: 'slate' },
      { label: 'READ', cells: ['REQ_POLLED 없는 READ', 'read latency 보호용 분리', 'PAS-only 핵심 대상은 아님'], tone: 'blue' },
      { label: 'POLL', cells: ['REQ_POLLED 있음', 'polled I/O of any kind', 'PAS sleep-before-poll 직접 대상'], tone: 'violet' },
    ],
  },
  asciiArts: [
    {
      title: 'code evidence',
      art: [
        'include/linux/blk-mq.h:482',
        '  HCTX_TYPE_DEFAULT',
        '  HCTX_TYPE_READ',
        '  HCTX_TYPE_POLL',
        '',
        'block/blk-mq.h:97',
        '  if (opf & REQ_POLLED)',
        '      type = HCTX_TYPE_POLL;',
        '  else if ((opf & REQ_OP_MASK) == REQ_OP_READ)',
        '      type = HCTX_TYPE_READ;',
        '',
        'block/blk-mq.c:553',
        '  data->hctx = blk_mq_map_queue(data->cmd_flags, data->ctx);',
      ].join('\n'),
      caption: 'POLL이 READ보다 먼저 선택되므로 polled read도 HCTX_TYPE_POLL로 갑니다.',
    },
  ],
  notes: [
    'NVMe는 init 중 HCTX_TYPE_DEFAULT/READ/POLL queue 수와 map을 준비합니다.',
    'Part 4 PAS-only는 queue map을 새로 만드는 일이 아니라 이미 POLL로 들어온 I/O에 policy를 얹는 일입니다.',
  ],
};

export const step4OpenQuestionsVisual: VisualModel = {
  title: '최신 Step 4 이후 남은 질문',
  description: '현재 코드는 static/build 검증을 통과했지만 runtime boot와 실제 I/O 증거는 아직 남아 있습니다.',
  slotGroups: [
    {
      title: 'runtime proof',
      description: '현재 full DPAS 코드가 실제 VM/장치에서 의도대로 움직이는가',
      slots: [
        { label: 'VM boot', description: '새 bzImage가 VM에서 부팅되는지 확인', tone: 'amber' },
        { label: 'sysfs read/write', description: 'switch_enabled와 mode knobs가 runtime에서 정상 동작하는지 확인', tone: 'teal' },
        { label: 'HIPRI workload', description: 'raw block과 filesystem DIO 양쪽에서 helper 경로가 타는지 확인', tone: 'rose' },
      ],
    },
    {
      title: 'measurement proof',
      description: '성능 결론을 내기 전에 측정 조건과 mode 상태를 고정하는 방법',
      slots: [
        { label: 'knob reset', description: '각 mode 실행 전 CP/LHP/PAS/INT sysfs 상태를 명시적으로 reset', tone: 'blue' },
        { label: 'mode evidence', description: 'counter 또는 trace로 실제 mode 전이를 확인', tone: 'slate' },
        { label: 'repeat design', description: 'jobs/repeats/order/warmup을 통제해 해석 오류를 줄임', tone: 'violet' },
      ],
    },
  ],
  notes: [
    '이 카드는 예전 구현 전 질문 목록이 아니라 최신 코드 이후 검증 질문 목록입니다.',
    'compile/link 통과와 runtime DPAS 동작은 같은 성공 기준이 아닙니다.',
  ],
};
