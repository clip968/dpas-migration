import type { VisualModel } from '../../types';

export const modeVisual: VisualModel = {
  title: 'DPAS mode 확장 방향',
  description: 'Minimal PAS를 먼저 닫고, 그 다음 mode switching과 interrupt mode를 분리해서 봅니다.',
  metricTable: {
    title: 'mode별 판단 기준',
    columns: ['핵심 동작', '검증 포인트'],
    rows: [
      { label: 'CP', cells: ['continuous polling', 'CPU cost / latency baseline'], tone: 'slate' },
      { label: 'PAS', cells: ['sleep before poll', 'tail latency가 망가지지 않는 sleep window'], tone: 'teal' },
      { label: 'DPAS', cells: ['adaptive mode switching', 'mode counter와 transition reason'], tone: 'violet' },
      { label: 'Interrupt', cells: ['poll path 회피', 'REQ_POLLED와 queue selection까지 확인'], tone: 'rose' },
    ],
  },
  notes: ['completion path만 끊는 구현은 true interrupt mode가 아닐 수 있습니다.'],
};

export const pasSleepVisual: VisualModel = {
  title: 'PAS sleep-before-poll 핵심 아이디어',
  description: 'busy poll 전에 짧게 쉬어서 CPU를 아끼면서도 latency를 크게 망가뜨리지 않는 것이 목표입니다.',
  timeline: {
    title: 'CP vs PAS vs Interrupt 시간축 비교',
    description: 'I/O 완료까지 각 모드가 CPU를 어떻게 사용하는지 비교합니다.',
    rows: [
      {
        label: 'CP (Continuous)',
        segments: [
          { label: 'submit', duration: '1', state: 'submit' },
          { label: 'busy poll', duration: '4', state: 'busy' },
          { label: 'done', duration: '1', state: 'done' },
        ],
      },
      {
        label: 'PAS',
        segments: [
          { label: 'submit', duration: '1', state: 'submit' },
          { label: 'sleep', duration: '2', state: 'sleep' },
          { label: 'poll', duration: '2', state: 'busy' },
          { label: 'done', duration: '1', state: 'done' },
        ],
      },
      {
        label: 'Interrupt',
        segments: [
          { label: 'submit', duration: '1', state: 'submit' },
          { label: 'idle/wait', duration: '3', state: 'idle' },
          { label: 'IRQ', duration: '1', state: 'check' },
          { label: 'done', duration: '1', state: 'done' },
        ],
      },
    ],
    legend: [
      { state: 'submit', label: 'I/O 제출' },
      { state: 'busy', label: 'CPU busy poll' },
      { state: 'sleep', label: 'PAS sleep (CPU idle)' },
      { state: 'idle', label: 'idle (다른 작업 가능)' },
      { state: 'check', label: 'IRQ/check' },
      { state: 'done', label: '완료' },
    ],
  },
  comparison: {
    title: 'mode별 CPU/Latency tradeoff',
    leftLabel: 'CPU 사용량',
    rightLabel: 'Latency',
    leftTone: 'rose',
    rightTone: 'teal',
    rows: [
      { label: 'CP', left: '매우 높음 (100%)', right: '매우 낮음' },
      { label: 'PAS', left: '보통 (sleep 구간만큼 감소)', right: '약간 증가 (sleep만큼)' },
      { label: 'Interrupt', left: '매우 낮음', right: '높음 (IRQ + context switch)' },
    ],
  },
  notes: [
    'PAS의 핵심: sleep 구간을 잘 정하면 CPU를 크게 아끼면서 latency 손해는 작게 가져갈 수 있습니다.',
    'sleep 값이 너무 크면 tail latency 악화, 너무 작으면 CPU 절약 효과 없음.',
    'DPAS는 이 sleep 값을 workload에 따라 동적으로 조절하는 확장입니다.',
  ],
};

