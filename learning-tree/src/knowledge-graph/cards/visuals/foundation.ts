import type { VisualModel } from '../../types';

export const repoOverviewVisual: VisualModel = {
  title: '학습 트리 한눈에 보기',
  description: 'Notion Part 번호가 아니라 이해 의존성 순서로 다시 배열한 지도입니다.',
  asciiArts: [
    {
      title: '학습 흐름도',
      art: [
        '   [ Part 1 ]                                                      ',
        '  build/boot                                                       ',
        '  safety loop                                                      ',
        '       |                                                           ',
        '       v                                                           ',
        '   [ kernel I/O completion model ]                                 ',
        '       |                                                           ',
        '       +---> blk-mq ---> ctx / bio / request / hctx / mq_ops       ',
        '       |                  |        |       |                       ',
        '       |                  v        v       v                       ',
        '       |               REQ_POLLED  tag   queue_num == bi_cookie    ',
        '       v                                                           ',
        '   [ Step 1: submit path ]  ----cookie---->  [ poll path ]         ',
        '       blk_mq_start_request()              bio_poll()              ',
        '                                            |                      ',
        '                                            v                      ',
        '                                blk_mq_poll -> blk_hctx_poll       ',
        '                                            |                      ',
        '                                            v                      ',
        '                                       nvme_poll() (driver)        ',
        '       |                                                           ',
        '       v                                                           ',
        '   [ Part 4 Minimal PAS ] -> [ Part 5 mode ] -> [ Part 6 IRQ risk ]',
        '       |                                                           ',
        '       +---------> [ Part 7 FIO validation ] <--------+            ',
      ].join('\n'),
      caption: '카드 영역(대괄호)은 학습 단계, 화살표는 다음에 봐야 할 카드입니다.',
    },
  ],
  metricTable: {
    title: 'Notion Part vs 학습 트리 카드',
    description: '구현 순서(Part)와 이해 순서(카드)는 다릅니다. 같은 행에 있어도 보는 각도가 다릅니다.',
    columns: ['주요 질문', '대표 카드'],
    rows: [
      { label: 'Part 1', cells: ['kernel을 안전하게 만질 수 있는가?', 'part1-build-boot-loop'], tone: 'blue' },
      { label: 'Part 2', cells: ['논문이 말하는 PAS/DPAS는 무엇인가?', 'paper-pas-core, paper-dpas-state-machine'], tone: 'violet' },
      { label: 'Part 3', cells: ['최신 kernel poll/IRQ path는?', 'path-submit-polled, path-poll-completion, path-interrupt-completion'], tone: 'teal' },
      { label: 'Part 4', cells: ['PAS hook을 가장 작게 어디에 넣는가?', 'concept-pas-sleep-before-poll, part4-minimal-pas'], tone: 'amber' },
      { label: 'Part 5', cells: ['mode switching을 어떻게 표현하는가?', 'part5-mode-switching, concept-dpas-mode'], tone: 'violet' },
      { label: 'Part 6', cells: ['true interrupt mode가 가능한가?', 'part6-interrupt-mode, risk-interrupt-submission'], tone: 'rose' },
      { label: 'Part 7', cells: ['실제로 이득이 있는가?', 'part7-validation'], tone: 'slate' },
    ],
  },
  notes: [
    '왼쪽 사이드바의 "학습 경로" 탭에서 다른 진입점도 골라볼 수 있습니다.',
    '카드를 클릭하면 같은 카드가 그래프 중앙으로 옮겨가고 연결 관계가 강조됩니다.',
  ],
};

