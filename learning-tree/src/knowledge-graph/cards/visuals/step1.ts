import type { VisualModel } from '../../types';

export const submitPollVisual: VisualModel = {
  title: 'submit 시점과 poll 시점 분리',
  description: 'bi_cookie는 submit 때 저장되고, poll 때 다시 읽혀 hctx를 찾습니다.',
  flowSteps: [
    { title: 'submit', description: 'bio가 request로 묶이고 polled hctx가 선택됩니다.', tone: 'blue' },
    { title: 'cookie 저장', description: 'blk_mq_start_request()가 bio->bi_cookie = hctx->queue_num을 저장합니다.', tone: 'teal' },
    { title: 'poll', description: 'bio_poll()이 cookie를 읽고 blk_mq_poll()로 넘깁니다.', tone: 'amber' },
    { title: 'driver poll', description: 'blk_hctx_poll()이 mq_ops->poll(), NVMe에서는 nvme_poll()로 내려갑니다.', tone: 'violet' },
  ],
  slotGroups: [
    {
      title: 'bi_cookie != tag',
      description: '두 값은 같은 정수가 아니라 서로 다른 주소 체계입니다.',
      slots: [
        { label: 'bi_cookie', description: 'hctx->queue_num, poll queue index', tone: 'teal' },
        { label: 'tag', description: 'hctx 안의 request slot 번호', tone: 'rose' },
        { label: '초기값', description: 'BLK_QC_T_NONE(-1), poll 불가', tone: 'amber' },
      ],
    },
  ],
  notes: [
    'submit 시점은 device에 I/O를 내보내기 위해 request를 시작하는 시점입니다.',
    'poll 시점은 완료 interrupt를 기다리는 대신 CPU가 completion queue를 직접 확인하는 시점입니다.',
  ],
};

export const cookieTagVisual: VisualModel = {
  title: 'bi_cookie != tag (가장 큰 오해)',
  description: '두 정수는 서로 다른 주소 체계입니다. cookie는 어느 hctx, tag는 그 안 어느 slot.',
  asciiArts: [
    {
      title: '같은 7이라도 의미가 다르다',
      art: [
        '  bi_cookie = 7   --->  q->queue_hw_ctx[7]  =  hctx #7         ',
        '                                              (poll 대상 큐)   ',
        '                                                                ',
        '  request->tag = 7 --->  hctx->tags[7]      =  request slot #7 ',
        '                                              (그 큐 안의 slot)',
        '                                                                ',
        '  즉, bi_cookie 와 tag 는 서로 다른 배열의 인덱스이다.          ',
      ].join('\n'),
    },
  ],
  comparison: {
    title: 'cookie vs tag',
    leftLabel: 'bi_cookie',
    rightLabel: 'tag',
    leftTone: 'teal',
    rightTone: 'rose',
    rows: [
      { label: '값의 의미', left: 'hctx 번호', right: 'request slot 번호' },
      { label: '저장 위치', left: 'bio->bi_cookie', right: 'request->tag' },
      { label: '언제 정해짐', left: 'blk_mq_start_request()', right: 'request 할당 시 (tag alloc)' },
      { label: '소비 위치', left: 'bio_poll/blk_mq_poll', right: 'driver의 request lookup' },
      { label: '초기값', left: 'BLK_QC_T_NONE (-1)', right: '없음 (alloc 못 받음)' },
    ],
  },
  notes: [
    '한 번이라도 "tag = cookie"로 읽으면 poll path 전체 해석이 어긋납니다.',
    'BLK_QC_T_NONE은 "poll할 대상이 없다"는 신호로 해석합니다.',
  ],
};