export const interruptRiskVisual: VisualModel = {
  title: 'Interrupt mode의 submission-side 문제',
  description: 'poll을 안 해도 submit 시점에 이미 poll hctx로 들어간 I/O는 interrupt 경로가 아닙니다.',
  asciiArts: [
    {
      title: '위험 시나리오',
      art: [
        '  ===== 잘못된 가정 =====                                       ',
        '  "poll 함수를 호출 안 하면 interrupt mode다"                     ',
        '  ',
        '  실제 상황:',
        '    submit: bio + REQ_POLLED -> HCTX_TYPE_POLL hctx -> NVMe poll SQ',
        '                               ^^^^^^^^^^^^^^^^^^',
        '                               이미 poll 전용 queue로 들어감!',
        '    ',
        '    completion: poll 안 함... 하지만:',
        '      - I/O는 poll queue에 있음',
        '      - IRQ가 이 queue를 처리하는지 불분명',
        '      - 완료가 안 올 수도 있음!',
        '  ',
        '  ===== 올바른 접근 =====                                        ',
        '  true interrupt mode는 미래 I/O에서 REQ_POLLED를 제거하거나',
        '  queue mapping을 바꿔서 submit 시점부터 IRQ queue로 가야 함.',
      ].join('\n'),
      caption: 'Part 6의 핵심 질문: future I/O의 submit-side까지 바꿔야 하는가?',
    },
  ],
  notes: [
    'completion-only skip은 pseudo-interrupt이며 진짜 interrupt mode가 아닐 수 있습니다.',
    'FIO latency가 바뀌어도 queue mapping 증거 없이는 판단할 수 없습니다.',
    'Part 6에서 REQ_POLLED 제어와 NVMe queue mapping 검증이 별도로 필요합니다.',
  ],
};

export const dpasSubmitHelperVisual: VisualModel = {
  title: '7.1 submit helper가 맡는 일',
  description: 'HIPRI bio가 들어오면 현재 DPAS mode를 보고 polled로 보낼지 interrupt로 보낼지 한 helper에서 정합니다.',
  asciiArts: [
    {
      title: 'submit-time gate',
      art: [
        '  block/fops.c                  fs/iomap/direct-io.c',
        '       \\                              /',
        '        \\                            /',
        '         +--> blk_dpas_prepare_bio()',
        '                    |',
        '                    v',
        '        switch_enabled == 0 ?',
        '            yes -> 기존 HIPRI polling 유지',
        '             no -> q->dpas_mode 확인',
        '',
        '        INT  -> IOCB_HIPRI 제거 + REQ_POLLED clear',
        '        CP   -> bio_set_polled() + cp counter',
        '        PAS  -> bio_set_polled() + pas counter',
        '        OL   -> bio_set_polled() + ol counter',
      ].join('\n'),
      caption: '두 submit 경로가 같은 helper로 모이기 때문에 5.18식 복붙 hook보다 읽기 쉽습니다.',
    },
  ],
  notes: [
    'INT->OL 전이는 poll path를 타지 못하므로 submit helper에서 int counter로 처리합니다.',
    '이 카드는 hook 후보가 아니라 현재 dpas-kernel에 들어간 실제 submit-side 코드입니다.',
  ],
};

