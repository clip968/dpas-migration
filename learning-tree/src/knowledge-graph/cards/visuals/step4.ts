import type { VisualModel } from '../../types';

export const step4OverviewVisual: VisualModel = {
  title: 'Step 4가 Part 4 전에 고정하는 결정',
  description: 'Step 4는 코드를 쓰기 전에 state 위치, poll hook, sysfs 노출 순서를 좁히는 decision pass입니다.',
  flowSteps: [
    { title: '1. old DPAS diff', description: '5.18 artifact가 request_queue, blk_mq_poll, sysfs에 넣은 state와 hook을 확인', tone: 'rose' },
    { title: '2. latest state gap', description: '최신 request_queue에는 DPAS state가 없음을 확인', tone: 'slate' },
    { title: '3. q->dpas 방향', description: 'request_queue에는 pointer만 두고 PAS state는 별도 구조체로 분리', tone: 'teal' },
    { title: '4. poll hook 비교', description: 'bio_poll, blk_mq_poll, blk_hctx_poll, nvme_poll 중 blk_mq_poll을 1차 후보로 둠', tone: 'blue' },
    { title: '5. lifecycle 먼저', description: 'sysfs knob보다 q->dpas init/free와 NULL handling을 먼저 결정', tone: 'amber' },
  ],
  notes: [
    'Step 4의 산출물은 patch가 아니라 Part 4에서 손으로 구현할 위치와 순서입니다.',
    'PAS-only를 먼저 닫고 full DPAS mode switching과 interrupt mode는 뒤 단계로 분리합니다.',
  ],
};

export const step4StatePlacementVisual: VisualModel = {
  title: 'request_queue 직접 field vs q->dpas pointer',
  description: '최신 kernel 공용 구조체를 덜 오염시키기 위해 DPAS state를 별도 구조체로 모으는 판단입니다.',
  comparison: {
    title: 'state placement 비교',
    leftLabel: 'old DPAS direct fields',
    rightLabel: 'latest migration q->dpas',
    leftTone: 'rose',
    rightTone: 'teal',
    rows: [
      { label: 'request_queue 변경', left: 'pas_stat, pas_enabled, switch_enabled 등 여러 field 추가', right: 'struct dpas_queue *dpas pointer만 추가' },
      { label: 'PAS-only 범위', left: 'PAS와 full DPAS switch_param이 섞임', right: 'PAS 최소 state부터 시작하고 full DPAS는 확장 가능' },
      { label: 'CONFIG_DPAS', left: '공용 구조체에 실험 field가 많이 남음', right: 'pointer와 helper를 CONFIG_DPAS로 감싸기 쉬움' },
      { label: 'sysfs 접근', left: 'q->pas_enabled 직접 접근', right: 'q->dpas NULL check 후 q->dpas->pas_enabled 접근' },
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
        'latest src/linux-upstream/include/linux/blkdev.h:493',
        '  const struct blk_mq_ops *mq_ops;',
        '  struct blk_mq_ctx __percpu *queue_ctx;',
        '  struct blk_mq_hw_ctx * __rcu *queue_hw_ctx;',
        '',
        'migration direction',
        '  struct request_queue',
        '    contains -> struct dpas_queue *dpas',
        '      contains -> PAS state / counters / per-CPU state',
      ].join('\n'),
      caption: 'old DPAS는 request_queue에 field를 직접 추가했고, latest에는 DPAS state가 아직 없습니다.',
    },
  ],
  notes: [
    '이 판단은 Part 4에서 include/linux/blkdev.h를 수정할 때 직접 field 복사를 피하게 만듭니다.',
    'q->dpas가 NULL일 수 있으므로 poll hook과 sysfs 모두 NULL guard를 전제로 설계해야 합니다.',
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
      { label: 'blk_mq_poll()', cells: ['request_queue, cookie, hctx lookup', 'block layer 공통이고 q->dpas와 연결 쉬움', 'request-level bucket/generation 정보 확보 방법 확인 필요'], tone: 'teal' },
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
  title: 'sysfs는 q->dpas lifecycle 뒤에 온다',
  description: 'sysfs show/store는 q->dpas를 읽고 쓰므로 allocation/free와 NULL handling이 먼저 정해져야 합니다.',
  flowSteps: [
    { title: '1. q->dpas 구조 결정', description: 'PAS state가 어디에 있는지 먼저 고정', tone: 'teal' },
    { title: '2. init/free 연결', description: 'queue 생성 성공 후 할당하고 queue free 전에 해제', tone: 'blue' },
    { title: '3. sysfs show/store 작성', description: 'q->dpas NULL이면 -EINVAL 같은 실패 경로 반환', tone: 'amber' },
    { title: '4. queue_attrs에 entry 추가', description: 'pas_enabled 같은 knob를 /sys/block/.../queue 아래 노출', tone: 'violet' },
  ],
  asciiArts: [
    {
      title: 'macro expansion model',
      art: [
        'src/linux-upstream/block/blk-sysfs.c:590',
        '  #define QUEUE_RW_ENTRY(_prefix, _name)',
        '    .attr  = { .name = _name, .mode = 0644 }',
        '    .show  = _prefix##_show',
        '    .store = _prefix##_store',
        '',
        'future example',
        '  QUEUE_RW_ENTRY(queue_pas_enabled, "pas_enabled");',
        '    expects -> queue_pas_enabled_show()',
        '    expects -> queue_pas_enabled_store()',
        '',
        'safe store shape',
        '  if (!q->dpas)',
        '      return -EINVAL;',
        '  q->dpas->pas_enabled = val;',
      ].join('\n'),
      caption: '매크로는 sysfs entry를 만들 뿐이고, q->dpas의 lifetime 안전성은 별도로 보장해야 합니다.',
    },
  ],
  notes: [
    'sysfs_emit()은 show callback에서 page buffer를 안전하게 채우는 helper입니다.',
    'ssize_t는 성공 시 byte count, 실패 시 음수 errno를 반환하기 위해 쓰입니다.',
  ],
};

