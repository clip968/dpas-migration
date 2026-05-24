import type { VisualModel } from '../../types';

export const reqPolledSubmitStep2Visual: VisualModel = {
  title: 'Step 2 전체 지도',
  description: 'poll completion path가 아니라 poll request가 만들어지는 submission path를 따라갑니다.',
  mermaid: {
    title: 'Step 2 카드 흐름',
    code: [
      'flowchart TD',
      '  a["1. userspace signal\\nRWF_HIPRI"] --> b["2. kiocb\\nIOCB_HIPRI"]',
      '  b --> c["3. bio flag\\nbio->bi_opf |= REQ_POLLED"]',
      '  c --> d["4. request flag\\nrq->cmd_flags"]',
      '  d --> e["5. queue routing\\nHCTX_TYPE_POLL"]',
      '  e --> f["6. Step 1 bridge\\nbio->bi_cookie"]',
      '  g["DPAS 5.18 comparison"] --> h["interrupt mode removes\\nIOCB_HIPRI / REQ_POLLED"]',
      '  h --> i["hook candidates\\nblock/fops.c + fs/iomap/direct-io.c"]',
    ].join('\n'),
  },
  asciiArts: [
    {
      title: 'Step 1과 Step 2의 경계',
      art: [
        '  [ Step 2: submission ]                         ',
        '  RWF_HIPRI -> IOCB_HIPRI -> REQ_POLLED -> POLL hctx',
        '                                      |           ',
        '                                      v           ',
        '                           bio->bi_cookie 저장     ',
        '                                      |           ',
        '                                      v           ',
        '  [ Step 1: completion ] bio_poll() -> blk_mq_poll()',
      ].join('\n'),
      caption: 'Step 2는 Step 1이 사용할 bio가 왜 poll 대상이 되었는지 설명합니다.',
    },
  ],
  notes: [
    '이 카드는 Step 2의 목차입니다. 세부 설명은 signal, propagation, DPAS 비교, hook 후보 카드로 나눕니다.',
    '현재 기준 source tree는 src/linux-upstream이고 kernelversion은 7.1.0-rc4입니다.',
  ],
};

export const step2KiocbHipriVisual: VisualModel = {
  title: 'RWF_HIPRI와 kiocb',
  description: 'userspace의 HIPRI 요청이 kernel 내부에서 kiocb->ki_flags의 IOCB_HIPRI로 보관됩니다.',
  mermaid: {
    title: 'userspace flag가 kernel flag로 들어오는 방식',
    code: [
      'flowchart TD',
      '  app["userspace\\npreadv2 / io_uring / direct I/O"] --> rwf["RWF_HIPRI\\ninclude/uapi/linux/fs.h"]',
      '  rwf --> vfs["VFS / file I/O setup"]',
      '  vfs --> kiocb["struct kiocb"]',
      '  kiocb --> flags["kiocb->ki_flags has IOCB_HIPRI"]',
      '  flags --> block["block/fops.c or fs/iomap/direct-io.c"]',
    ].join('\n'),
  },
  asciiArts: [
    {
      title: 'kiocb는 I/O 요청 설명서',
      art: [
        '  userspace RWF_HIPRI',
        '          |',
        '          v',
        '  kiocb',
        '  +--------------------------------+',
        '  | ki_filp   = target file        |',
        '  | ki_pos    = file offset        |',
        '  | ki_flags  = IOCB_HIPRI         |',
        '  | private   = bio pointer later  |',
        '  +--------------------------------+',
        '          |',
        '          v',
        '  block layer sees IOCB_HIPRI and marks bio REQ_POLLED',
      ].join('\n'),
      caption: 'Step 2에서 kiocb->ki_flags는 userspace HIPRI 의도가 kernel 내부로 들어온 자리입니다.',
    },
  ],
  metricTable: {
    title: '정의 확인',
    columns: ['현재 src 정의', '의미'],
    rows: [
      { label: 'RWF_HIPRI', cells: ['0x00000001', 'userspace-visible per-I/O hint'], tone: 'slate' },
      { label: 'IOCB_HIPRI', cells: ['(__force int) RWF_HIPRI', 'kernel 내부 kiocb flag'], tone: 'blue' },
      { label: 'ki_flags', cells: ['iocb->ki_flags', '이 I/O 요청의 옵션 저장소'], tone: 'teal' },
      { label: 'private', cells: ['iocb->private', '나중에 poll할 bio 포인터 저장'], tone: 'amber' },
    ],
  },
  notes: [
    'RWF_HIPRI와 IOCB_HIPRI는 같은 bit를 다른 계층 이름으로 부르는 구조입니다.',
    'kiocb를 모르면 block/fops.c의 if (iocb->ki_flags & IOCB_HIPRI)를 제대로 읽기 어렵습니다.',
  ],
};