export const dpasModeSwitchingDirectFieldVisual: VisualModel = {
  title: '7.1 full DPAS direct-field 구조',
  description: '현재 포팅은 별도 state pointer 계획이 아니라 request_queue 안의 direct field와 lock으로 mode/counter를 묶습니다.',
  asciiArts: [
    {
      title: 'queue 단위 상태와 세 경로',
      art: [
        '  struct request_queue',
        '  + dpas_lock',
        '  + dpas_mode: INT / CP / PAS / OL',
        '  + dpas_*_cnt',
        '  + dpas_qd, dpas_qd_sum, dpas_tf',
        '  + switch_enabled, switch_param1..7',
        '',
        '       sysfs write',
        '           |  switch_enabled store resets window to PAS',
        '           v',
        '       submit path',
        '           |  blk_dpas_prepare_bio() counts selected mode',
        '           v',
        '       poll path',
        '           |  PAS sleep updates qd/tf',
        '           v',
        '       blk_dpas_maybe_switch_mode()',
        '           CP -> PAS',
        '           PAS -> CP or OL',
        '           OL -> PAS or INT',
      ].join('\n'),
      caption: '상태는 queue에 있고, submit/sysfs/poll 세 경로가 lock 아래에서 같은 window를 봅니다.',
    },
  ],
  notes: [
    'Step 4의 예전 별도 state pointer 계획은 최신 history 기준으로 대체됐습니다.',
    'direct field 선택은 현재 구현을 설명하는 카드이지, 향후 구조 개선 가능성을 닫는 말은 아닙니다.',
  ],
};

export const part4Visual: VisualModel = {
  title: 'Minimal PAS-only 구현 범위',
  description: 'full DPAS가 아니라 sleep-before-poll 하나만 최소 형태로 넣고 검증하는 단계입니다.',
  metricTable: {
    title: 'Part 4 범위 vs 범위 밖',
    description: '한 번에 모든 것을 구현하면 실패 원인을 분리할 수 없습니다.',
    columns: ['포함 사항', '제외 (Part 5/6으로 미룸)'],
    rows: [
      { label: 'hook', cells: ['blk_mq_poll()에 sleep 삽입', 'mode switching 전체'], tone: 'teal' },
      { label: 'state', cells: ['per-hctx sleep_ns 변수', 'DPAS state machine (CP/PAS/IRQ)'], tone: 'teal' },
      { label: 'knob', cells: ['sysfs로 sleep_ns 수동 설정', 'adaptive UNDER/OVER update'], tone: 'teal' },
      { label: 'driver', cells: ['NVMe로 실험', '범용 block device 지원'], tone: 'blue' },
      { label: '검증', cells: ['FIO: latency/CPU/IOPS 비교', 'mode counter, transition trace'], tone: 'amber' },
    ],
  },
  flowSteps: [
    { title: '1. hook 위치 확정', description: 'blk_mq_poll() 진입 시 hctx 접근 가능한 지점', tone: 'blue' },
    { title: '2. sleep 구현', description: 'schedule_timeout_interruptible(ns) 또는 usleep_range()', tone: 'teal' },
    { title: '3. sysfs knob', description: '/sys/block/nvme0n1/queue/pas_sleep_ns로 외부 조절', tone: 'amber' },
    { title: '4. FIO 비교', description: 'sleep=0(CP), sleep=N(PAS) 두 케이스 latency/CPU 비교', tone: 'violet' },
  ],
  notes: [
    'Part 4 성공 = "sleep hook이 latency를 소폭 올리고 CPU를 유의미하게 줄인다" 확인',
    'mode switching은 Part 5로, interrupt queue mapping은 Part 6으로 확실히 분리합니다.',
  ],
};