export const buildLoopVisual: VisualModel = {
  title: 'Part 1 build/boot safety loop',
  description: 'DPAS 코드를 넣기 전에 kernel을 수정하고 되돌릴 수 있는 작업 루프를 먼저 검증합니다.',
  flowSteps: [
    { title: 'source 준비', description: 'WSL Linux filesystem 안에 upstream/stable kernel과 DPAS artifact를 나란히 둡니다.', tone: 'blue' },
    { title: 'vanilla build', description: '수정 없는 kernel이 bzImage/modules까지 빌드되는지 먼저 확인합니다.', tone: 'teal' },
    { title: 'smoke patch', description: 'block/blk-mq.c에 pr_info_once() 같은 되돌리기 쉬운 로그를 넣고 재빌드합니다.', tone: 'amber' },
    { title: 'log와 복구', description: 'build log, patch, config, dmesg를 남기고 실패 시 이전 kernel로 돌아갈 경로를 확인합니다.', tone: 'rose' },
  ],
  asciiArts: [
    {
      title: '안전 루프 (loop)',
      art: [
        '   +-------------+     +-------------+     +---------------+',
        '   |  patch 작성 | --> |  make/build | --> |  boot or chk  |',
        '   +-------------+     +-------------+     +---------------+',
        '          ^                                       |        ',
        '          |                                       v        ',
        '   +-------------+     +-------------+     +---------------+',
        '   |  rollback   | <-- |  log/dmesg  | <-- |  smoke result |',
        '   +-------------+     +-------------+     +---------------+',
      ].join('\n'),
      caption: '실패해도 항상 이전 kernel로 돌아올 수 있는 사이클이어야 합니다.',
    },
  ],
  comparison: {
    title: '환경 분리: WSL vs Bare-metal',
    description: '한 환경에서 모든 것을 하려고 하면 코드 분석과 성능 측정이 섞입니다.',
    leftLabel: 'WSL (개발 루프)',
    rightLabel: 'Bare-metal (검증)',
    leftTone: 'teal',
    rightTone: 'amber',
    rows: [
      { label: '용도', left: '코드 리딩, patch 정리, compile check', right: 'NVMe polling/interrupt 성능 측정' },
      { label: 'kernel boot', left: '연습용 (성능 신호로 쓰면 안 됨)', right: '실제 DPAS 동작 측정 환경' },
      { label: 'NVMe', left: '직접 다루지 않음', right: '실제 device, irq affinity 설정' },
      { label: '결과 활용', left: '"빌드 가능 / 부팅 가능" 확인', right: 'FIO percentile, CPU%, IOPS' },
    ],
  },
  notes: [
    'WSL은 코드 리딩, patch 정리, compile check에 적합합니다.',
    'NVMe polling/interrupt 성능 검증은 bare-metal Linux에서 해야 합니다.',
    '1단계 성공 문장은 "DPAS가 빠르다"가 아니라 "수정 후 되돌릴 수 있다"입니다.',
  ],
};

export const completionModelVisual: VisualModel = {
  title: 'Interrupt completion vs Polled completion',
  description: '같은 NVMe I/O라도 완료를 알리는 방법이 다르면 CPU/latency tradeoff가 완전히 달라집니다.',
  asciiArts: [
    {
      title: 'Interrupt 방식',
      art: [
        '  app                                                      ',
        '   |  read()                                               ',
        '   v                                                       ',
        '  block layer  --submit-->  NVMe SQ                        ',
        '   |                          |                            ',
        '   |  (sleep/wait)            v                            ',
        '   |                       device                          ',
        '   |                          |  완료 시 IRQ 발생          ',
        '   |  <----- IRQ handler ---- +                            ',
        '   |   wake up app                                         ',
        '   v                                                       ',
        '  app  resumes                                             ',
      ].join('\n'),
      caption: 'CPU는 sleep, device가 IRQ로 완료를 알립니다.',
    },
    {
      title: 'Polled 방식',
      art: [
        '  app  io_uring IOPOLL / RWF_HIPRI                         ',
        '   |                                                       ',
        '   v                                                       ',
        '  block layer  --submit-->  NVMe poll SQ                   ',
        '   |                          |                            ',
        '   v                          v                            ',
        '  CPU loops:               device                          ',
        '    bio_poll()                |  완료 -> CQ entry          ',
        '    -> blk_mq_poll()          v                            ',
        '    -> blk_hctx_poll()    NVMe poll CQ <----- CPU 직접 확인',
        '    -> nvme_poll()                                         ',
        '   |                                                       ',
        '   v                                                       ',
        '  완료 처리 후 return                                       ',
      ].join('\n'),
      caption: 'CPU가 직접 CQ를 보면서 IRQ 없이 완료를 잡습니다.',
    },
  ],
  comparison: {
    title: '두 방식의 트레이드오프',
    leftLabel: 'Interrupt',
    rightLabel: 'Polled',
    leftTone: 'rose',
    rightTone: 'teal',
    rows: [
      { label: '완료 통지', left: 'device가 IRQ를 발생', right: 'CPU가 CQ를 직접 확인' },
      { label: 'CPU', left: '대부분 sleep, 깨어날 때 비용', right: '계속 polling -> CPU 100%' },
      { label: 'latency', left: 'IRQ 처리 비용 + context switch', right: '아주 낮음 (us 수준)' },
      { label: '강점', left: 'CPU 효율, 다중 작업', right: '낮은 tail latency' },
      { label: 'DPAS 위치', left: 'Part 6 interrupt mode 후보', right: 'Part 4/5 PAS/DPAS 본진' },
    ],
  },
  notes: [
    'DPAS는 "polling이 빠르지만 CPU가 비싸다"는 두 번째 칸의 약점을 줄이려는 연구입니다.',
    '둘은 mode 전환의 양 끝이며, DPAS는 사이를 동적으로 오가는 모델로 볼 수 있습니다.',
  ],
};