export const submitPathVisual: VisualModel = {
  title: 'Submit path (polled I/O)',
  description: 'I/O가 device로 나가기 전에 REQ_POLLED, hctx, cookie가 정해지는 시점입니다.',
  mermaid: {
    title: 'submit 함수 호출 흐름',
    code: [
      'flowchart TD',
      '  app["read/write w/ HIPRI"] --> fops["block/fops.c\\nIOCB_HIPRI -> bi_opf |= REQ_POLLED"]',
      '  fops --> submit["blk_mq_submit_bio()\\n(block/blk-mq.c)"]',
      '  submit --> pick["hctx 선택\\nHCTX_TYPE_POLL if REQ_POLLED"]',
      '  pick --> start["blk_mq_start_request()"]',
      '  start --> cookie["bio->bi_cookie = mq_hctx->queue_num"]',
      '  start --> drv["driver mq_ops->queue_rq()"]',
      '  drv --> dev["NVMe device SQ"]',
    ].join('\n'),
  },
  asciiArts: [
    {
      title: '핵심 코드 위치',
      art: [
        '  block/fops.c        : IOCB_HIPRI -> REQ_POLLED              ',
        '  block/blk-mq.h      : HCTX_TYPE_POLL 선택 매크로              ',
        '  block/blk-mq.c      : blk_mq_submit_bio(), blk_mq_start_request()',
        '  drivers/nvme/host/  : NVMe queue_rq 구현                       ',
      ].join('\n'),
    },
  ],
  notes: [
    'submit path는 "완료를 확인"하지 않습니다. 나중에 poll path가 쓸 단서를 남깁니다.',
    'cookie는 submit 끝에서 bio에 저장되므로, 그전에 bio_poll()을 부르면 BLK_QC_T_NONE이 보일 수 있습니다.',
  ],
};

export const pollPathVisual: VisualModel = {
  title: 'Poll completion path',
  description: 'submit 끝난 I/O가 끝났는지 CPU가 직접 확인하러 내려가는 함수 호출 사슬입니다.',
  mermaid: {
    title: 'poll 함수 호출 사슬',
    code: [
      'flowchart TD',
      '  user["io_uring/aio poll"] --> bp["bio_poll(bio, iob, flags)\\n(block/blk-core.c)"]',
      '  bp -->|cookie == NONE| skip["return 0 (poll 불가)"]',
      '  bp -->|cookie OK| mqp["blk_mq_poll(q, cookie, iob, flags)\\n(block/blk-mq.c)"]',
      '  mqp --> hctxlu["q->queue_hw_ctx[cookie] -> hctx"]',
      '  hctxlu --> hp["blk_hctx_poll(q, hctx, iob, flags)"]',
      '  hp --> loop["loop: mq_ops->poll() + cpu_relax()"]',
      '  loop --> nvme["nvme_poll(hctx, iob)\\n(drivers/nvme/host/pci.c)"]',
      '  nvme --> cq["NVMe CQ entry 처리 -> ret > 0"]',
    ].join('\n'),
  },
  notes: [
    'PAS sleep-before-poll hook을 어디에 넣을지는 이 4개 함수 중 하나를 고르는 문제입니다.',
    'cpu_relax()는 sleep이 아니므로 기본 path에는 PAS가 아직 없습니다.',
  ],
};

export const bioPollVisual: VisualModel = {
  title: 'bio_poll() 함수 흐름',
  description: 'block layer의 polled completion 진입점입니다. cookie를 꺼내 blk-mq로 넘깁니다.',
  asciiArts: [
    {
      title: 'bio_poll() 내부 의사코드',
      art: [
        '  bio_poll(bio, iob, flags):',
        '  ',
        '    cookie = bio->bi_cookie',
        '    if (cookie == BLK_QC_T_NONE)',
        '        return 0            // poll 대상 없음',
        '    ',
        '    q = bdev_get_queue(bio->bi_bdev)',
        '    if (!q || !blk_queue_poll(q))',
        '        return 0            // queue가 poll 지원 안 함',
        '    ',
        '    return blk_mq_poll(q, cookie, iob, flags)',
        '    //      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
        '    //      cookie를 blk-mq 쪽으로 전달',
      ].join('\n'),
      caption: 'bio_poll()은 entry guard 역할이며 실제 polling은 blk_mq_poll()이 수행합니다.',
    },
  ],
  notes: [
    'bio_poll()에서 hctx나 request에 직접 접근하지 못합니다.',
    'PAS hook 후보 #1이지만 state 관리가 필요하면 불리합니다.',
  ],
};