export const part7Visual: VisualModel = {
  title: 'FIO 검증 계획',
  description: 'DPAS 정책이 실제로 의도한 효과를 내는지 측정 기준과 비교 방법을 정합니다.',
  metricTable: {
    title: 'FIO 핵심 관측 지표',
    columns: ['의미', '위험 신호'],
    rows: [
      { label: 'avg latency', cells: ['평균 응답 시간', '급격한 증가 -> sleep 과다'], tone: 'blue' },
      { label: 'p99 latency', cells: ['tail latency', 'p99가 avg의 5배 이상 -> 문제'], tone: 'rose' },
      { label: 'CPU usage', cells: ['polling core의 CPU%', 'CP 대비 감소 안 보임 -> hook 미동작'], tone: 'amber' },
      { label: 'IOPS', cells: ['초당 I/O 횟수', '10% 이상 감소 -> throughput 손해'], tone: 'violet' },
      { label: 'mode counter', cells: ['각 mode 진입 횟수', 'IRQ 0회 -> IRQ mode 미동작'], tone: 'teal' },
    ],
  },
  comparison: {
    title: '실험 시나리오',
    leftLabel: 'baseline (CP)',
    rightLabel: 'PAS (sleep N us)',
    leftTone: 'slate',
    rightTone: 'teal',
    rows: [
      { label: 'FIO job', left: 'randread, iodepth=1, iopoll=1', right: '동일' },
      { label: '기대 CPU', left: '~100%', right: '50~80%' },
      { label: '기대 latency', left: '~3us avg', right: '~5us avg (약간 증가)' },
      { label: '성공 기준', left: '-', right: 'CPU 20%+ 감소, p99 < 10x baseline' },
    ],
  },
  notes: [
    '평균만 보면 tail이 숨습니다. 반드시 percentile도 같이 관측합니다.',
    'DPAS mode counter가 없으면 어떤 mode가 실제로 사용됐는지 추측만 가능합니다.',
    'WSL에서는 성능 측정이 불가합니다. bare-metal NVMe 환경에서만 유효합니다.',
  ],
};

export const fullModeStaticTestVisual: VisualModel = {
  title: 'full_mode_switching_static.py 검증 범위',
  description: '새 static test는 현재 full DPAS 포팅을 네 덩어리로 나눠 구조가 빠지지 않았는지 확인합니다.',
  asciiArts: [
    {
      title: 'static test checklist',
      art: [
        '  include/linux/blkdev.h',
        '      enum dpas_mode + request_queue direct fields',
        '',
        '  block/blk-sysfs.c',
        '      switch_enabled show/store + reset window',
        '',
        '  block/blk-core.c + fops/iomap callers',
        '      blk_dpas_prepare_bio() submit gate',
        '',
        '  block/blk-mq.c',
        '      PAS qd/tf update + blk_dpas_maybe_switch_mode()',
      ].join('\n'),
      caption: '이 테스트는 old partial PAS guard들을 대체해 현재 full mode switching 구조를 검증합니다.',
    },
  ],
  notes: [
    '테스트가 코드의 의도 전체를 증명하진 않지만, 빠진 hook이나 stale policy 회귀를 빨리 잡습니다.',
    'runtime I/O 검증과 VM boot 검증은 아직 별도 단계로 남아 있습니다.',
  ],
};

export const optaneKnobResetVisual: VisualModel = {
  title: 'Optane mode knob reset 보정',
  description: 'nvme가 builtin인 host에서는 modprobe reload가 reset 수단이 아니므로 각 mode 직전에 sysfs knob를 명시적으로 맞춥니다.',
  asciiArts: [
    {
      title: 'mode 실행 전 knob 상태',
      art: [
        '  every mode run',
        '      |',
        '      v',
        '  reset_queue_knobs()',
        '      io_poll_delay = -1',
        '      pas_enabled = 0',
        '      pas_adaptive_enabled = 0',
        '      ehp_enabled = 0',
        '      switch_enabled = 0',
        '      |',
        '      v',
        '  set_mode_knobs(mode)',
        '      CP  -> io_poll=1, classic polling',
        '      LHP -> io_poll=1, io_poll_delay=0',
        '      PAS -> LHP knobs + PAS knobs',
        '      INT -> reset baseline',
      ].join('\n'),
      caption: 'CP가 PAS/LHP 설정을 물려받아 context switch가 폭증하던 해석 오류를 막습니다.',
    },
  ],
  notes: [
    '원본-style Optane script는 destructive device experiment라 실행 전 대상 장치 확인이 필요합니다.',
    '이 카드는 성능 결론보다 측정 조건을 올바르게 만드는 코드 변경에 초점을 둡니다.',
  ],
};