export const blkMqStructureVisual: VisualModel = {
  title: 'blk-mq 한눈에 보기',
  description: 'CPU 쪽 ctx와 device 쪽 hctx를 잇는 다리이며, bio를 request로 바꿔 driver(NVMe 등)에 넘깁니다.',
  mermaid: {
    title: '계층 구조',
    code: [
      '%%{init: {"theme": "base", "flowchart": {"nodeSpacing": 28, "rankSpacing": 44, "padding": 16}, "themeVariables": {"background": "#f5f4ed", "mainBkg": "#fffdf8", "primaryColor": "#fffdf8", "primaryBorderColor": "#1b365d", "primaryTextColor": "#141413", "secondaryColor": "#faf9f5", "tertiaryColor": "#e8e6dc", "lineColor": "#1b365d", "edgeLabelBackground": "#faf9f5", "fontFamily": "Noto Serif KR, Noto Serif CJK KR, Source Han Serif KR, Nanum Myeongjo, Georgia, serif", "fontSize": "16px"}}}%%',
      'flowchart TD',
      '  app["app: read/write/io_uring"] --> bio["bio (block I/O 단위)"]',
      '  bio -- "blk_mq_submit_bio()" --> ctx["per-CPU ctx"]',
      '  ctx --> hctx0["hctx #0 (default)"]',
      '  ctx --> hctx1["hctx #1 (read)"]',
      '  ctx --> hctx2["hctx #2 (POLL)"]',
      '  hctx0 --> req0["request slot[tag]"]',
      '  hctx2 --> req2["request slot[tag]"]',
      '  req0 -- "mq_ops->queue_rq()" --> drv["NVMe driver"]',
      '  req2 -- "mq_ops->queue_rq()" --> drv',
      '  drv --> dev["NVMe device"]',
    ].join('\n'),
  },
  asciiArts: [
    {
      title: '핵심 객체 한 줄 요약',
      art: [
        '  bio       : block layer 입력 단위 (read/write 의도 + REQ_POLLED)  ',
        '  request   : driver 제출 단위 (어느 hctx, 그 안의 tag)             ',
        '  ctx       : per-CPU software context                              ',
        '  hctx      : hardware queue context (queue_num = poll cookie)      ',
        '  tag       : 한 hctx 안의 request slot 번호 (cookie != tag)        ',
        '  mq_ops    : driver callback 모음 (queue_rq, poll, complete...)    ',
      ].join('\n'),
    },
  ],
  notes: [
    'ctx와 hctx는 다릅니다. CPU별 ctx 여러 개가 하나의 hctx로 묶일 수 있습니다.',
    'driver는 mq_ops를 통해서만 호출됩니다. 그래서 PAS hook을 mq_ops 위(blk_mq_poll)에 두면 일반성을 유지할 수 있습니다.',
  ],
};