export const blkMqPollVisual: VisualModel = {
  title: 'blk_mq_poll() - PAS hook 유력 후보',
  description: 'cookie로 hctx를 찾아 blk_hctx_poll()로 넘기는 지점. 일반성과 hctx 접근이 모두 가능합니다.',
  asciiArts: [
    {
      title: 'blk_mq_poll() 내부 의사코드',
      art: [
        '  blk_mq_poll(q, cookie, iob, flags):',
        '  ',
        '    hctx = q->queue_hw_ctx[cookie]',
        '    //      ^^^^^^^^^^^^^^^^^^^^^ cookie = hctx index!',
        '    ',
        '    // [PAS hook 삽입 후보 위치]',
        '    // if (pas_should_sleep(hctx)) schedule_timeout(ns);',
        '    ',
        '    ret = blk_hctx_poll(q, hctx, iob, flags)',
        '    return ret',
      ].join('\n'),
      caption: 'hctx에 접근 가능하면서도 NVMe에 종속되지 않아 PAS hook 1차 후보입니다.',
    },
  ],
  metricTable: {
    title: 'hook 후보 비교',
    description: 'blk_mq_poll() vs 다른 위치',
    columns: ['장점', '주의점'],
    rows: [
      { label: 'blk_mq_poll()', cells: ['hctx 접근 O, driver 독립적', 'hot path overhead 관리 필요'], tone: 'teal' },
      { label: 'bio_poll()', cells: ['user-facing 진입점', 'hctx/request 접근 X'], tone: 'blue' },
      { label: 'blk_hctx_poll()', cells: ['loop 내부, 세밀 제어', '계층 책임 혼란 가능'], tone: 'amber' },
      { label: 'nvme_poll()', cells: ['CQ에 가장 가까움', 'NVMe 전용, 일반성 X'], tone: 'rose' },
    ],
  },
  notes: [
    'Part 3 Step 1 결론: blk_mq_poll()이 1차 후보, bio_poll()이 2차 후보입니다.',
    'Part 4에서 이 판단을 실제 로컬 최신 코드와 대조해야 합니다.',
  ],
};

export const blkHctxPollVisual: VisualModel = {
  title: 'blk_hctx_poll() - 실제 polling loop',
  description: 'driver의 poll callback을 반복 호출하는 busy loop이며, 여기에는 PAS sleep이 없습니다.',
  asciiArts: [
    {
      title: 'blk_hctx_poll() 의사코드',
      art: [
        '  blk_hctx_poll(q, hctx, iob, flags):',
        '  ',
        '    for (;;) {',
        '        ret = q->mq_ops->poll(hctx, iob)  // driver poll',
        '        if (ret > 0)',
        '            break    // completion 찾음!',
        '        ',
        '        if (signal_pending | need_resched)',
        '            break    // preemption check',
        '        ',
        '        cpu_relax()  // <-- sleep이 아님! spin hint일 뿐',
        '    }',
        '    return ret',
      ].join('\n'),
      caption: 'cpu_relax()는 CPU를 잠깐 쉬게 하는 것이 아니라 busy loop의 전력 hint입니다.',
    },
  ],
  timeline: {
    title: 'polling loop의 시간축 예시',
    description: '기본 path에서는 CQ에 완료가 올 때까지 CPU가 100% 회전합니다.',
    rows: [
      {
        label: 'Continuous Polling (CP)',
        description: 'PAS 없는 기본 동작',
        segments: [
          { label: 'poll', duration: '1', state: 'busy' },
          { label: 'poll', duration: '1', state: 'busy' },
          { label: 'poll', duration: '1', state: 'busy' },
          { label: 'poll', duration: '1', state: 'busy' },
          { label: 'done', duration: '1', state: 'done' },
        ],
      },
      {
        label: 'PAS (sleep-before-poll)',
        description: 'DPAS Part 4 목표 동작',
        segments: [
          { label: 'sleep', duration: '3', state: 'sleep' },
          { label: 'poll', duration: '1', state: 'busy' },
          { label: 'done', duration: '1', state: 'done' },
        ],
      },
    ],
    legend: [
      { state: 'busy', label: 'CPU busy polling' },
      { state: 'sleep', label: 'PAS sleep (CPU idle)' },
      { state: 'done', label: 'completion 확인' },
    ],
  },
  notes: [
    'cpu_relax() = PAS sleep이라고 읽으면 안 됩니다.',
    'PAS가 작동하려면 이 loop에 진입하기 전(blk_mq_poll) 또는 loop 내에서 별도 sleep 삽입이 필요합니다.',
  ],
};