export const colimaBuildLoopVisual: VisualModel = {
  title: 'macOS ARM 빌드 루프',
  description: 'macOS host에서는 커널 빌드 도구 요구사항을 직접 맞추기보다 Colima/Docker Ubuntu 이미지 안에서 x86 bzImage를 빌드합니다.',
  asciiArts: [
    {
      title: 'build path',
      art: [
        '  ./vm start',
        '      Colima VM: cpu=4, memory=8GiB, disk=80GiB',
        '      mount /Volumes/CodeCS/dpas-migration writable',
        '          |',
        '          v',
        '  docker image: dpas-kernel-build-env:ubuntu24.04',
        '      GNU make 4.3, bash 5.2, gcc-x86_64, pahole, lld',
        '          |',
        '          v',
        '  make -C dpas-kernel O=build/dpas-kernel-vm x86_64_defconfig',
        '  make -C dpas-kernel O=build/dpas-kernel-vm -j4 bzImage',
        '          |',
        '          v',
        '  build/dpas-kernel-vm/arch/x86/boot/bzImage',
      ].join('\n'),
      caption: '현재 검증은 compile/link와 bzImage 생성까지이며 VM boot/runtime I/O는 다음 단계입니다.',
    },
  ],
  notes: [
    'Colima mount가 빠지면 Docker 안의 /work가 빈 디렉터리처럼 보일 수 있습니다.',
    './vm ssh는 Colima가 꺼져 있으면 자동 시작하지 않고 실패하도록 만들었습니다.',
  ],
};

export const misSubmitPollVisual: VisualModel = {
  title: 'submit path vs poll path 분리',
  description: '두 경로를 섞으면 bi_cookie가 어디서 생기고 어디서 쓰이는지 모두 혼동됩니다.',
  asciiArts: [
    {
      title: '시간축으로 보는 두 경로',
      art: [
        '  시간 ─────────────────────────────────────────────────────>    ',
        '  ',
        '       [submit path]            (device 처리중)     [poll path]  ',
        '   ┌─────────────────────┐                    ┌──────────────┐ ',
        '   │ REQ_POLLED 설정     │                    │ bio_poll()   │ ',
        '   │ hctx 선택           │     ..device..     │ blk_mq_poll()│ ',
        '   │ blk_mq_start_req() │                    │ nvme_poll()  │ ',
        '   │ cookie 저장!        │                    │ cookie 소비! │ ',
        '   └─────────────────────┘                    └──────────────┘ ',
        '                         │                    │                 ',
        '               cookie 생성 ─────────────────> cookie 소비       ',
      ].join('\n'),
      caption: 'cookie는 submit 끝에서 태어나고 poll 시작에서 사용됩니다. 두 시점은 다릅니다.',
    },
  ],
  notes: [
    'submit은 "보내는 길", poll은 "확인하는 길"입니다. 섞어서 설명하지 않습니다.',
    'interrupt risk도 이 분리에서 나옵니다: queue 선택은 submit에서 이미 결정됩니다.',
  ],
};