export const bioVisual: VisualModel = {
  title: 'bio 구조 (polled I/O 관점)',
  description: 'bio는 block I/O의 입력 단위입니다. polled I/O에서는 bi_opf의 REQ_POLLED와 bi_cookie가 핵심입니다.',
  asciiArts: [
    {
      title: 'struct bio 핵심 필드',
      art: [
        ' +------------------------------------------------------------+ ',
        ' |  struct bio                                                | ',
        ' |  +-------------------+  +-----------------------------+   | ',
        ' |  | bi_iter           |  | bi_opf  : op + flags        |   | ',
        ' |  |  - bi_sector      |  |   ex) REQ_OP_READ           |   | ',
        ' |  |  - bi_size (len)  |  |       | REQ_POLLED <-- 핵심 |   | ',
        ' |  +-------------------+  |       | REQ_HIPRI 계열      |   | ',
        ' |                         +-----------------------------+   | ',
        ' |  +-------------------+  +-----------------------------+   | ',
        ' |  | bi_io_vec[]       |  | bi_cookie                   |   | ',
        ' |  |  - 데이터 페이지  |  |   == hctx->queue_num         |   | ',
        ' |  +-------------------+  |   submit 후에 채워짐         |   | ',
        ' |                         |   초기값: BLK_QC_T_NONE(-1) |   | ',
        ' |                         +-----------------------------+   | ',
        ' +------------------------------------------------------------+ ',
      ].join('\n'),
      caption: 'bi_cookie는 "이 bio를 poll하려면 어느 hctx를 봐야 하나"를 가리키는 번호입니다.',
    },
  ],
  notes: [
    'bio는 driver에 직접 제출되는 단위가 아닙니다. blk-mq가 request로 바꿉니다.',
    'REQ_POLLED가 없으면 보통의 IRQ completion 경로를 탑니다.',
  ],
};

export const requestVisual: VisualModel = {
  title: 'request 구조 (driver 제출 단위)',
  description: 'request는 blk-mq가 driver에 넘기는 단위입니다. mq_hctx와 tag 두 가지가 핵심입니다.',
  asciiArts: [
    {
      title: 'struct request 핵심 필드',
      art: [
        ' +------------------------------------------------------------+ ',
        ' |  struct request                                            | ',
        ' |  +-----------------+  +---------------------------------+ | ',
        ' |  | mq_hctx         |  | tag                             | | ',
        ' |  |   * 어느 hctx   |  |   * 그 hctx 안 몇 번째 slot      | | ',
        ' |  |   에 묶였나     |  |   * unique within hctx           | | ',
        ' |  +-----------------+  +---------------------------------+ | ',
        ' |  +-----------------+  +---------------------------------+ | ',
        ' |  | cmd_flags       |  | bio (chain head)                | | ',
        ' |  |   * REQ_OP_*    |  |   * 이 request를 만든 bio들     | | ',
        ' |  |   * REQ_POLLED  |  +---------------------------------+ | ',
        ' |  +-----------------+                                      | ',
        ' +------------------------------------------------------------+ ',
      ].join('\n'),
      caption: 'blk_mq_start_request() 시점에 bio->bi_cookie = mq_hctx->queue_num이 저장됩니다.',
    },
  ],
  comparison: {
    title: 'request의 두 번호: cookie vs tag',
    leftLabel: 'mq_hctx->queue_num (= bi_cookie)',
    rightLabel: 'request->tag',
    leftTone: 'teal',
    rightTone: 'rose',
    rows: [
      { label: '의미', left: 'poll 대상 hctx index', right: 'hctx 안 request slot 번호' },
      { label: '주소 체계', left: 'q->queue_hw_ctx[N]', right: 'hctx->tags->bitmap_tags' },
      { label: '쓰는 곳', left: 'bio_poll(), blk_mq_poll()', right: 'driver request lookup' },
      { label: 'unique', left: 'request_queue 안에서', right: 'hctx 안에서' },
    ],
  },
  notes: [
    'tag로 request를 직접 lookup하는 것은 driver 내부 로직이지 poll path 입구가 아닙니다.',
    'request는 issue 시점에 cookie를 bio에 다시 써 줍니다 (역방향 link).',
  ],
};

