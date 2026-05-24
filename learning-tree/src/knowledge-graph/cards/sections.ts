import type { CardSections } from '../types';

export function sections(
  plainExplanation: string,
  whyItMatters: string,
  repoContext: string,
  commonConfusions: string[],
  nextSteps: string[],
): CardSections {
  return { plainExplanation, whyItMatters, repoContext, commonConfusions, nextSteps };
}

export const expandedSections: Partial<Record<string, CardSections>> = {
  'repo-overview': sections(
    '이 카드는 Dpas-migration Notion index를 학습 지도 형태로 다시 배열한 출발점입니다. Notion의 Part 1-9는 작업 일정이고, 이 tree는 그 일정을 이해 순서로 바꿉니다. 먼저 build/boot 루프와 kernel 기본 객체를 잡고, 그 다음 Part 3 Step 1의 polled I/O path를 따라가며 PAS/DPAS hook 후보로 넘어갑니다.',
    'DPAS migration은 논문 알고리즘을 바로 붙이는 작업이 아닙니다. build loop, paper model, 최신 kernel polling path, 최소 PAS, full mode switching, interrupt mode, FIO 검증이 서로 의존하므로 어느 단계에서 어떤 판단을 해야 하는지 분리해야 실수를 줄일 수 있습니다.',
    'Notion Dpas-migration index는 Part 1 Kernel Build Boot Loop부터 Part 9 Final Report까지의 큰 roadmap입니다. 이 local learning tree는 그중 Part 3 Step 1의 submit/poll path를 중심축으로 삼고, Part 1의 안전한 kernel 작업 루프와 Part 4 이후 포팅 계획을 연결합니다.',
    [
      'Dpas-migration index는 세부 코드 설명서가 아니라 전체 작업 목차입니다. 세부 근거는 각 Part와 Step child page에서 확인해야 합니다.',
      'Part 1의 Step 1은 build/boot 루프 준비이고, Part 3의 Step 1은 polled I/O path 코드 리딩입니다. 이름은 비슷하지만 목적이 다릅니다.',
      'Part 번호를 그대로 외우는 것보다 bio, request, hctx, REQ_POLLED, bi_cookie 관계를 먼저 이해하는 편이 이후 포팅 판단에 더 도움이 됩니다.',
    ],
    ['Part 1 build loop 카드를 보고 작업 환경과 복구 루프의 의미를 확인합니다.', '그 다음 Step 1 polled I/O path 카드에서 submit path와 poll path가 bi_cookie로 연결되는 흐름을 따라갑니다.'],
  ),
  'part1-build-boot-loop': sections(
    'Part 1은 DPAS 기능을 구현하는 단계가 아니라 kernel을 안전하게 만질 수 있는지 확인하는 단계입니다. 목표는 kernel source를 수정하고, 빌드하고, boot 또는 compile check로 확인하고, 로그를 남기고, 문제가 생기면 이전 상태로 복구하는 루프를 닫는 것입니다.',
    'DPAS는 block layer hot path를 건드리므로 작은 실수도 부팅 실패나 성능 왜곡으로 이어질 수 있습니다. smoke log처럼 되돌리기 쉬운 변경으로 빌드 루프를 먼저 검증해야 이후 PAS hook이나 mode switching 변경을 안전하게 실험할 수 있습니다.',
    'Notion Part 1은 WSL에서는 코드 분석, patch 정리, compile check를 하고 실제 NVMe polling/interrupt 성능 검증은 bare-metal Linux에서 하라고 구분합니다. 산출물은 build log, smoke patch, .config, dmesg 또는 부팅 확인 로그, 복구 계획입니다.',
    [
      'WSL custom kernel boot는 개발 루프 연습용이지 DPAS 성능 검증 환경이 아닙니다.',
      '1단계에서 성능을 보려고 하면 범위가 섞입니다. 이 단계의 성공 문장은 "나는 kernel을 수정하고 빌드해서 확인할 수 있다"입니다.',
      'hot path smoke log는 반복 출력하면 안 됩니다. pr_info_once() 또는 ratelimited log처럼 영향이 작은 형태여야 합니다.',
    ],
    ['vanilla kernel build가 먼저 성공하는지 확인합니다.', 'block/blk-mq.c smoke patch와 build log를 남긴 뒤 Part 3 코드 리딩으로 넘어갑니다.'],
  ),
  'kernel-io-completion-model': sections(
    'Linux block I/O completion은 크게 interrupt completion과 polled completion으로 나눠 볼 수 있습니다. Interrupt 방식은 device가 완료 interrupt를 보내고 handler가 CQ를 처리합니다. Polled 방식은 CPU가 bio_poll()에서 시작해 blk-mq와 NVMe driver까지 내려가 completion queue를 직접 확인합니다.',
    'DPAS는 "polling은 빠르지만 CPU를 태운다"는 문제를 줄이려는 연구입니다. 따라서 interrupt와 poll이 어디서 갈라지고, polled I/O가 어떤 queue와 callback을 타는지 모르면 PAS sleep-before-poll hook 위치를 판단할 수 없습니다.',
    'Part 3 Step 1은 이 completion model을 최신 Linux 코드에서 확인합니다. Step 1 결론은 submit 때 REQ_POLLED와 bi_cookie가 준비되고, poll 때 bio_poll() -> blk_mq_poll() -> blk_hctx_poll() -> nvme_poll()로 내려간다는 것입니다.',
    [
      'poll completion은 request를 submit하는 순간 완료되는 것이 아니라 나중에 CPU가 직접 확인하는 완료 경로입니다.',
      'interrupt mode는 단순히 poll 함수를 호출하지 않는 것만으로 충분하지 않을 수 있습니다. submit 시 REQ_POLLED와 queue mapping이 이미 결정되기 때문입니다.',
      'completion model은 성능 정책이 아니라 경로 구조입니다. DPAS 정책은 이 구조 위에 올라갑니다.',
    ],
    ['REQ_POLLED 카드에서 polled I/O 표시가 어디에 붙는지 확인합니다.', 'poll path와 interrupt completion path 카드에서 두 completion 경로를 대조합니다.'],
  ),
  'concept-blk-mq': sections(
    'blk-mq는 Linux block layer에서 bio를 request로 바꾸고 여러 hardware queue로 분산해 driver에 넘기는 엔진입니다. CPU 쪽 software context인 ctx와 device queue 쪽 hardware context인 hctx를 연결하고, NVMe 같은 driver callback은 mq_ops를 통해 호출합니다.',
    'DPAS hook은 결국 blk-mq의 submit 또는 poll 경로 어딘가에 들어가야 합니다. blk-mq가 bio, request, hctx, tag, mq_ops를 어떻게 연결하는지 알아야 sleep-before-poll을 어느 계층에 넣을지 비교할 수 있습니다.',
    'Part 3 Step 1에서는 blk_mq_submit_bio(), blk_mq_start_request(), blk_mq_poll(), blk_hctx_poll()을 중심으로 읽습니다. Part 4 이후에는 이 지식이 PAS-only hook 후보와 DPAS state placement 판단의 기준이 됩니다.',
    [
      'blk-mq는 NVMe driver 자체가 아니라 block layer 공통 구조입니다.',
      'ctx는 CPU 쪽 software context이고 hctx는 hardware queue context입니다. 둘을 같은 것으로 보면 queue mapping을 잘못 이해합니다.',
      'tag는 hctx 안의 request slot 번호이고 bi_cookie는 poll 대상 hctx 번호입니다.',
    ],
    ['bio와 request 카드에서 입력 단위와 제출 단위를 분리합니다.', 'hctx 카드에서 cookie가 왜 queue index인지 확인합니다.'],
  ),
  'concept-bio': sections(
    'bio는 block layer로 들어오는 I/O 요청의 기본 표현입니다. 사용자의 read/write 또는 io_uring 요청은 kernel 내부에서 bio로 표현되고, polled I/O라면 bio->bi_opf에 REQ_POLLED가 붙고 bio->bi_cookie가 poll 경로의 연결 고리가 됩니다.',
    'Step 1의 핵심 질문은 bio가 어떻게 request로 바뀌고, 나중에 bio_poll()이 어떤 정보로 poll 대상 queue를 찾는가입니다. bio를 단순한 데이터 덩어리로 보면 REQ_POLLED와 bi_cookie의 역할을 놓칩니다.',
    'Part 3 Step 1에서는 block/fops.c에서 IOCB_HIPRI가 bio->bi_opf |= REQ_POLLED로 이어지는 흐름과, block/blk-core.c의 bio_poll()이 bio->bi_cookie를 읽는 흐름을 같이 봅니다.',
    [
      'bio는 driver에 직접 제출되는 최종 단위가 아닙니다. blk-mq가 request로 바꿔 driver에 넘깁니다.',
      'bi_cookie는 request tag가 아닙니다. poll해야 할 hctx index입니다.',
      'REQ_POLLED가 없거나 bi_cookie가 BLK_QC_T_NONE이면 bio_poll()은 대체로 poll할 대상을 찾지 못합니다.',
    ],
    ['request 카드로 넘어가 bio가 어떤 제출 단위로 변환되는지 봅니다.', 'bio_poll() 카드에서 bi_cookie가 실제로 어떻게 소비되는지 확인합니다.'],
  ),
  'concept-request': sections(
    'request는 blk-mq가 device driver에 제출하는 I/O 단위입니다. bio보다 driver submit에 가깝고, request에는 선택된 hctx, hctx 안에서의 tag, bio에서 전달된 cmd_flags 같은 정보가 연결됩니다.',
    'DPAS 구현 후보를 볼 때 request를 이해해야 하는 이유는 submit 시점의 queue 선택과 poll 시점의 completion 확인이 request/hctx 관계를 통해 이어지기 때문입니다. 특히 blk_mq_start_request()에서 polled bio의 bi_cookie가 rq->mq_hctx->queue_num으로 저장됩니다.',
    'Part 3 Step 1에서는 request가 어느 hctx로 가는지, tag가 무엇인지, 그리고 tag가 bi_cookie와 다르다는 점을 강조합니다. 이후 DPAS state를 request 단위로 둘지 queue/per-CPU 단위로 둘지 판단할 때도 이 구분이 필요합니다.',
    [
      'request tag는 "이 request가 hctx 안 몇 번째 slot인가"를 의미합니다.',
      'bio_poll()은 tag로 request를 직접 찾는 함수가 아닙니다.',
      'request가 실제 issue되기 전에는 bio->bi_cookie가 아직 poll 가능한 값으로 준비되지 않았을 수 있습니다.',
    ],
    ['hctx 카드에서 request가 어느 hardware queue context에 묶이는지 확인합니다.', 'bi_cookie != tag 카드에서 두 번호 체계를 분리합니다.'],
  ),
  'concept-hctx': sections(
    'hctx는 blk-mq의 hardware context입니다. 쉽게 말하면 block layer가 device의 hardware queue를 대표하기 위해 들고 있는 per-queue 구조이며, polled I/O에서는 hctx->queue_num이 bio->bi_cookie로 저장됩니다.',
    'Step 1에서 hctx를 모르면 bi_cookie가 왜 tag가 아닌지 이해할 수 없습니다. bio_poll()은 request slot을 찾는 것이 아니라 cookie로 q->queue_hw_ctx[cookie]를 찾아 어느 hctx를 poll할지 결정합니다.',
    'Part 3 Step 1의 submit path에서는 REQ_POLLED가 HCTX_TYPE_POLL queue 선택으로 이어지고, poll path에서는 blk_mq_poll()이 cookie를 hctx index로 사용합니다. Part 6 interrupt mode에서는 이 hctx/queue mapping이 더 중요해집니다.',
    [
      'hctx는 CPU 자체가 아닙니다. CPU별 ctx 여러 개가 하나의 hctx로 묶일 수 있습니다.',
      'hctx->queue_num은 poll 대상 queue 번호이고 request tag는 그 hctx 안의 request slot 번호입니다.',
      'HCTX_TYPE_POLL은 "poll 전용 hardware context 타입"이지 PAS mode 자체가 아닙니다.',
    ],
    ['REQ_POLLED 카드에서 poll hctx 선택 조건을 확인합니다.', 'blk_mq_poll() 카드에서 q->queue_hw_ctx[cookie]가 어떻게 쓰이는지 봅니다.'],
  ),
  'concept-req-polled': sections(
    'REQ_POLLED는 이 I/O가 polled completion 경로를 사용할 수 있음을 표시하는 request/bio flag입니다. 사용자 요청의 RWF_HIPRI, IOCB_HIPRI, io_uring IOPOLL 같은 의도가 block layer에서 bio->bi_opf |= REQ_POLLED 형태로 나타납니다.',
    'REQ_POLLED는 단순한 주석이 아니라 queue 선택에 영향을 줍니다. 이 flag가 있으면 blk-mq는 HCTX_TYPE_POLL을 선택할 수 있고, request가 실제 issue될 때 poll 대상 hctx 번호가 bi_cookie로 저장됩니다.',
    'Part 3 Step 1은 REQ_POLLED가 붙은 뒤 submit path와 poll path가 어떻게 이어지는지 설명합니다. Part 6에서는 true interrupt mode를 하려면 completion path뿐 아니라 이 flag가 붙는 submission path까지 봐야 한다는 리스크로 이어집니다.',
    [
      'REQ_POLLED가 있다고 해서 이미 completion이 된 것은 아닙니다. poll 가능한 경로로 제출됐다는 표시입니다.',
      'completion path에서 poll만 건너뛰어도 이미 request는 poll queue로 들어갔을 수 있습니다.',
      'REQ_POLLED와 REQ_HIPRI 계열 이름은 가까워 보이지만 코드에서 실제 변환 지점을 확인해야 합니다.',
    ],
    ['submit path 카드에서 REQ_POLLED가 HCTX_TYPE_POLL과 bi_cookie로 이어지는 흐름을 봅니다.', 'interrupt risk 카드에서 왜 submission-side proof가 필요한지 확인합니다.'],
  ),
  'step2-req-polled-submission': sections(
    'Part 3 Step 2는 poll completion path가 아니라 poll request가 만들어지는 submission path를 추적합니다. 이 카드는 Step 2 전체 지도로, 세부 내용은 RWF/kiocb, flag 전파, DPAS 5.18 비교, hook 후보 카드로 나눠서 봅니다.',
    'Step 2를 여러 카드로 나누는 이유는 한 카드에 RWF_HIPRI, kiocb, bio->bi_opf, request->cmd_flags, HCTX_TYPE_POLL, DPAS interrupt mode까지 모두 넣으면 흐름은 보이지만 각 판단 근거가 흐려지기 때문입니다.',
    '현재 기준 source는 /home/clip968/DPAS_FAST26/src/linux-upstream이며 kernelversion은 7.1.0-rc4입니다. 비교 대상은 /home/clip968/DPAS_FAST26/kernel의 5.18.0-rc6-dpas-fast26 artifact입니다.',
    [
      'Step 2는 Step 1의 bio_poll -> blk_mq_poll -> nvme_poll 사슬을 다시 설명하는 단계가 아닙니다. Step 2는 그 poll 대상 bio가 왜 REQ_POLLED가 되었는지 보는 단계입니다.',
      'Step 2 전체를 한 장의 경로로 외우기보다, signal -> propagation -> comparison -> hook 후보로 나눠 읽는 편이 포팅 판단에 낫습니다.',
    ],
    [
      '먼저 RWF/kiocb 카드에서 IOCB_HIPRI가 어디에 저장되는지 확인합니다.',
      '그 다음 flag 전파 카드에서 REQ_POLLED가 request routing까지 가는 흐름을 봅니다.',
      '마지막으로 DPAS 비교와 hook 후보 카드로 migration 결정을 분리합니다.',
    ],
  ),
  'step2-kiocb-hipri': sections(
    'userspace는 RWF_HIPRI로 “가능하면 high-priority/poll 방식으로 처리해 달라”는 per-I/O hint를 줍니다. kernel 내부에서는 같은 bit가 IOCB_HIPRI라는 이름으로 kiocb->ki_flags에 들어갑니다.',
    'kiocb를 이해해야 block/fops.c의 if (iocb->ki_flags & IOCB_HIPRI)를 올바르게 읽을 수 있습니다. 이 조건은 “이 I/O 요청이 poll 의도를 갖고 들어왔는가?”를 보는 submit-side gate입니다.',
    '현재 src 기준 RWF_HIPRI는 include/uapi/linux/fs.h에 0x00000001로 정의되어 있고, IOCB_HIPRI는 include/linux/fs.h에서 RWF_HIPRI와 같은 bit로 정의됩니다. iocb->private는 이후 poll할 bio 포인터를 보관하는 연결 지점입니다.',
    [
      'RWF_HIPRI와 IOCB_HIPRI는 계층 이름이 다를 뿐 같은 bit입니다.',
      'kiocb는 bio가 아닙니다. file I/O 요청의 상위 설명서이고, bio는 block layer로 내려가는 I/O 단위입니다.',
      'iocb->private는 일반 의미의 private data라기보다 이 경로에서는 poll할 bio를 기억하는 자리로 쓰입니다.',
    ],
    ['block/fops.c의 IOCB_HIPRI 조건을 다시 읽습니다.', 'flag 전파 카드에서 이 조건이 REQ_POLLED로 바뀌는 지점을 확인합니다.'],
  ),
  'step2-flag-propagation': sections(
    'IOCB_HIPRI가 확인되면 block submit path는 bio->bi_opf에 REQ_POLLED를 붙입니다. 이후 bio->bi_opf는 blk_mq_alloc_data.cmd_flags로 들어가고, request 초기화에서 rq->cmd_flags가 됩니다.',
    'REQ_POLLED는 bio에 잠깐 붙는 표시가 아니라 queue routing을 바꾸는 flag입니다. rq->cmd_flags에 REQ_POLLED가 있으면 blk_mq_get_hctx_type()이 HCTX_TYPE_POLL을 선택합니다.',
    '현재 src 기준 block/fops.c는 IOCB_HIPRI면 bio->bi_opf |= REQ_POLLED를 수행합니다. fs/iomap/direct-io.c는 bio_set_polled()를 통해 같은 결과를 냅니다. block/blk-mq.c와 block/blk-mq.h가 이후 request flag와 hctx type 선택을 담당합니다.',
    [
      'IOCB_HIPRI와 REQ_POLLED를 같은 것으로 보면 안 됩니다. 하나는 상위 I/O 의도, 하나는 block-layer routing flag입니다.',
      'REQ_POLLED가 붙은 뒤 completion path에서 poll만 생략해도 이미 HCTX_TYPE_POLL로 들어갔을 수 있습니다.',
      '현재 src의 bio->bi_cookie는 request tag가 아니라 rq->mq_hctx->queue_num입니다.',
    ],
    ['blk_mq_get_hctx_type()에서 REQ_POLLED 분기를 확인합니다.', 'blk_mq_start_request()에서 bi_cookie 저장 방식을 확인합니다.'],
  ),
  'step2-dpas-518-comparison': sections(
    'DPAS 5.18 artifact는 interrupt mode를 completion path에서만 처리하지 않았습니다. block direct I/O와 iomap direct I/O submission path에서 IOCB_HIPRI와 REQ_POLLED를 직접 제거했습니다.',
    '이 차이는 migration에서 매우 중요합니다. 현재 src는 upstream 기본 동작만 있으므로 IOCB_HIPRI가 있으면 REQ_POLLED가 붙습니다. DPAS의 true interrupt mode를 재현하려면 이 submit-side 개입을 새 kernel 구조에 맞춰 다시 넣어야 합니다.',
    'DPAS 5.18의 kernel/block/fops.c와 kernel/fs/iomap/direct-io.c에는 “Enforce interrupt for polled I/O” 주석 아래 ki_flags와 bi_opf를 지우는 코드가 있습니다. 현재 src에는 같은 policy가 없고, bi_cookie 저장 방식도 blk_rq_to_qc(rq)에서 rq->mq_hctx->queue_num으로 바뀌었습니다.',
    [
      'DPAS interrupt mode는 polled I/O를 만든 뒤 poll만 안 하는 것이 아니었습니다.',
      'IOCB_HIPRI 제거는 상위 요청 의도를 없애는 것이고, REQ_POLLED 제거는 block-layer routing 의도를 없애는 것입니다.',
      '5.18 코드를 그대로 복사할 수는 없습니다. 현재 src의 helper 조건과 cookie 의미가 달라졌기 때문입니다.',
    ],
    ['현재 src의 block/fops.c와 fs/iomap/direct-io.c를 DPAS 5.18 코드와 나란히 비교합니다.', 'Part 6에서 true interrupt mode의 submit-side counter를 설계합니다.'],
  ),
  'step2-hook-candidates': sections(
    'Step 2에서 도출되는 hook 후보는 최소 두 군데입니다. block/fops.c는 raw block device direct I/O 경로이고, fs/iomap/direct-io.c는 filesystem direct I/O 경로입니다.',
    '한 곳만 보면 coverage가 부족할 수 있습니다. FIO나 실제 benchmark가 /dev/nvme0n1 같은 raw block device를 직접 때리는지, ext4/xfs 같은 filesystem 위 파일에 direct I/O를 내는지에 따라 필요한 hook이 달라집니다.',
    '현재 src에서 block/fops.c는 IOCB_HIPRI를 직접 보고 REQ_POLLED를 붙입니다. fs/iomap/direct-io.c는 IOCB_HIPRI와 !is_sync_kiocb(iocb)를 확인한 뒤 bio_set_polled()를 호출합니다. DPAS 5.18도 두 경로 모두에 interrupt enforcement를 넣었습니다.',
    [
      'block/fops.c만 수정하고 filesystem benchmark를 돌리면 효과가 안 보일 수 있습니다.',
      'iomap path는 sync DIO polling 조건을 따로 보므로 block/fops.c보다 조건을 조심해야 합니다.',
      'Part 4 PAS-only hook과 Part 6 interrupt-mode hook은 같은 위치일 필요가 없습니다.',
    ],
    ['현재 실험 workload가 raw block인지 filesystem DIO인지 확인합니다.', '먼저 block/fops.c smoke hook으로 관찰하고, 필요하면 iomap hook을 추가합니다.'],
  ),
  'concept-bi-cookie-tag': sections(
    'bi_cookie는 tag가 아니라 poll 대상 hardware queue 번호입니다. 최신 Step 1 기준 핵심 식은 bio->bi_cookie = rq->mq_hctx->queue_num이고, request->tag는 그 hctx 안에서 request가 차지한 slot 번호입니다.',
    '이 구분을 틀리면 bio_poll()과 blk_mq_poll()의 역할을 완전히 잘못 읽게 됩니다. bio_poll()은 tag로 request를 직접 찾는 함수가 아니라 cookie로 어느 hctx를 poll할지 찾는 함수입니다.',
    'Part 3 Step 1에서 가장 먼저 정정한 오해가 이 카드입니다. submit path의 blk_mq_start_request()가 cookie를 저장하고, poll path의 blk_mq_poll()이 q->queue_hw_ctx[cookie]로 hctx를 찾습니다.',
    [
      'bi_cookie = tag라고 읽으면 안 됩니다.',
      'BLK_QC_T_NONE은 poll할 대상이 아직 없거나 없다는 의미로 봐야 합니다.',
      'cookie는 request를 직접 가리키는 포인터가 아니라 queue index로 소비됩니다.',
    ],
    ['submit path 카드에서 cookie가 저장되는 시점을 확인합니다.', 'blk_mq_poll() 카드에서 cookie가 hctx lookup에 쓰이는 지점을 확인합니다.'],
  ),
  'path-submit-polled': sections(
    'Submit path는 I/O를 device로 보내는 길입니다. 사용자의 polling 의도는 IOCB_HIPRI 같은 flag로 들어오고, kernel은 bio->bi_opf에 REQ_POLLED를 붙인 뒤 blk-mq에서 HCTX_TYPE_POLL hctx를 선택하고 request를 NVMe submit queue로 보냅니다.',
    'poll path만 보면 bi_cookie가 어디서 생겼는지 알 수 없습니다. bi_cookie는 완료 확인 시점이 아니라 request가 실제 issue되는 submit 흐름에서 저장되며, 이후 poll path가 올바른 hctx를 찾을 수 있게 해 줍니다.',
    'Part 3 Step 1의 submit side 핵심 함수는 block/fops.c의 REQ_POLLED 설정부, block/blk-mq.h의 HCTX_TYPE_POLL 선택, block/blk-mq.c의 blk_mq_submit_bio()와 blk_mq_start_request()입니다.',
    [
      'submit path는 completion을 확인하는 경로가 아닙니다. device에 I/O를 내보내고 나중에 poll할 단서를 남기는 경로입니다.',
      'bi_cookie는 bio 생성 직후 항상 준비되는 값이 아니라 request start 시점에 저장됩니다.',
      'REQ_POLLED가 붙으면 queue mapping도 달라질 수 있으므로 interrupt mode 설계에서 submit path를 무시하면 안 됩니다.',
    ],
    ['poll path 카드로 넘어가 bi_cookie가 어떻게 소비되는지 봅니다.', 'REQ_POLLED 카드와 hctx 카드를 같이 보며 flag와 queue 선택을 연결합니다.'],
  ),
  'path-poll-completion': sections(
    'Poll completion path는 이미 submit된 I/O가 끝났는지 CPU가 직접 확인하는 길입니다. bio_poll()이 bio->bi_cookie를 읽고, blk_mq_poll()이 그 cookie로 hctx를 찾고, blk_hctx_poll()이 driver poll callback을 반복 호출하며, NVMe에서는 nvme_poll()이 CQ를 직접 확인합니다.',
    'DPAS의 PAS 아이디어는 이 경로 앞 또는 안쪽에 sleep-before-poll을 넣어 CPU busy polling 비용을 줄이는 것입니다. 따라서 poll path의 각 함수가 어떤 책임을 갖는지 알아야 hook 위치를 고를 수 있습니다.',
    'Step 1 결론은 최신 Linux 기본 poll loop에 PAS가 원하는 sleep이 없다는 것입니다. cpu_relax()는 sleep이 아니므로, Part 4에서는 bio_poll() 또는 blk_mq_poll() 근처에 별도 hook을 설계해야 합니다.',
    [
      'poll path는 submit path와 반대 방향의 "완료 확인" 경로입니다. 두 경로를 한 함수 안에서 모두 처리한다고 생각하면 혼동됩니다.',
      'bio_poll()은 NVMe CQ를 직접 보지 않습니다. blk-mq로 내려가는 entry입니다.',
      'nvme_poll()까지 내려가야 실제 completion queue entry를 확인합니다.',
    ],
    ['bio_poll(), blk_mq_poll(), blk_hctx_poll(), nvme_poll() 카드를 순서대로 확인합니다.', 'PAS hook 카드에서 어느 위치가 초기 포팅에 적합한지 비교합니다.'],
  ),
  'function-bio-poll': sections(
    'bio_poll()은 block layer의 polled completion entry입니다. bio->bi_cookie를 읽고, BLK_QC_T_NONE이면 poll 대상이 없으므로 0을 반환하며, queue가 유효하면 blk_mq_poll(q, cookie, ...)로 내려갑니다.',
    '이 함수는 user-facing poll 경로와 가까워 PAS hook 후보로 직관적입니다. 하지만 request/tag/hctx 내부 정보 접근은 제한적이어서 상태 관리가 필요한 DPAS 구현에는 blk_mq_poll()보다 불리할 수 있습니다.',
    'Step 1에서는 bio_poll()을 "bio에서 cookie를 꺼내 blk-mq poll로 넘기는 입구"로 정리합니다. DPAS 관점 메모는 hook 후보이지만 request/tag 직접 접근이 제한적이라는 점입니다.',
    [
      'bio_poll()은 completion queue를 직접 스캔하는 함수가 아닙니다.',
      'return 0은 보통 completion을 찾지 못했거나 poll할 수 없다는 뜻으로 읽어야 합니다.',
      'bio_poll() 위치가 직관적이라고 해서 항상 구현상 최선이라는 뜻은 아닙니다.',
    ],
    ['blk_mq_poll() 카드에서 cookie가 hctx로 바뀌는 지점을 확인합니다.', 'PAS hook 카드에서 bio_poll() 후보의 장단점을 비교합니다.'],
  ),
  'function-blk-mq-poll': sections(
    'blk_mq_poll()은 bio_poll()이 넘긴 cookie를 실제 hctx로 바꾸는 함수입니다. 핵심은 q->queue_hw_ctx[cookie]로 poll 대상 hardware context를 찾고, 그 hctx를 blk_hctx_poll()에 넘기는 것입니다.',
    '현재 Step 1 기준으로 PAS-only 초기 이식의 가장 유력한 후보입니다. block layer 공통 경로이고 hctx에 바로 접근할 수 있으며 NVMe에 종속되지 않기 때문입니다. 다만 hot path라 overhead와 locking/context 조건을 매우 조심해야 합니다.',
    'Part 3 Step 1과 hook 후보 평가에서 blk_mq_poll()은 "hctx 접근 가능, driver-independent, PAS hook 강력 후보"로 정리됩니다. Part 4에서는 이 판단을 로컬 최신 kernel 코드로 다시 확인해야 합니다.',
    [
      'blk_mq_poll()은 request tag로 request를 찾는 함수가 아닙니다.',
      '여기에 sleep 판단을 넣는다면 fast path overhead가 작아야 하고, poll flags와 reschedule 조건을 깨면 안 됩니다.',
      'hctx를 안다는 것과 DPAS state placement가 끝났다는 것은 다릅니다. state는 request_queue/per-CPU 구조로 별도 설계해야 합니다.',
    ],
    ['blk_hctx_poll() 카드에서 이 함수가 넘긴 hctx가 어떻게 driver callback으로 이어지는지 봅니다.', 'Part 4 Minimal PAS 카드에서 이 후보가 실제 구현 범위로 어떻게 줄어드는지 확인합니다.'],
  ),
  'function-blk-hctx-poll': sections(
    'blk_hctx_poll()은 hctx에 대해 driver의 mq_ops->poll() callback을 반복 호출하는 block layer polling loop입니다. ret > 0이면 완료를 찾은 것이고, oneshot이나 reschedule 조건에 따라 빠져나오며, 반복 중에는 cpu_relax()를 호출합니다.',
    '이 함수는 실제 polling loop에 가깝지만, 바로 여기에 PAS sleep을 넣는 것은 조심해야 합니다. 함수 책임이 driver callback 반복 호출에 가까워서 정책성 sleep과 mode state를 넣으면 계층 책임이 흐려질 수 있습니다.',
    'Step 1의 중요한 결론은 blk_hctx_poll() loop에 sleep/schedule이 없고 cpu_relax()만 있다는 점입니다. 이것이 "최신 Linux 기본 poll path에는 PAS sleep-before-poll이 없다"는 판단의 근거입니다.',
    [
      'cpu_relax()는 PAS sleep이 아닙니다. CPU busy-wait loop에서 쓰는 hint에 가깝습니다.',
      'driver callback 직전이라는 이유만으로 hook 위치가 좋다고 단정하면 안 됩니다.',
      'blk_hctx_poll()은 NVMe 전용 함수가 아니라 mq_ops->poll을 호출하는 block layer 함수입니다.',
    ],
    ['cpu_relax 오해 카드를 보고 sleep과 busy-wait hint를 분리합니다.', 'nvme_poll() 카드에서 mq_ops->poll이 실제 driver 구현으로 내려가는 과정을 봅니다.'],
  ),
  'function-nvme-poll': sections(
    'nvme_poll()은 NVMe driver의 poll callback입니다. blk_hctx_poll()에서 q->mq_ops->poll(hctx, iob)가 호출되면 NVMe queue가 poll queue인지 확인하고, CQ에 pending completion이 있는지 본 뒤 nvme_poll_cq()로 completion entry를 처리합니다.',
    'NVMe CQ와 가장 가까워서 실제 completion이 어디서 소비되는지 이해하기 좋습니다. 하지만 NVMe 전용 위치라서 block layer 일반성을 유지하려는 PAS/DPAS migration의 1차 hook으로는 blk_mq_poll()보다 우선순위가 낮습니다.',
    'Part 3 Step 1에서는 nvme_poll()을 poll path의 끝단으로 봅니다. 이후 NVMe queue mapping이나 interrupt mode를 다룰 때는 drivers/nvme/host/pci.c의 poll queue 조건과 CQ 처리 흐름을 다시 확인해야 합니다.',
    [
      'nvme_poll()은 polled I/O 전체의 시작점이 아니라 driver callback 끝단입니다.',
      '여기에 hook을 넣으면 NVMe 실험은 빠를 수 있지만 다른 block device로 일반화하기 어렵습니다.',
      'NVMe CQ 확인과 DPAS sleep 정책은 같은 문제가 아닙니다. 정책 위치와 device completion 위치를 분리해야 합니다.',
    ],
    ['blk_hctx_poll() 카드로 돌아가 driver callback 호출 위치를 확인합니다.', 'interrupt risk 카드에서 NVMe queue mapping과 REQ_POLLED 제어가 왜 별도 문제인지 봅니다.'],
  ),
  'concept-pas-sleep-before-poll': sections(
    'PAS sleep-before-poll은 busy polling을 바로 시작하지 않고 짧게 기다린 뒤 poll하는 아이디어입니다. I/O가 아직 완료되지 않았을 가능성이 높을 때 CPU를 태우며 계속 CQ를 보는 대신, 적절한 시간 동안 쉬고 다시 확인해 CPU 비용을 줄이려는 접근입니다.',
    'DPAS migration의 최소 구현 단위는 full state machine이 아니라 이 PAS hook을 최신 kernel poll path에 안전하게 넣는 것입니다. Step 1이 중요한 이유도 기본 poll loop에 sleep이 없고, bio_poll()/blk_mq_poll()/blk_hctx_poll()/nvme_poll() 중 어디가 책임상 맞는지 따져야 하기 때문입니다.',
    'Part 3 Step 1은 blk_mq_poll()을 1차 후보로 강하게 시사합니다. Part 4 Minimal PAS-only port는 이 후보를 실제 코드와 검증 계획으로 좁히는 단계입니다.',
    [
      'PAS는 cpu_relax()와 다릅니다. cpu_relax()는 sleep이 아니라 busy loop hint입니다.',
      'sleep을 너무 낮은 driver 위치에 넣으면 NVMe 전용이 되거나 block layer 책임이 흐려질 수 있습니다.',
      'sleep-before-poll은 성능 정책이므로 기능 동작뿐 아니라 latency, CPU 사용량, IOPS를 같이 봐야 합니다.',
    ],
    ['blk_mq_poll() 후보의 장단점을 다시 확인합니다.', 'Part 4 카드에서 PAS-only 범위를 full DPAS와 분리합니다.'],
  ),
  'concept-dpas-mode': sections(
    'DPAS mode switching은 하나의 고정 polling 정책이 아니라 부하 상태에 따라 CP, PAS normal, PAS overloaded, interrupt 계열 모드를 바꾸는 구조입니다. 논문 Figure 10의 state machine을 kernel의 per-CPU/per-queue state와 transition counter로 번역해야 합니다.',
    'Minimal PAS가 동작한다고 full DPAS가 끝나는 것은 아닙니다. full DPAS에는 mode counter, transition reason, UNDER/OVER update, timer failure 처리, interrupt mode의 submission-side 제어까지 필요합니다.',
    'Dpas-migration index에서는 Part 4가 Minimal PAS, Part 5가 mode switching, Part 6이 full interrupt mode와 NVMe queue mapping입니다. 이 카드는 Part 4 이후 범위가 왜 별도 단계로 나뉘는지 설명합니다.',
    [
      'DPAS는 단순히 sleep 값을 하나 정하는 알고리즘이 아닙니다.',
      'PAS-only와 full DPAS mode switching을 한 번에 구현하려 하면 hook 위치, state 위치, 검증 포인트가 섞입니다.',
      'interrupt mode는 completion path만 끊는 것으로 충분하지 않을 가능성이 큽니다.',
    ],
    ['paper DPAS state machine 카드에서 논문 모델을 먼저 확인합니다.', 'interrupt risk 카드에서 full interrupt mode가 왜 별도 검증 대상인지 봅니다.'],
  ),
  'risk-interrupt-submission': sections(
    'true interrupt mode는 completion path에서 poll을 건너뛰는 것만으로 충분하지 않을 수 있습니다. 이미 submit path에서 REQ_POLLED가 붙고 HCTX_TYPE_POLL queue로 들어간 I/O라면, 나중에 poll을 하지 않는다고 해서 일반 interrupt queue I/O가 된 것은 아니기 때문입니다.',
    'DPAS full mode switching에서 가장 큰 설계 리스크입니다. interrupt mode를 주장하려면 future I/O에서 REQ_POLLED를 제거하거나 queue mapping을 바꾸는 submission-side 근거가 필요할 수 있습니다.',
    'Part 3 Step 1은 이 리스크의 전제를 제공합니다. REQ_POLLED가 submit 시점에 queue 선택으로 이어지고, Part 6은 이 구조를 바탕으로 Full Interrupt Mode & NVMe Queue Mapping을 검증하는 단계입니다.',
    [
      'poll completion을 호출하지 않는 것과 interrupt queue에 제출하는 것은 다릅니다.',
      '이미 poll hctx로 들어간 request를 completion 단계에서만 바꾸기는 어렵습니다.',
      'FIO 결과에서 latency가 바뀌어도 queue mapping이 맞다는 증거는 아닙니다. counter와 submit-side trace가 필요합니다.',
    ],
    ['REQ_POLLED 카드와 submit path 카드를 다시 확인합니다.', 'Part 6 근거를 추가할 때 submission-side counter와 queue mapping 표를 카드화합니다.'],
  ),
  'part4-minimal-pas': sections(
    'Part 4는 full DPAS를 바로 옮기는 것이 아니라 PAS sleep-before-poll만 최신 kernel에 최소 형태로 올리는 단계입니다. 목표는 hook 위치, state placement, sysfs knob, sleep 결과 기록을 작게 닫고 성능 영향은 FIO로 확인할 준비를 하는 것입니다.',
    '작은 PAS-only 단계가 필요한 이유는 DPAS 전체를 한 번에 옮기면 실패 원인을 분리할 수 없기 때문입니다. sleep hook이 잘못된 것인지, mode switching이 잘못된 것인지, interrupt queue mapping이 잘못된 것인지 나중에 구분하기 어려워집니다.',
    'Part 3 Step 1은 blk_mq_poll()을 우선 hook 후보로 읽게 만들고, Part 4는 그 후보를 실제 patch 단위로 줄입니다. Part 5/6의 mode switching과 interrupt mode는 이 단계 밖으로 명확히 미룹니다.',
    [
      'Minimal PAS는 DPAS mode switching까지 포함하지 않습니다.',
      '처음부터 NVMe-only hook을 넣으면 빠르게 실험할 수 있지만 block layer 일반성은 잃을 수 있습니다.',
      'sleep duration과 UNDER/OVER update는 기능 검증과 성능 검증을 모두 요구합니다.',
    ],
    ['blk_mq_poll() 카드에서 1차 hook 후보 근거를 확인합니다.', 'Part 7 validation 카드에서 PAS-only가 어떤 지표로 검증돼야 하는지 봅니다.'],
  ),
  'part7-validation': sections(
    'Part 7은 구현이 "돌아간다"를 넘어서 DPAS/PAS 정책이 실제로 의도한 효과를 내는지 FIO microbenchmark로 확인하는 단계입니다. latency percentile, CPU 사용량, IOPS, mode breakdown counter, transition counter를 같이 봐야 합니다.',
    'DPAS는 성능 정책이므로 기능 compile만으로는 성공을 말할 수 없습니다. sleep-before-poll은 CPU를 줄일 수 있지만 latency tail을 악화시킬 수 있고, mode switching은 counter가 없으면 어떤 mode가 실제로 쓰였는지 알 수 없습니다.',
    'Dpas-migration index에서 Part 7은 Part 4/5/6 구현 뒤의 검증 계획입니다. Step 1에서 잡은 poll path 이해가 있어야 FIO 결과를 함수 경로와 counter로 해석할 수 있습니다.',
    [
      '평균 latency만 보면 tail latency 악화를 놓칠 수 있습니다.',
      'IOPS가 유지돼도 CPU 사용량이 줄었는지 별도 확인해야 합니다.',
      'mode counter가 없으면 DPAS가 어느 mode로 동작했는지 추측만 하게 됩니다.',
    ],
    ['PAS hook이 들어간 뒤 FIO로 latency, CPU, IOPS를 함께 봅니다.', 'Part 8/9 카드가 추가되면 regression과 final report 근거를 연결합니다.'],
  ),
  'mis-submit-vs-poll': sections(
    'submit path와 poll path는 서로 다른 시간의 경로입니다. submit path는 I/O를 device에 보내며 REQ_POLLED, HCTX_TYPE_POLL, bi_cookie 같은 단서를 남기는 쪽이고, poll path는 나중에 CPU가 completion queue를 직접 확인하는 쪽입니다.',
    '두 경로를 섞으면 bi_cookie가 어디서 생기는지, bio_poll()이 무엇을 찾는지, PAS hook이 어디에 들어가야 하는지 모두 헷갈립니다. Step 1은 이 둘을 분리해서 읽는 것이 거의 전부라고 봐도 됩니다.',
    'Part 3 Step 1은 submit 쪽을 IOCB_HIPRI -> REQ_POLLED -> HCTX_TYPE_POLL -> blk_mq_start_request()로, poll 쪽을 bio_poll() -> blk_mq_poll() -> blk_hctx_poll() -> nvme_poll()로 정리합니다.',
    [
      'submit path는 completion을 확인하지 않습니다.',
      'poll path는 bi_cookie를 만드는 곳이 아니라 사용하는 곳입니다.',
      'interrupt mode 리스크도 이 구분에서 나옵니다. queue 선택은 submit에서 이미 결정될 수 있습니다.',
    ],
    ['submit path와 poll path 카드를 나란히 열어 흐름을 비교합니다.', 'bi_cookie != tag 카드에서 두 경로를 이어 주는 값이 무엇인지 확인합니다.'],
  ),
  'mis-cpu-relax-sleep': sections(
    'cpu_relax()는 PAS sleep이 아닙니다. blk_hctx_poll()의 busy loop 안에서 CPU에게 spin-wait 중이라는 hint를 주는 역할에 가깝고, scheduler에 양보하며 일정 시간 잠드는 sleep-before-poll과는 의미가 다릅니다.',
    '이 오해를 풀어야 DPAS의 기여가 보입니다. 최신 Linux 기본 polling loop에 이미 PAS가 있는 것이 아니라, 기본 loop는 driver poll callback을 반복 호출하고 completion이 없으면 cpu_relax()를 거쳐 계속 돌 수 있습니다.',
    'Part 3 Step 1의 blk_hctx_poll() 해석에서 "기본 loop에는 sleep/schedule이 없다"는 결론이 나옵니다. 따라서 Part 4에서 별도 PAS hook 설계가 필요합니다.',
    [
      'cpu_relax()가 있으니 PAS가 이미 구현돼 있다고 말하면 안 됩니다.',
      'sleep-before-poll은 latency와 CPU tradeoff를 만드는 정책이고 cpu_relax()는 busy-wait loop hint입니다.',
      'cpu_relax 위치에 무조건 sleep을 넣는 것도 안전한 결론이 아닙니다. 함수 책임과 context를 봐야 합니다.',
    ],
    ['blk_hctx_poll() 카드에서 loop 구조를 다시 확인합니다.', 'PAS hook 카드에서 sleep을 넣을 후보 위치를 비교합니다.'],
  ),
  'paper-pas-core': sections(
    '논문 PAS의 핵심은 completion이 곧 오지 않을 때 CPU를 계속 태우며 poll하지 말고, 짧은 sleep 후 poll해서 CPU 비용을 줄이는 것입니다. kernel 코드로 번역하면 "poll을 시도하기 직전에 어디서, 얼마나, 어떤 상태를 보고 sleep할 것인가"라는 hook 문제로 바뀝니다.',
    '논문 figure만 보면 아이디어는 이해되지만, 최신 Linux에는 그대로 대응되는 함수가 없습니다. 그래서 Part 3 Step 1처럼 bio_poll(), blk_mq_poll(), blk_hctx_poll(), nvme_poll()의 책임을 먼저 나눠야 합니다.',
    'Part 2는 PAS/DPAS 논문 모델을 이해하는 단계이고, Part 3은 그 모델을 최신 kernel 함수와 hook 후보로 번역하는 단계입니다. 이 카드는 Part 2와 Part 4 사이의 bridge입니다.',
    [
      '논문 용어를 kernel 함수 이름으로 1:1 검색하면 안 됩니다.',
      'PAS는 "poll을 하지 말자"가 아니라 "바로 busy polling하지 말고 적절히 기다리자"에 가깝습니다.',
      'sleep 위치는 성능뿐 아니라 kernel context, locking, queue state 접근성도 함께 봐야 합니다.',
    ],
    ['Step 1 poll path 카드를 보고 논문 PAS가 들어갈 후보를 찾습니다.', 'Part 4 Minimal PAS 카드에서 이 아이디어를 작은 구현 범위로 줄입니다.'],
  ),
  'paper-dpas-state-machine': sections(
    '논문 DPAS state machine은 workload 상태에 따라 polling policy를 바꾸는 모델입니다. CP처럼 계속 poll할지, PAS normal처럼 sleep-before-poll을 적용할지, overloaded나 interrupt 계열로 물러날지를 상태와 transition rule로 결정합니다.',
    '이 모델을 kernel에 옮기려면 단순 sleep hook보다 더 많은 것이 필요합니다. per-CPU/per-queue state, UNDER/OVER 판정, mode counter, transition reason, timer failure handling, submission-side interrupt control이 모두 설계 대상입니다.',
    'Part 5는 Figure 10의 state machine을 최신 kernel mode switching 계획으로 옮기는 단계입니다. Part 6은 그중 interrupt mode가 completion path만으로 충분한지, REQ_POLLED와 queue mapping까지 손봐야 하는지를 별도로 검증합니다.',
    [
      'state machine을 구현하지 않아도 PAS-only 실험은 할 수 있습니다. 둘은 단계가 다릅니다.',
      'mode counter 없이 state machine이 맞게 돌았다고 판단하면 안 됩니다.',
      'interrupt state는 policy 이름만으로 정의되지 않습니다. 실제 submission queue와 completion 경로가 맞아야 합니다.',
    ],
    ['DPAS mode 카드에서 kernel-side state와 counter 요구사항을 확인합니다.', 'interrupt risk 카드에서 full interrupt mode의 범위를 분리합니다.'],
  ),
  'concept-ctx': sections(
    'blk_mq_ctx는 per-CPU software queue context입니다. submit하는 CPU마다 ctx가 있고, bio->bi_opf의 REQ_POLLED/READ 여부에 따라 ctx->hctxs[HCTX_TYPE_*]로 어느 hardware context에 request를 보낼지 결정합니다.',
    'ctx와 hctx를 구분하지 못하면 queue mapping과 DPAS state placement를 잘못 잡습니다. request에는 mq_ctx(software)와 mq_hctx(hardware)가 모두 붙으며, bi_cookie는 hctx->queue_num에서 옵니다.',
    '최신 kernel(block/blk-mq.h)에서 blk_mq_map_queue(opf, ctx)는 ctx->hctxs[blk_mq_get_hctx_type(opf)]를 반환합니다. REQ_POLLED면 HCTX_TYPE_POLL, READ면 HCTX_TYPE_READ, 아니면 DEFAULT입니다.',
    [
      'ctx는 CPU 번호와 1:1이지만 hctx와 1:1이 아닙니다.',
      'software queue(ctx)와 hardware queue(hctx)는 blk-mq의 두 축입니다.',
      'DPAS per-CPU state를 ctx에 둘지 hctx에 둘지는 설계 선택이며 아직 Part 4에서 확정되지 않았습니다.',
    ],
    ['hctx 카드에서 hardware side queue_num/cookie 관계를 확인합니다.', 'REQ_POLLED 카드에서 opf가 ctx->hctxs[] 선택에 미치는 영향을 봅니다.'],
  ),
  'concept-mq-ops': sections(
    'blk_mq_ops는 block layer가 driver와 통신하는 callback table입니다. queue_rq로 submit, poll로 polled completion 확인, complete로 interrupt completion 처리를 driver에 위임합니다.',
    'DPAS hook 위치를 고를 때 mq_ops 경계가 중요합니다. nvme_poll() 안에 hook을 넣으면 NVMe 실험은 빠르지만 block layer 일반성을 잃고, blk_mq_poll()에 두면 mq_ops->poll() 호출 전후에서 모든 poll-capable driver에 적용할 수 있습니다.',
    '최신 NVMe PCI driver(drivers/nvme/host/pci.c)는 nvme_mq_ops에 .queue_rq = nvme_queue_rq, .poll = nvme_poll을 등록합니다. blk_hctx_poll()은 q->mq_ops->poll(hctx, iob)만 반복 호출합니다.',
    [
      'mq_ops는 struct request_queue가 아니라 tag_set에 속합니다.',
      'poll callback이 NULL이면 polled I/O path가 성립하지 않습니다.',
      'complete callback은 interrupt path의 마지막 driver-side 단계입니다.',
    ],
    ['nvme_poll() 카드에서 mq_ops->poll 구현을 확인합니다.', 'interrupt completion 카드에서 mq_ops->complete 경로를 대조합니다.'],
  ),
  'function-blk-mq-start-request': sections(
    'blk_mq_start_request()는 driver가 request를 실제 issue할 때 block layer에 알리는 함수입니다. timeout, stats, state 전환 외에 polled bio라면 bio->bi_cookie = rq->mq_hctx->queue_num을 WRITE_ONCE로 저장합니다.',
    'bi_cookie가 어디서 생기는지 묻는 질문의 정답 함수입니다. submit path 전체를 훑기 전에 이 한 줄을 알면 poll path의 cookie lookup 의미가 명확해집니다.',
    '최신 kernel block/blk-mq.c:1391-1392에서 REQ_POLLED bio만 cookie를 저장합니다. NVMe nvme_queue_rq()가 SQ에 command를 쓰기 전후에 driver가 start_request를 호출하는 흐름과 연결해 봐야 합니다.',
    [
      'cookie는 request tag가 아닙니다.',
      'start_request 이전 bio_poll()은 BLK_QC_T_NONE을 볼 수 있습니다.',
      'WRITE_ONCE는 poll path와 submit path 간 race를 줄이기 위한 것입니다.',
    ],
    ['bi_cookie != tag 카드에서 cookie와 tag를 다시 분리합니다.', 'submit path 카드에서 start_request가 path 중 어디에 있는지 확인합니다.'],
  ),
  'path-interrupt-completion': sections(
    'Interrupt completion path는 device IRQ가 발생하면 driver handler가 CQ를 처리하고 blk_mq_complete_request()를 통해 request를 완료하는 경로입니다. 같은 CPU/cache domain이면 mq_ops->complete()를 바로 호출하고, 아니면 IPI와 BLOCK_SOFTIRQ를 거칩니다.',
    'kernel-io-completion-model 카드의 interrupt 쪽을 실제 함수 이름으로 채웁니다. polled path(bio_poll)와 대칭으로 알아야 DPAS interrupt mode가 무엇을 바꿔야 하는지 판단할 수 있습니다.',
    'block/blk-mq.c의 blk_mq_complete_request(), blk_mq_complete_request_remote(), blk_done_softirq()가 핵심입니다. NVMe PCI는 IRQ handler에서 CQ entry를 처리한 뒤 block layer complete path로 올라갑니다.',
    [
      'interrupt completion은 poll path와 반대로 CPU가 CQ를 직접 도는 loop가 아닙니다.',
      'completion path만 끊는다고 interrupt mode가 되지 않을 수 있습니다 (submit-side REQ_POLLED).',
      'softirq 경로는 latency와 CPU wake 패턴에 영향을 줍니다.',
    ],
    ['kernel-io-completion-model 카드에서 두 completion model을 비교합니다.', 'interrupt risk 카드에서 submission-side proof 필요성을 확인합니다.'],
  ),
  'path-io-uring-iopoll': sections(
    'io_uring IOPOLL 경로는 userspace가 IORING_SETUP_IOPOLL로 ring을 만들면 io_uring/rw.c에서 kiocb->ki_flags |= IOCB_HIPRI를 설정하고, block/fops.c에서 bio->bi_opf |= REQ_POLLED로 변환한 뒤, completion 시 file->f_op->iopoll (= iocb_bio_iopoll) -> bio_poll()로 이어집니다.',
    'Step 1 polled I/O 실험(FIO io_uring + hipri)이 kernel 어디로 들어오는지 보여줍니다. REQ_POLLED의 user-space 출발점을 알아야 Part 6에서 future I/O flag 제어를 설계할 수 있습니다.',
    '최신 kernel: io_uring/rw.c:876-881(IOPOLL setup), block/fops.c:381-384(HIPRI->REQ_POLLED + iocb->private=bio), block/blk-core.c:988-1017(iocb_bio_iopoll). HYBRID_IOPOLL은 별도 분기입니다.',
    [
      'IOCB_HIPRI와 RWF_HIPRI는 같은 bit입니다.',
      'iopoll은 direct I/O + file->f_op->iopoll 지원이 필요합니다.',
      'aio read/write와 io_uring IOPOLL은 submit flag 변환은 비슷하지만 poll 진입 mechanism이 다릅니다.',
    ],
    ['REQ_POLLED 카드에서 flag 변환 지점을 확인합니다.', 'bio_poll() 카드에서 iocb->private에 저장된 bio가 poll되는 과정을 봅니다.'],
  ),
  'part5-mode-switching': sections(
    'Part 5는 Part 4의 고정 sleep_ns PAS hook 위에 DPAS mode switching을 올리는 단계입니다. CP, PAS normal, PAS overloaded, interrupt transition을 kernel state, UNDER/OVER update, mode counter로 표현합니다.',
    'Minimal PAS가 동작해도 workload 적응형 DPAS는 별도 작업입니다. sleep 값 하나를 sysfs로 고정하는 것과 latency/queue depth에 따라 바꾸는 것은 구현 난이도와 검증 포인트가 다릅니다.',
    'Notion Part 5는 Figure 10 state machine 포팅 계획입니다. hook 위치(blk_mq_poll)는 Part 4와 같되, per-hctx/per-CPU state machine과 transition reason logging이 추가됩니다.',
    [
      'Part 5는 interrupt queue mapping(Part 6)과 동시에 구현하지 않는 것이 좋습니다.',
      'mode counter 없이 state machine만 넣으면 FIO 결과 해석이 불가능합니다.',
      'UNDER/OVER update는 논문 파라미터를 kernel sysctl/trace로 노출하는 작업을 포함합니다.',
    ],
    ['paper-dpas-state-machine 카드에서 논문 transition을 확인합니다.', 'Part 7 validation 카드에서 mode counter 관측 항목을 준비합니다.'],
  ),
  'part6-interrupt-mode': sections(
    'Part 6는 sustained overload에서 interrupt mode로 전환할 때 submission-side REQ_POLLED 제어, HCTX_TYPE mapping, NVMe poll/IRQ queue 분리를 검증하는 단계입니다. completion path에서 poll을 skip하는 것만으로는 부족할 수 있습니다.',
    'interrupt risk 카드의 설계 질문을 실제 검증 계획으로 바꿉니다. future I/O가 DEFAULT hctx/IRQ queue로 submit되는지 counter와 trace로 증명해야 합니다.',
    'Notion Part 6와 drivers/nvme/host/pci.c의 NVMEQ_POLLED, poll queue setup, IRQ handler 경로를 함께 봅니다. FIO latency 변화만으로 success를 판단하지 않습니다.',
    [
      'pseudo-interrupt(completion skip only)와 true interrupt mode를 구분해야 합니다.',
      '이미 POLL hctx에 들어간 inflight I/O와 future I/O는 다르게 다룰 수 있습니다.',
      'NVMe queue mapping 표와 REQ_POLLED counter가 Part 6 산출물 후보입니다.',
    ],
    ['interrupt risk 카드에서 submission-side proof 요구사항을 확인합니다.', 'path-interrupt-completion 카드에서 IRQ complete path를 대조합니다.'],
  ),
};