export const misCpuRelaxVisual: VisualModel = {
  title: 'cpu_relax() vs PAS sleep',
  description: '둘은 완전히 다른 것입니다. cpu_relax는 busy wait hint, PAS sleep은 scheduler에 양보.',
  comparison: {
    title: 'cpu_relax() vs sleep-before-poll',
    leftLabel: 'cpu_relax()',
    rightLabel: 'PAS sleep',
    leftTone: 'rose',
    rightTone: 'teal',
    rows: [
      { label: '정체', left: 'busy loop 안의 CPU hint', right: '일정 시간 동안 CPU를 양보하는 sleep' },
      { label: 'CPU 사용', left: '100% (계속 회전)', right: '0% (sleep 구간 idle)' },
      { label: '위치', left: 'blk_hctx_poll() loop 안', right: 'blk_mq_poll() 진입 부근 (Part 4)' },
      { label: '효과', left: '전력 절약 hint, latency 변화 없음', right: 'CPU 절약 대신 latency 약간 증가' },
      { label: 'scheduler', left: '양보 안 함', right: '양보함 (schedule_timeout 등)' },
    ],
  },
  asciiArts: [
    {
      title: '시간축 비교',
      art: [
        '  cpu_relax (기본):',
        '  [poll] [poll] [poll] [poll] [poll] ... [done]  <- CPU 100%',
        '          ^      ^      ^',
        '         cpu_relax (tiny pause, 여전히 busy)',
        '  ',
        '  PAS sleep:',
        '  [   sleep (CPU idle)   ] [poll] [done]        <- CPU 30%',
      ].join('\n'),
    },
  ],
  notes: [
    '"cpu_relax가 있으니 이미 PAS가 구현돼 있다"는 틀린 해석입니다.',
    'cpu_relax 자리에 sleep을 넣는 것도 바로 정답은 아닙니다. 위치와 context를 따져야 합니다.',
  ],
};

export const paperPasVisual: VisualModel = {
  title: '논문 PAS -> kernel hook 번역',
  description: '논문의 figure와 아이디어를 최신 kernel 함수로 옮기는 bridge입니다.',
  mermaid: {
    title: '논문 Figure -> kernel 위치 대응',
    code: [
      'flowchart LR',
      '  fig1["논문 Figure 1\\nI/O completion taxonomy"] --> model["kernel-io-completion-model"]',
      '  fig3["논문 Figure 3\\nPAS core idea"] --> pas["concept-pas-sleep-before-poll"]',
      '  fig7["논문 Figure 7\\nsleep window"] --> hook["blk_mq_poll() hook 후보"]',
      '  fig9["논문 Figure 9\\nDPAS transitions"] --> mode["concept-dpas-mode"]',
      '  fig10["논문 Figure 10\\nstate machine"] --> sm["paper-dpas-state-machine"]',
    ].join('\n'),
  },
  notes: [
    '논문 용어를 kernel grep으로 1:1 검색하면 안 됩니다. kernel엔 PAS라는 함수가 없습니다.',
    'PAS는 "poll 전에 쉬자"라는 정책이고, kernel에서는 이를 어떤 함수 앞에 schedule_timeout으로 번역해야 합니다.',
  ],
};

export const paperDpasVisual: VisualModel = {
  title: 'DPAS State Machine (Figure 10)',
  description: '부하에 따라 CP/PAS normal/PAS overloaded/Interrupt 사이를 전환하는 모델입니다.',
  mermaid: {
    title: 'DPAS mode transition',
    code: [
      'stateDiagram-v2',
      '  [*] --> CP',
      '  CP --> PAS_normal : load increases',
      '  PAS_normal --> CP : load decreases',
      '  PAS_normal --> PAS_overloaded : load high',
      '  PAS_overloaded --> PAS_normal : load decreases',
      '  PAS_overloaded --> Interrupt : overload sustained',
      '  Interrupt --> PAS_overloaded : load decreases',
      '  Interrupt --> CP : load low',
    ].join('\n'),
  },
  metricTable: {
    title: 'kernel 구현 요소',
    description: '각 mode를 kernel에 옮기기 위해 필요한 것들',
    columns: ['kernel state 필요', '판정 기준'],
    rows: [
      { label: 'CP', cells: ['sleep_ns = 0 (Part 4 baseline)', 'workload underloaded'], tone: 'slate' },
      { label: 'PAS normal', cells: ['sleep_ns = UNDER update 값', 'average latency < threshold'], tone: 'teal' },
      { label: 'PAS overloaded', cells: ['sleep_ns = OVER update 값', 'queue depth > threshold'], tone: 'amber' },
      { label: 'Interrupt', cells: ['REQ_POLLED 제거 필요!', 'sustained overload + timer fail'], tone: 'rose' },
    ],
  },
  notes: [
    'PAS-only (Part 4)는 state machine 없이도 가능합니다. sleep_ns를 수동으로 설정하면 됩니다.',
    'full DPAS (Part 5)부터 mode counter, transition reason, UNDER/OVER update가 모두 필요합니다.',
    'Interrupt state는 completion skip만으로 불충분할 수 있습니다 (interrupt risk 참조).',
  ],
};