export const hctxVisual: VisualModel = {
  title: 'hctx (hardware context)',
  description: 'blk-mq가 device의 hardware queue를 다루기 위해 들고 있는 per-queue 구조입니다.',
  asciiArts: [
    {
      title: 'request_queue → hctx → driver queue',
      art: [
        '  request_queue                                                 ',
        '   |                                                            ',
        '   v                                                            ',
        '  queue_hw_ctx[]    ── 인덱스가 곧 cookie ──>                  ',
        '  +---+---+---+---+                                             ',
        '  | 0 | 1 | 2 | 3 |   <- bi_cookie = N 이면 hctx[N]을 본다      ',
        '  +---+---+---+---+                                             ',
        '   |   |   |   |                                                ',
        '   v   v   v   v                                                ',
        '  hctx0 (default)        type=DEFAULT                           ',
        '  hctx1 (read)           type=READ                              ',
        '  hctx2 (POLL)           type=HCTX_TYPE_POLL  <-- polled I/O    ',
        '  hctx3 (POLL)           type=HCTX_TYPE_POLL                    ',
        '   |                                                            ',
        '   +-- mq_ops->poll(hctx, iob) -> driver poll callback          ',
      ].join('\n'),
      caption: 'REQ_POLLED bio는 HCTX_TYPE_POLL hctx로 들어가고, 그 hctx의 queue_num이 cookie가 됩니다.',
    },
  ],
  notes: [
    'CPU 1개 = hctx 1개가 아닙니다. CPU별 ctx 여러 개가 하나의 hctx로 묶일 수 있습니다.',
    'HCTX_TYPE_POLL은 "poll 전용 hctx 종류"이지 PAS의 mode 이름이 아닙니다.',
  ],
};

export const reqPolledVisual: VisualModel = {
  title: 'REQ_POLLED가 가는 길',
  description: '사용자 의도(IOCB_HIPRI 등)가 어떻게 bio flag, hctx 선택, cookie까지 이어지는지 보입니다.',
  mermaid: {
    title: 'flag → queue 선택 → cookie 저장',
    code: [
      'flowchart TD',
      '  user["app: io_uring IOPOLL or RWF_HIPRI"] --> kiocb["kiocb.ki_flags |= IOCB_HIPRI"]',
      '  kiocb --> bio_set["bio->bi_opf |= REQ_POLLED"]',
      '  bio_set --> submit["blk_mq_submit_bio()"]',
      '  submit -->|REQ_POLLED 있음| pollq["HCTX_TYPE_POLL hctx 선택"]',
      '  submit -->|REQ_POLLED 없음| irqq["DEFAULT hctx 선택 (IRQ 경로)"]',
      '  pollq --> start["blk_mq_start_request()"]',
      '  start --> cookie["bio->bi_cookie = hctx->queue_num"]',
      '  cookie --> ready["poll path가 사용할 준비 완료"]',
    ].join('\n'),
  },
  notes: [
    'REQ_POLLED는 단순 표시가 아니라 queue 선택까지 바꿉니다.',
    'completion 단계에서만 poll을 끊는다고 해서 이미 POLL hctx로 들어간 I/O가 IRQ I/O가 되지는 않습니다 (interrupt risk의 출발점).',
  ],
};