export const nvmePollVisual: VisualModel = {
  title: 'nvme_poll() - driver 끝단',
  description: 'blk_hctx_poll()이 부르는 NVMe driver callback으로, 실제 completion queue를 확인합니다.',
  asciiArts: [
    {
      title: 'nvme_poll() 위치',
      art: [
        '  blk_hctx_poll()   q->mq_ops->poll(hctx, iob)',
        '       |                    |',
        '       v                    v',
        '  nvme_poll(hctx, iob)',
        '       |',
        '       v',
        '  nvme_poll_cq(nvmeq)  // NVMe Completion Queue 확인',
        '       |',
        '       +-- CQ entry 있음 -> nvme_handle_cqe() -> request 완료',
        '       +-- CQ entry 없음 -> return 0',
      ].join('\n'),
      caption: 'NVMe CQ는 device가 I/O 완료를 알려주는 하드웨어 큐입니다.',
    },
  ],
  notes: [
    'nvme_poll()은 NVMe 전용이라 여기에 hook을 넣으면 다른 block device에서 동작하지 않습니다.',
    'DPAS 1차 port는 NVMe를 실험 대상으로 쓰되 hook은 상위(blk_mq_poll)에 두는 전략이 유력합니다.',
  ],
};

export const startRequestVisual: VisualModel = {
  title: 'blk_mq_start_request() - cookie 저장 지점',
  description: 'driver가 request를 실제 issue하기 직전에 호출합니다. polled bio라면 여기서 bi_cookie = hctx->queue_num이 저장됩니다.',
  asciiArts: [
    {
      title: '최신 kernel 코드 (block/blk-mq.c:1368-1393)',
      art: [
        '  void blk_mq_start_request(struct request *rq) {',
        '      ...',
        '      WRITE_ONCE(rq->state, MQ_RQ_IN_FLIGHT);',
        '      rq->mq_hctx->tags->rqs[rq->tag] = rq;',
        '      ',
        '      if (rq->bio && rq->bio->bi_opf & REQ_POLLED)',
        '          WRITE_ONCE(rq->bio->bi_cookie,',
        '                     rq->mq_hctx->queue_num);  // <-- 핵심!',
        '  }',
      ].join('\n'),
      caption: 'cookie는 bio 생성 시점이 아니라 request start 시점에 채워집니다.',
    },
  ],
  flowSteps: [
    { title: 'request 할당', description: 'blk_mq_get_new_requests()에서 tag와 mq_hctx가 정해짐', tone: 'blue' },
    { title: 'driver issue', description: 'nvme_queue_rq() 등이 SQ에 command 기록', tone: 'amber' },
    { title: 'start_request', description: 'blk_mq_start_request() 호출 -> bi_cookie 저장', tone: 'teal' },
    { title: 'poll 준비 완료', description: '이후 bio_poll()이 cookie로 hctx lookup 가능', tone: 'violet' },
  ],
  notes: [
    'start_request 전에 bio_poll()을 호출하면 bi_cookie가 BLK_QC_T_NONE일 수 있습니다.',
    'cookie 값은 rq->mq_hctx->queue_num이며 request->tag와 무관합니다.',
    'NVMe nvme_queue_rq()는 prep 후 SQ doorbell을 치지만, cookie 저장은 block layer start_request에서 일어납니다.',
  ],
};