export const part5Visual: VisualModel = {
  title: 'Part 5 DPAS Mode Switching',
  description: 'Part 4 PAS-only를 넘어 workload에 따라 sleep_ns와 mode를 자동 전환하는 full DPAS state machine 포팅 단계입니다.',
  metricTable: {
    title: 'Part 5에서 추가되는 것',
    columns: ['kernel 구현', '논문 대응'],
    rows: [
      { label: 'mode state', cells: ['per-hctx/per-CPU CP/PAS/IRQ state', 'Figure 10 state'], tone: 'violet' },
      { label: 'UNDER update', cells: ['latency 낮을 때 sleep_ns 감소', 'PAS normal tuning'], tone: 'teal' },
      { label: 'OVER update', cells: ['queue depth 높을 때 sleep_ns 증가', 'PAS overloaded tuning'], tone: 'amber' },
      { label: 'counter', cells: ['mode 진입/전환 횟수, reason', '검증/디버그 필수'], tone: 'blue' },
      { label: 'timer fail', cells: ['overload sustained -> IRQ 후보', 'Interrupt transition'], tone: 'rose' },
    ],
  },
  flowSteps: [
    { title: 'Part 4 PAS 검증 완료', description: '고정 sleep_ns hook이 동작함을 FIO로 확인', tone: 'blue' },
    { title: 'state machine 추가', description: 'CP/PAS normal/PAS overloaded 상태 변수', tone: 'teal' },
    { title: 'UNDER/OVER update', description: 'latency/queue depth 기반 sleep_ns 조절', tone: 'amber' },
    { title: 'transition counter', description: 'sysfs/trace로 mode breakdown 관측', tone: 'violet' },
  ],
  notes: [
    'Part 5는 Part 4 hook 위치(blk_mq_poll)를 유지한 채 정책만 확장하는 것이 이상적입니다.',
    'mode switching과 interrupt queue mapping(Part 6)을 동시에 구현하면 실패 원인 분리가 어렵습니다.',
  ],
};

export const part6Visual: VisualModel = {
  title: 'Part 6 Full Interrupt Mode & NVMe Mapping',
  description: 'sustained overload에서 interrupt mode로 전환할 때 submission-side REQ_POLLED 제어와 NVMe poll/IRQ queue mapping을 검증하는 단계입니다.',
  metricTable: {
    title: 'Part 6 검증 체크리스트',
    columns: ['확인 항목', '실패 신호'],
    rows: [
      { label: 'future REQ_POLLED', cells: ['interrupt mode에서 새 I/O에 flag 미설정', 'dmesg/trace에 REQ_POLLED 잔존'], tone: 'rose' },
      { label: 'queue mapping', cells: ['DEFAULT hctx로 submit', '여전히 POLL hctx 사용'], tone: 'amber' },
      { label: 'completion path', cells: ['IRQ handler가 CQ 처리', 'poll skip만 하고 IRQ 0'], tone: 'violet' },
      { label: 'NVMe queues', cells: ['poll SQ vs admin/IRQ queue 분리 확인', '완료 유실 또는 hang'], tone: 'teal' },
    ],
  },
  notes: [
    'interrupt risk 카드의 "submission-side proof"를 Part 6에서 실제 counter/trace로 닫는 단계입니다.',
    'FIO latency 변화만으로 interrupt mode 성공을 판단하면 안 됩니다.',
    'drivers/nvme/host/pci.c의 poll queue flag(NVMEQ_POLLED)와 hctx type을 같이 봐야 합니다.',
  ],
};