export const step4QueueLifecycleVisual: VisualModel = {
  title: 'q->dpas init/free 후보',
  description: 'request_queue 객체 생성과 blk-mq queue 완성 시점을 구분해서 DPAS state lifetime을 잡습니다.',
  timeline: {
    title: 'queue lifetime reading order',
    rows: [
      {
        label: 'create',
        segments: [
          { label: 'blk_alloc_queue()', duration: 'q object', state: 'submit', description: 'request_queue 메모리와 기본 lock/ref/stat 준비' },
          { label: 'blk_mq_init_allocated_queue()', duration: 'mq setup', state: 'check', description: 'hctx/tag/context 구조 연결' },
          { label: 'dpas init candidate', duration: 'after success', state: 'done', description: 'poll-capable queue인지 보고 q->dpas 할당 후보' },
        ],
      },
      {
        label: 'free',
        segments: [
          { label: 'blk_free_queue()', duration: 'release', state: 'check', description: 'stats와 mq release 처리' },
          { label: 'dpas free candidate', duration: 'before RCU free', state: 'done', description: 'q 메모리가 RCU로 넘어가기 전 q->dpas 해제 후보' },
          { label: 'blk_free_queue_rcu()', duration: 'q memory', state: 'done', description: 'request_queue 메모리 반환' },
        ],
      },
    ],
  },
  asciiArts: [
    {
      title: 'code evidence',
      art: [
        'src/linux-upstream/block/blk-mq.c:4453',
        '  q = blk_alloc_queue(lim, set->numa_node);',
        '  q->queuedata = queuedata;',
        '  ret = blk_mq_init_allocated_queue(set, q);',
        '',
        'src/linux-upstream/block/blk-core.c:257',
        '  static void blk_free_queue(struct request_queue *q)',
        '  call_rcu(&q->rcu_head, blk_free_queue_rcu);',
      ].join('\n'),
      caption: 'blk_alloc_queue는 q 그릇을 만들고, blk_mq_alloc_queue wrapper가 blk-mq 초기화 성공까지 묶습니다.',
    },
  ],
  notes: [
    'PAS가 poll path 기능이면 blk-mq 초기화 성공 이후에 q->dpas를 붙이는 쪽이 자연스럽습니다.',
    'allocation 실패를 queue 생성 실패로 볼지 DPAS disable로 볼지는 Part 4 구현 전에 결정해야 합니다.',
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
    'q->dpas에 state를 둔다는 말은 block device queue 단위의 PAS state를 둔다는 뜻입니다.',
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
  title: 'Step 4에서 Part 4로 넘기기 전 남은 질문',
  description: 'blk_mq_poll() 1차 후보와 q->dpas 방향을 실제 구현으로 바꾸려면 아직 확인할 정보입니다.',
  slotGroups: [
    {
      title: 'hook feasibility',
      description: 'blk_mq_poll()에서 PAS-only에 필요한 정보를 얻을 수 있는가',
      slots: [
        { label: 'request lookup', description: 'cookie/hctx만으로 현재 request 또는 bucket 정보를 안전하게 찾을 수 있는지 확인', tone: 'amber' },
        { label: 'duplicate guard', description: 'old RQF_MQ_POLL_SLEPT 같은 중복 sleep/update 방지 수단 필요', tone: 'rose' },
        { label: 'result update', description: 'poll 결과가 UNDER/OVER duration update로 돌아갈 위치 필요', tone: 'teal' },
      ],
    },
    {
      title: 'state and sysfs safety',
      description: 'q->dpas lifetime과 사용자 knob를 crash 없이 묶는 방법',
      slots: [
        { label: 'allocation failure', description: 'queue 생성 실패로 볼지 DPAS만 disable할지 결정', tone: 'blue' },
        { label: 'NULL handling', description: 'show/store와 poll hook에서 q->dpas == NULL이면 빠르게 return', tone: 'slate' },
        { label: 'Part 4 scope', description: 'switch_enabled, switch_param*, interrupt mode는 제외', tone: 'violet' },
      ],
    },
  ],
  notes: [
    '이 카드의 목적은 구현을 멈추자는 뜻이 아니라 수동 구현 전에 확인할 체크리스트를 고정하는 것입니다.',
    '질문이 닫히면 Part 4 Minimal PAS-only card로 넘어가 patch 순서를 작성할 수 있습니다.',
  ],
};