export const step2FlagPropagationVisual: VisualModel = {
  title: 'bio flag가 request routing으로 전파됨',
  description: 'REQ_POLLED는 bio에 잠깐 붙는 표시가 아니라 request->cmd_flags와 hctx 선택까지 이어집니다.',
  mermaid: {
    title: 'bio->bi_opf에서 HCTX_TYPE_POLL까지',
    code: [
      'flowchart TD',
      '  kiocb["IOCB_HIPRI"] --> bio["bio->bi_opf |= REQ_POLLED"]',
      '  bio --> data["data.cmd_flags = bio->bi_opf"]',
      '  data --> rq["rq->cmd_flags = data->cmd_flags"]',
      '  rq --> type["blk_mq_get_hctx_type(opf)"]',
      '  type -->|REQ_POLLED| poll["HCTX_TYPE_POLL"]',
      '  type -->|no REQ_POLLED + READ| read["HCTX_TYPE_READ"]',
      '  type -->|otherwise| def["HCTX_TYPE_DEFAULT"]',
      '  poll --> start["blk_mq_start_request()"]',
      '  start --> cookie["bio->bi_cookie = rq->mq_hctx->queue_num"]',
    ].join('\n'),
  },
  comparison: {
    title: '두 flag의 책임 분리',
    leftLabel: 'IOCB_HIPRI',
    rightLabel: 'REQ_POLLED',
    leftTone: 'blue',
    rightTone: 'rose',
    rows: [
      { label: '위치', left: 'kiocb->ki_flags', right: 'bio->bi_opf / rq->cmd_flags' },
      { label: '의미', left: '상위 I/O가 HIPRI 의도를 가짐', right: 'block layer가 poll queue로 routing해야 함' },
      { label: '생성 계층', left: 'VFS / I/O setup', right: 'block submit path' },
      { label: 'DPAS interrupt', left: '상위 poll 의도 제거', right: '실제 poll hctx routing 제거' },
    ],
  },
  notes: [
    'REQ_POLLED는 queue 선택에 영향을 주므로 completion path에서만 생각하면 늦습니다.',
    '현재 src의 bi_cookie는 blk_rq_to_qc(rq)가 아니라 rq->mq_hctx->queue_num입니다.',
  ],
};