export const interruptCompletionVisual: VisualModel = {
  title: 'Interrupt completion path',
  description: 'REQ_POLLED가 없는 일반 I/O는 device IRQ -> driver -> blk_mq_complete_request() -> mq_ops->complete() 또는 softirq 경로로 완료됩니다.',
  mermaid: {
    title: 'IRQ completion 흐름',
    code: [
      'flowchart TD',
      '  dev["NVMe device IRQ"] --> isr["driver IRQ handler"]',
      '  isr --> cq["CQ entry 처리"]',
      '  cq --> complete["blk_mq_complete_request(rq)\\n(block/blk-mq.c)"]',
      '  complete -->|same CPU/cache| local["mq_ops->complete(rq)"]',
      '  complete -->|remote CPU| ipi["IPI + BLOCK_SOFTIRQ"]',
      '  ipi --> softirq["blk_done_softirq()\\n-> mq_ops->complete(rq)"]',
      '  local --> endio["bio_endio() -> user wake"]',
      '  softirq --> endio',
    ].join('\n'),
  },
  comparison: {
    title: 'interrupt vs polled completion',
    leftLabel: 'Interrupt (DEFAULT hctx)',
    rightLabel: 'Polled (POLL hctx)',
    leftTone: 'rose',
    rightTone: 'teal',
    rows: [
      { label: 'submit queue', left: 'HCTX_TYPE_DEFAULT', right: 'HCTX_TYPE_POLL' },
      { label: '완료 통지', left: 'IRQ + softirq', right: 'CPU가 mq_ops->poll()' },
      { label: 'CPU', left: '대부분 idle', right: 'busy poll (PAS 전)' },
      { label: '핵심 함수', left: 'blk_mq_complete_request()', right: 'bio_poll() -> blk_mq_poll()' },
    ],
  },
  notes: [
    'completion model 카드의 interrupt 쪽 실체입니다. poll path와 대칭으로 봐야 합니다.',
    'DPAS interrupt mode는 이 경로로 "돌아가야" 하지만, 이미 POLL hctx로 submit된 I/O는 별도 문제입니다 (interrupt risk).',
    'blk_mq_complete_request_remote()는 submit CPU와 다른 core에서 완료할 때 IPI를 사용합니다.',
  ],
};

export const ioUringIopollVisual: VisualModel = {
  title: 'io_uring IOPOLL 진입 경로',
  description: '사용자가 io_uring_setup(IORING_SETUP_IOPOLL)로 ring을 만들면 read/write path에서 IOCB_HIPRI -> REQ_POLLED -> iocb_bio_iopoll -> bio_poll()로 이어집니다.',
  mermaid: {
    title: 'io_uring -> block poll 연결',
    code: [
      'flowchart TD',
      '  setup["io_uring_setup(IORING_SETUP_IOPOLL)"] --> rw["io_uring/rw.c submit"]',
      '  rw --> hipri["kiocb->ki_flags |= IOCB_HIPRI"]',
      '  hipri --> fops["block/fops.c: bio->bi_opf |= REQ_POLLED"]',
      '  fops --> submit["blk_mq_submit_bio()"]',
      '  submit --> polluser["file->f_op->iopoll\\n= iocb_bio_iopoll"]',
      '  polluser --> bp["bio_poll(bio, iob, flags)"]',
      '  bp --> mqp["blk_mq_poll()"]',
    ].join('\n'),
  },
  asciiArts: [
    {
      title: '최신 kernel 코드 위치',
      art: [
        '  io_uring/rw.c:876-881',
        '    if (ctx->flags & IORING_SETUP_IOPOLL) {',
        '        kiocb->ki_flags |= IOCB_HIPRI;',
        '        ...',
        '    }',
        '  ',
        '  block/fops.c:381-384',
        '    if (iocb->ki_flags & IOCB_HIPRI) {',
        '        bio->bi_opf |= REQ_POLLED;',
        '        submit_bio(bio);',
        '        WRITE_ONCE(iocb->private, bio);  // poll용 bio 저장',
        '    }',
        '  ',
        '  block/blk-core.c:988-1017',
        '    iocb_bio_iopoll() -> bio_poll(bio, iob, flags)',
      ].join('\n'),
    },
  ],
  notes: [
    'FIO --ioengine=io_uring --hipri=1 실험은 이 경로를 탑니다.',
    'IOCB_HIPRI는 userspace RWF_HIPRI와 같은 bit입니다 (include/linux/fs.h).',
    'HYBRID_IOPOLL은 별도 flag로, Part 7 FIO 설계 시 일반 IOPOLL과 구분해야 합니다.',
  ],
};