export const ctxVisual: VisualModel = {
  title: 'blk_mq_ctx (software context)',
  description: 'CPU별 software queue입니다. submit 시점에 현재 CPU의 ctx가 선택되고, op flag에 따라 어느 hctx로 갈지 ctx->hctxs[]로 결정됩니다.',
  asciiArts: [
    {
      title: 'struct blk_mq_ctx 핵심 필드 (block/blk-mq.h)',
      art: [
        ' +------------------------------------------------------------+ ',
        ' |  struct blk_mq_ctx                                         | ',
        ' |  +------------------+  +--------------------------------+ | ',
        ' |  | cpu              |  | hctxs[HCTX_MAX_TYPES]          | | ',
        ' |  |  (이 ctx가       |  |   [DEFAULT] -> hctx #0         | | ',
        ' |  |   붙은 CPU)      |  |   [READ]    -> hctx #1         | | ',
        ' |  +------------------+  |   [POLL]    -> hctx #2 (POLL)  | | ',
        ' |  +------------------+  +--------------------------------+ | ',
        ' |  | rq_lists[]       |  | queue (request_queue *)        | | ',
        ' |  |  per-type pending|  |                                | | ',
        ' |  +------------------+  +--------------------------------+ | ',
        ' +------------------------------------------------------------+ ',
      ].join('\n'),
      caption: 'ctx는 CPU 쪽, hctx는 device queue 쪽입니다. request->mq_ctx와 request->mq_hctx가 둘 다 존재합니다.',
    },
  ],
  mermaid: {
    title: 'ctx -> hctx 매핑',
    code: [
      'flowchart TD',
      '  cpu["submit CPU"] --> ctx["blk_mq_ctx (per-CPU)"]',
      '  bio["bio->bi_opf"] --> map["blk_mq_get_hctx_type(opf)"]',
      '  map -->|REQ_POLLED| poll["ctx->hctxs[HCTX_TYPE_POLL]"]',
      '  map -->|REQ_OP_READ| read["ctx->hctxs[HCTX_TYPE_READ]"]',
      '  map -->|else| def["ctx->hctxs[HCTX_TYPE_DEFAULT]"]',
      '  poll --> hctx["blk_mq_hw_ctx"]',
      '  read --> hctx',
      '  def --> hctx',
    ].join('\n'),
  },
  notes: [
    'blk_mq_map_queue(opf, ctx)는 ctx->hctxs[blk_mq_get_hctx_type(opf)]를 반환합니다 (block/blk-mq.h).',
    'CPU 1개 = hctx 1개가 아닙니다. 여러 CPU ctx가 하나의 hctx로 매핑될 수 있습니다.',
    'DPAS state를 per-CPU ctx에 둘지 per-hctx에 둘지는 Part 4/5 설계 선택입니다.',
  ],
};

export const mqOpsVisual: VisualModel = {
  title: 'blk_mq_ops (driver callback table)',
  description: 'block layer가 driver를 호출하는 유일한 인터페이스입니다. submit은 queue_rq, completion 확인은 poll, interrupt 완료는 complete를 탑니다.',
  asciiArts: [
    {
      title: 'struct blk_mq_ops 핵심 callback (include/linux/blk-mq.h)',
      art: [
        '  struct blk_mq_ops {',
        '      queue_rq(hctx, bd)   // submit: request -> device SQ',
        '      poll(hctx, iob)       // poll path: CQ 확인',
        '      complete(rq)          // interrupt path: request 완료',
        '      timeout(rq)           // request timeout',
        '      init_hctx / exit_hctx // queue setup/teardown',
        '  };',
        '  ',
        '  NVMe PCI (drivers/nvme/host/pci.c):',
        '      .queue_rq = nvme_queue_rq',
        '      .poll     = nvme_poll',
        '      // complete는 blk-mq generic path 사용',
      ].join('\n'),
      caption: 'PAS hook을 driver poll 안에 넣으면 NVMe 전용이 됩니다. block layer 공통 지점(blk_mq_poll)이 일반성 면에서 유리합니다.',
    },
  ],
  comparison: {
    title: 'mq_ops callback vs DPAS 관심사',
    leftLabel: 'submit side',
    rightLabel: 'completion side',
    leftTone: 'blue',
    rightTone: 'teal',
    rows: [
      { label: 'callback', left: 'queue_rq()', right: 'poll() / complete()' },
      { label: '호출 시점', left: 'request issue', right: 'CPU poll 또는 IRQ/softirq' },
      { label: 'NVMe 구현', left: 'nvme_queue_rq()', right: 'nvme_poll() / blk_mq_complete_request()' },
      { label: 'DPAS hook', left: 'REQ_POLLED 제어 (Part 6)', right: 'sleep-before-poll (Part 4/5)' },
    ],
  },
  notes: [
    'blk_hctx_poll()은 q->mq_ops->poll(hctx, iob)만 반복 호출합니다. driver가 poll을 구현하지 않으면 polled I/O가 동작하지 않습니다.',
    'blk_mq_can_poll(q)는 BLK_FEAT_POLL과 HCTX_TYPE_POLL queue 수가 모두 있어야 true입니다 (block/blk-mq.h).',
  ],
};