export const step2DpasComparisonVisual: VisualModel = {
  title: 'DPAS 5.18은 submit 전에 poll flag를 지웠다',
  description: 'interrupt mode를 completion skip으로 구현하지 않고, poll request 자체가 되기 전에 막았습니다.',
  comparison: {
    title: 'DPAS 5.18 vs 현재 src',
    description: '큰 flag 흐름은 유지되지만 DPAS mode 개입 지점은 현재 src에 다시 이식해야 합니다.',
    leftLabel: 'DPAS 5.18 artifact',
    rightLabel: 'src/linux-upstream 7.1.0-rc4',
    leftTone: 'violet',
    rightTone: 'teal',
    rows: [
      { label: '기준 tree', left: 'kernel/ 5.18.0-rc6-dpas-fast26', right: 'src/linux-upstream 7.1.0-rc4' },
      { label: 'HIPRI 정의', left: 'RWF_HIPRI -> IOCB_HIPRI', right: '동일한 bit 연결 유지' },
      { label: 'block/fops.c', left: 'mode에 따라 IOCB_HIPRI/REQ_POLLED 제거', right: 'IOCB_HIPRI면 REQ_POLLED를 붙이는 upstream 기본 동작' },
      { label: 'iomap DIO', left: 'filesystem path에서도 interrupt mode면 poll flag 제거', right: 'bio_set_polled()로 REQ_POLLED 설정' },
      { label: 'bi_cookie', left: 'blk_rq_to_qc(rq)', right: 'rq->mq_hctx->queue_num' },
      { label: 'migration 의미', left: '정책 코드가 이미 들어 있음', right: 'submission-side hook을 다시 설계해야 함' },
    ],
  },
  asciiArts: [
    {
      title: '왜 completion path만 보면 부족한가',
      art: [
        '  늦은 방식:',
        '    REQ_POLLED 붙임',
        '      -> HCTX_TYPE_POLL로 제출',
        '      -> 나중에 bio_poll()만 안 함',
        '    문제: 이미 interrupt 없는 poll queue로 갔을 수 있음',
        '',
        '  DPAS 5.18 방식:',
        '    submit 전에 IOCB_HIPRI / REQ_POLLED 제거',
        '      -> DEFAULT/READ hctx로 제출',
        '      -> IRQ completion 가능',
      ].join('\n'),
      caption: 'true interrupt mode는 future I/O가 poll request가 되기 전에 막아야 합니다.',
    },
  ],
  notes: [
    'DPAS 5.18의 interrupt mode는 poll을 만든 뒤 무시하는 방식이 아니었습니다.',
    'IOCB_HIPRI와 REQ_POLLED를 둘 다 지워 상위 의도와 block-layer routing 의도를 함께 제거했습니다.',
  ],
};

export const step2HookCandidatesVisual: VisualModel = {
  title: 'Step 2 hook 후보',
  description: 'REQ_POLLED 생성 지점은 block device DIO와 filesystem iomap DIO를 나눠 봐야 합니다.',
  metricTable: {
    title: 'submission-side hook 후보',
    columns: ['담당 경로', '장점', '주의점'],
    rows: [
      { label: 'block/fops.c', cells: ['raw block device direct I/O', 'REQ_POLLED 생성 지점이 직접적', 'filesystem DIO는 놓칠 수 있음'], tone: 'teal' },
      { label: 'fs/iomap/direct-io.c', cells: ['iomap 기반 filesystem direct I/O', '실제 benchmark가 filesystem 위면 중요', 'sync/async DIO 조건을 조심해야 함'], tone: 'amber' },
      { label: 'block/blk-mq.h', cells: ['REQ_POLLED -> HCTX_TYPE_POLL mapping', 'routing 규칙 확인 근거', '정책 hook으로는 너무 공통/낮은 계층일 수 있음'], tone: 'rose' },
    ],
  },
  asciiArts: [
    {
      title: 'coverage 차이',
      art: [
        '  raw block device DIO',
        '    app -> /dev/nvme0n1 -> block/fops.c -> REQ_POLLED',
        '',
        '  filesystem DIO',
        '    app -> file on ext4/xfs/... -> fs/iomap/direct-io.c -> bio_set_polled()',
        '',
        '  DPAS interrupt mode가 전체 workload를 커버하려면 둘 다 확인해야 한다.',
      ].join('\n'),
    },
  ],
  notes: [
    '초기 smoke는 block/fops.c 한 곳에서 시작할 수 있지만, 일반 benchmark coverage를 말하려면 iomap path를 같이 봐야 합니다.',
    'Part 4 PAS-only와 Part 6 full interrupt mode는 hook 범위가 다를 수 있습니다.',
  ],
};
