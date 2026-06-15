# DPAS 학습 노트

> 이 문서는 `history/` 폴더의 일일 기록과 실제 `dpas-kernel/` 소스를 종합해서, DPAS 전체 맥락과 핵심 개념을 한 눈에 복기할 수 있도록 정리한 것이다.
> 대상 독자: 나 자신. 다시 DPAS 작업을 이어할 때 "지금까지 뭘 했고 무엇이 핵심인가"를 빠르게 복구하기 위함.
>
> 코드 인용은 모두 현재 `dpas-kernel/` 트리에서 가져왔고, `파일::함수` 형태로 출처를 표기한다.

---

## 0. 30초 요약 (먼저 보는 그림)

```
 user: preadv2(fd, ..., RWF_HIPRI)   또는   fio --hipri=1
        │  kiocb.ki_flags |= IOCB_HIPRI
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ SUBMIT PATH                                                │
 │   fs/iomap/direct-io.c   (ext4/xfs file DIO)               │
 │   block/fops.c           (raw /dev/nvme0n1)                │
 │     └─▶ blk_dpas_prepare_bio()  ◀── ★DPAS submit 훅★       │
 │           현재 mode를 보고 REQ_POLLED를 set / clear         │
 └──────────────────────────────────────────────────────────┘
        │  submit_bio()
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ blk-mq:  bio ─▶ request                                    │
 │   blk_mq_start_request(): bio->bi_cookie = hctx->queue_num │
 └──────────────────────────────────────────────────────────┘
        │  (sync DIO wait loop가 bio_poll() 반복 호출)
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ POLL PATH:  blk_mq_poll_bio()   ◀── ★DPAS poll 훅★         │
 │   1) sleep  : PAS bucket-sleep / LHP sleep / CP no-sleep   │
 │   2) poll   : nvme_poll()                                  │
 │   3) complete: over/under 판정 + blk_dpas_maybe_switch_mode│
 └──────────────────────────────────────────────────────────┘
        │  q->mq_ops->poll(hctx)
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ driver: drivers/nvme/host/pci.c::nvme_poll()               │
 │   CQ를 직접 긁어서 완료를 찾는다 (인터럽트 안 기다림)        │
 └──────────────────────────────────────────────────────────┘
```

> 핵심 한 줄: **"HIPRI I/O가 들어오면 현재 mode(INT/CP/PAS/OL)에 맞춰 REQ_POLLED를 켜거나 끄고(submit 훅), polling이면 poll 직전에 적절히 자서 CPU를 아끼고(poll 훅), 관찰 결과로 mode를 자동 전환한다(switch)."**

---

## 1. DPAS는 무엇인가

**DPAS** = Dynamic Polling/Interrupt Switching. 하위 기법으로 PAS(Poll-After-Sleep), LHP(Low-power Hybrid Polling) 등을 포함한다.

목표는 단순하다:

> NVMe SSD 같은 고속 블록 장치에서, **I/O latency를 줄이면서도 CPU를 낭비하지 않도록** polling과 interrupt를 상황에 따라 바꿔 쓰자.

CPU가 계속 spin하면서 장치를 확인하는 것을 **classic polling (CP)** 라고 한다. latency는 낮지만 CPU를 100% 쓴다.
반면 interrupt를 기다리면 CPU는 낮지만 latency가 높아진다.

```
   [실행 동작 스펙트럼 — "어떻게 완료를 기다리나"]
   latency 낮음 ◀───────────────────────────────▶ latency 높음
   CPU 100%                                        CPU 거의 0

   CP ───────── PAS ───────── LHP ───────── INT
   (busy spin) (학습 sleep)  (평균/2 sleep) (인터럽트)
```

```
   [full DPAS 자동 전환은 LHP를 포함하지 않는다]
   enum dpas_mode = { INT, CP, PAS, OL }     ← LHP 없음! ★

        cp_cnt>=p6
      ┌───────────┐
      ▼           │
     CP          PAS ⇄ OL ───▶ INT
      ▲           │    │         │ int_cnt>=p7
      └───────────┘    │         │ (submit path)
   param4&&QD≈1    avg_qd≤p2 ↑   └─────────────┘
                   avg_qd>p3 ─────────▶ INT

   LHP 는 pas_enabled=0 + io_poll_delay=0 인 "별도 정적 구성"이다.
   PAS 의 대안일 뿐, 자동 전환 대상이 아니다.
   (전환 로직은 전부 pas_enabled 경로 안에 있어서 LHP와 배타적)
```

DPAS는 이 스펙트럼 위의 여러 동작을 두고 쓴다. 단, **자동 전환(full DPAS, `switch_enabled=1`)이 오가는 집합은 `{CP, PAS, OL, INT}` 뿐이고 LHP는 빠진다.** LHP는 `pas_enabled=0`일 때 선택하는 PAS의 정적 대안이며, polling 직전에 잠깐 자서 CPU를 아낀다는 점만 PAS와 공유한다.

### 주요 모드 요약

| 모드 | 이름 | 핵심 동작 | sysfs knob 대략 |
|---|---|---|---|
| INT | Interrupt | `REQ_POLLED`를 끄고 인터럽트로 I/O | submit 단계에서 `IOCB_HIPRI` 제거 |
| CP  | Classic Polling | sleep 없이 busy-spin polling | `io_poll_delay=-1`, `pas_enabled=0` |
| LHP | Low-power Hybrid Polling | 평균 latency의 절반만큼 자고 poll | `io_poll_delay=0`, `pas_enabled=0` |
| PAS | Poll-After-Sleep | bucket별 학습된 sleep 후 poll | `pas_enabled=1`, `pas_adaptive_enabled=0/1/2` |
| OL  | OverLoad | I/O가 몰릴 때의 관찰/완충 모드 | full DPAS(`switch_enabled=1`)가 내부적으로 사용 |
| EHP | Early Hint Polling | bucket별로 poll/interrupt를 미리 결정 | `ehp_enabled` (5.18 개념, 7.1엔 knob만 존재) |

`enum dpas_mode`는 실제로 4개만 정의돼 있다 (`include/linux/blkdev.h`). **표의 LHP/EHP는 별도 knob 조합으로 켜는 동작이지, 자동 전환이 오가는 모드가 아니다.**

```c
enum dpas_mode {
	/* full DPAS가 I/O를 보낼 때 선택하는 실행 모드 */
	DPAS_MODE_INT = 0,
	DPAS_MODE_CP  = 1,
	DPAS_MODE_PAS = 2,
	DPAS_MODE_OL  = 3,
};
```

> 상태 업데이트(2026-06): 7.1 `dpas-kernel`은 INT/CP/LHP/PAS 단독 동작뿐 아니라 **full mode switching(PAS↔OL↔INT↔CP 자동 전환)까지 구현되어 있다.** `switch_enabled=1`이면 `blk_dpas_maybe_switch_mode()`가 관찰 window마다 mode를 바꾼다. (이전 노트는 "설계/구현 중"이라고 적었으나 더 이상 사실이 아니다 — 6절·9절 참고.)

---

## 2. 핵심 데이터 구조

### 2.1 세 구조체의 관계

```
 struct kiocb  ── "이 I/O 요청의 신분증"
   ├ ki_filp     → 사용자가 연 파일/디바이스
   ├ ki_pos      → 현재 I/O offset
   ├ ki_flags    → IOCB_HIPRI / IOCB_NOWAIT / IOCB_DIRECT
   └ ki_complete → AIO/io_uring 완료 콜백
        │   submit 단계가 이 kiocb로부터 bio를 만든다
        ▼
 struct bio    ── "디스크로 보내는 I/O 요청서(데이터 자체가 아님)"
   ├ bi_bdev   → 실제로 갈 block device
   ├ bi_opf    → READ/WRITE | REQ_POLLED | REQ_NOWAIT
   ├ bi_iter   → 시작 sector, 길이
   ├ bi_io_vec → 데이터가 담긴 물리 페이지 배열
   ├ bi_cookie → poll할 hctx 번호  ◀───────────────┐
   ├ bi_end_io → 완료 시 호출될 콜백                 │  blk_mq_start_request()에서 채움
   └ bi_private → 콜백에 넘길 추가 데이터             │
        │   blk-mq가 bio들을 합쳐 request로 만든다    │
        ▼                                          │
 struct request ── "blk-mq 스케줄링 단위"            │
   └ mq_hctx->queue_num ──────────────────────────┘
        (bi_cookie = rq->mq_hctx->queue_num)
```

### 2.2 `struct kiocb`

VFS read/write, Direct I/O, libaio(`io_submit`), io_uring 모두 `kiocb`를 거친다.
사용자가 `RWF_HIPRI`나 io_uring polling을 요청하면 `kiocb->ki_flags`에 `IOCB_HIPRI`가 붙는다. DPAS는 이 플래그를 보고 "이 I/O를 polling으로 볼 것인가?"를 판단한다.

### 2.3 `struct bio`

bio는 데이터 그 자체가 아니라, **데이터가 어디 있고 어디로 가야 하는지, 무슨 연산을 해야 하는지**를 적은 패킷이다.
파일시스템의 경우 `kiocb->ki_filp`는 파일을 가리키지만 `bio->bi_bdev`는 그 파일이 저장된 실제 디스크를 가리킨다. raw block device의 경우 둘이 같은 디스크다.

### 2.4 `struct request`

blk-mq가 bio를 변환/합쳐서 만든 것. 여러 bio가 하나의 request에 합쳐질 수 있다. bio polling 경로에서는 나중에 `bio->bi_cookie`로 "어느 hctx를 poll해야 하는가"를 복원한다.

### 2.5 `struct blk_rq_pas_stat` — PAS sleep 학습 상태 (per-CPU, bucket별)

실제 정의 (`include/linux/blk_types.h`):

```c
struct blk_rq_pas_stat {
	u64       dur;             /* 이번 세대의 sleep duration (ns) */
	long long adj;             /* duration 조정 계수 (fixed-point, q->div 기준) */
	long long up;              /* undersleep 시 증가폭 */
	long long dn;              /* oversleep 시 감소폭 */

	u8 sr_pnlt;                /* 전전번 sleep 결과 (0=oversleep, 1=undersleep) */
	u8 sr_last;                /* 직전 sleep 결과 */
	u8 update_req;             /* 다음 sleep 진입 시 duration 갱신 pending */
	u8 dur_cnt;                /* 현재 duration "세대" 번호 */
	u8 dur_cnt_checked;        /* 이 세대 결과가 이미 반영됐는지 */
};
```

이 구조체는 `q->pas_stat`에 **per-CPU 배열**로 들어 있고, bucket index로 접근한다 (`q->pas_stat[cpu][bucket]`).

### 2.6 `struct request_queue`의 DPAS 필드 (상태는 이제 queue 레벨로 통일)

5.18은 per-CPU `struct blk_switch`에 상태를 흩어 두었지만, 7.1 `dpas-kernel`은 거의 모든 DPAS 상태를 `request_queue`에 모았다 (`include/linux/blkdev.h`):

```c
struct request_queue {
	...
	int			poll_nsec;        /* -1=CP, 0=adaptive LHP, >0=fixed LHP */
	struct blk_rq_stat	*poll_stat;       /* bucket별 평균 latency (LHP용) */
	struct blk_rq_pas_stat __percpu *pas_stat; /* PAS 학습 상태 (per-CPU) */

	spinlock_t		dpas_lock;        /* ★DPAS mode/counter/qd 보호 (진짜 lock!)★ */
	enum dpas_mode		dpas_mode;        /* 현재 full DPAS 모드 */

	/* mode별 평가 window에서 submit된 HIPRI I/O 개수 */
	u32			dpas_cp_cnt;
	u32			dpas_pas_cnt;
	u32			dpas_ol_cnt;
	u32			dpas_int_cnt;

	/* PAS/OL 전환 판단용 poll-sleep 구간의 queue depth 표본 */
	u32			dpas_qd;
	u64			dpas_qd_sum;
	u32			dpas_tf;          /* PAS duration이 d_init 최저값에 걸린 횟수 */

	int pas_enabled;
	int pas_adaptive_enabled;             /* 0=off, 1=DPAS1, 2=DPAS2 */
	int ehp_enabled;
	int switch_enabled;                   /* 1이면 full mode switching ON */
	int switch_param1; /* PAS->OL 전환 tf 임계값 */
	int switch_param2; /* OL->PAS 전환 평균 QD 임계값(x10) */
	int switch_param3; /* OL->INT 전환 평균 QD 임계값(x10) */
	int switch_param4; /* PAS->CP 전환 허용 여부 */
	int switch_param5; /* PAS/OL 모드 평가 I/O 개수 */
	int switch_param6; /* CP 모드 평가 I/O 개수 */
	int switch_param7; /* INT 모드 평가 I/O 개수 */

	u64 div;            /* fixed-point 분모 */
	u32 d_init;         /* sleep duration 하한 (us 단위 초기값) */
	long long up_init, dn_init;
	long long heat_up, cool_dn;           /* adaptive up/dn 가감속 (DPAS/DPAS2) */
	long long min_dn, max_dn;
	int updn_ratio;
	...
};
```

> **5.18 대비 핵심 변화**: 상태가 per-CPU `blk_switch`에서 `request_queue` 한 곳으로 모였고, `N_POLL` 같은 약한 가짜 int lock 대신 **진짜 `spinlock_t dpas_lock`** 이 생겼다. submit path와 poll path가 동시에 `dpas_mode`를 보기 때문에 이 lock으로 보호한다.

---

## 3. I/O 하나가 polling 경로를 타는 전체 흐름

### 3.1 제출 단계 (submit path) — ★이제 DPAS 훅이 단일 helper로 통일됨★

5.18은 경로마다 mode 훅이 흩어져 있었지만, 7.1은 `blk_dpas_prepare_bio()` **한 함수**로 모았다. 두 제출 경로가 모두 이 helper를 호출한다.

**(1) 파일시스템 DIO 경로** (`fs/iomap/direct-io.c::iomap_dio_submit_bio`):

```c
if (iocb->ki_flags & IOCB_HIPRI) {
	if (blk_dpas_prepare_bio(bdev_get_queue(bio->bi_bdev), bio, iocb))
		dio->submit.poll_bio = bio;
}
```

**(2) raw block device async 경로** (`block/fops.c::__blkdev_direct_IO_async`):

```c
if (iocb->ki_flags & IOCB_HIPRI &&
    blk_dpas_prepare_bio(bdev_get_queue(bio->bi_bdev), bio, iocb)) {
	submit_bio(bio);
	WRITE_ONCE(iocb->private, bio);
} else {
	submit_bio(bio);
}
```

helper의 반환값(`polled`)이 true면 "이 bio를 나중에 poll하라"는 뜻이고, false면 INT 모드라 인터럽트로 완료를 기다린다.

**`blk_dpas_prepare_bio()` 본체** (`block/blk-core.c`) — mode별로 `REQ_POLLED`를 set/clear하고, 동시에 각 mode의 평가 카운터를 증가시킨다:

```c
bool blk_dpas_prepare_bio(struct request_queue *q, struct bio *bio,
			  struct kiocb *iocb)
{
	bool polled = true;
	unsigned long flags;

	if (!q->switch_enabled) {
		/* full DPAS off: 기존 HIPRI polling 동작 그대로 */
		bio_set_polled(bio, iocb);
		return true;
	}

	spin_lock_irqsave(&q->dpas_lock, flags);
	switch (q->dpas_mode) {
	case DPAS_MODE_INT:
		/* interrupt 모드: HIPRI여도 REQ_POLLED 제거 */
		iocb->ki_flags &= ~IOCB_HIPRI;
		bio_clear_polled(bio);
		q->dpas_int_cnt++;
		if (q->dpas_int_cnt >= q->switch_param7) {
			q->dpas_mode = DPAS_MODE_OL;   /* INT window 다 채우면 OL로 */
			q->dpas_ol_cnt = 0;
			q->dpas_qd_sum = 0;
			q->dpas_tf = 0;
		}
		polled = false;
		break;
	case DPAS_MODE_CP:                          /* classic polling */
		bio_set_polled(bio, iocb); q->dpas_cp_cnt++; break;
	case DPAS_MODE_PAS:                         /* adaptive sleep 후 poll */
		bio_set_polled(bio, iocb); q->dpas_pas_cnt++; break;
	case DPAS_MODE_OL:                          /* overload 관찰 */
		bio_set_polled(bio, iocb); q->dpas_ol_cnt++; break;
	default:
		bio_set_polled(bio, iocb); break;
	}
	spin_unlock_irqrestore(&q->dpas_lock, flags);
	return polled;
}
```

> 포인트: **INT 모드만 유일하게 submit 단계에서 mode 전환(INT→OL)을 한다.** 왜냐하면 INT I/O는 poll path를 타지 않아서, poll 쪽 `blk_dpas_maybe_switch_mode()`가 INT를 빠져나올 기회가 없기 때문이다.

### 3.2 request 시작 — cookie 기록

`block/blk-mq.c::blk_mq_start_request()`:

```c
if (rq->bio && rq->bio->bi_opf & REQ_POLLED)
	WRITE_ONCE(rq->bio->bi_cookie, rq->mq_hctx->queue_num);
```

request가 시작될 때 polled bio의 `bi_cookie`에 hctx 번호를 기록한다. 나중에 `bio_poll()`은 이 cookie로 어떤 hctx를 poll할지 찾는다.

### 3.3 대기/polling 단계 (poll path)

sync DIO는 `fs/iomap/direct-io.c::__iomap_dio_rw()` 안에서 다음 루프를 돈다:

```c
for (;;) {
	set_current_state(TASK_UNINTERRUPTIBLE);
	if (!READ_ONCE(dio->submit.waiter))
		break;                               /* I/O 완료 */

	if (dio->submit.poll_bio &&
		(dio->submit.poll_bio->bi_opf & REQ_POLLED))
		bio_poll(dio->submit.poll_bio, NULL, 0);  /* 같은 bio 반복 poll */
	else
		blk_io_schedule();                   /* INT면 그냥 잔다 */
}
__set_current_state(TASK_RUNNING);
```

`bio_poll()`은 cookie로 queue를 찾아 `blk_mq_poll_bio()`로 들어간다 (`block/blk-core.c::bio_poll`):

```c
int bio_poll(struct bio *bio, struct io_comp_batch *iob, unsigned int flags)
{
	blk_qc_t cookie = READ_ONCE(bio->bi_cookie);
	...
	q = bdev_get_queue(bdev);
	if (cookie == BLK_QC_T_NONE)
		return 0;
	...
	if (queue_is_mq(q))
		ret = blk_mq_poll_bio(q, bio, cookie, iob, flags);
	...
}
```

전체 호출 그림:

```
 bio_poll(bio)
   ├ cookie = bio->bi_cookie
   ├ q = bdev_get_queue(bio->bi_bdev)
   └ blk_mq_poll_bio(q, bio, cookie, ...)
        ├ 1) sleep:  pas_enabled ? blk_mq_poll_pas_sleep()
        │                        : blk_mq_poll_lhp_sleep()
        ├ 2) poll :  __blk_hctx_poll() → q->mq_ops->poll() → nvme_poll()
        └ 3) done :  blk_mq_poll_pas_complete()  (+ maybe_switch_mode)
```

---

## 4. PAS(Poll-After-Sleep) 핵심 개념

### 4.1 poll path 3단계 — `blk_mq_poll_bio()`

PAS의 모든 마법은 이 함수의 **sleep → poll → complete** 3단계에 들어 있다 (`block/blk-mq.c`):

```c
int blk_mq_poll_bio(struct request_queue *q, struct bio *bio, blk_qc_t cookie,
		struct io_comp_batch *iob, unsigned int flags)
{
	struct blk_mq_pas_poll_ctx pas = {};
	struct blk_mq_hw_ctx *hctx;
	unsigned int poll_count = 0;
	int ret;

	if (!blk_mq_can_poll(q))
		return 0;
	hctx = q->queue_hw_ctx[cookie];

	/* 1) SLEEP: PAS면 bucket-sleep, 아니면 LHP sleep */
	if (q->pas_enabled)
		blk_mq_poll_pas_sleep(q, bio, flags, &pas);
	else
		blk_mq_poll_lhp_sleep(q, bio, flags);

	/* 2) POLL: 실제 디바이스 큐를 긁는다. poll_count = 깬 뒤 돈 횟수 */
	ret = __blk_hctx_poll(q, hctx, iob, flags, &poll_count);

	/* 3) COMPLETE: over/under 판정 + (switch면) mode 전환 */
	blk_mq_poll_pas_complete(q, &pas, ret, poll_count);
	return ret;
}
```

```
   ┌── 1) SLEEP ───────────────────────────────────────────┐
   │   pas_enabled ? blk_mq_poll_pas_sleep()  ← bucket dur   │
   │               : blk_mq_poll_lhp_sleep()  ← fixed/avg½   │
   └────────────────────────────────────────────────────────┘
   ┌── 2) POLL ────────────────────────────────────────────┐
   │   __blk_hctx_poll() → nvme_poll()                      │
   │   poll_count = 깬 뒤 완료까지 돌린 spin 횟수            │
   └────────────────────────────────────────────────────────┘
   ┌── 3) COMPLETE ────────────────────────────────────────┐
   │   poll_count==0 → OVERSLEEP / >0 → UNDERSLEEP          │
   │   결과를 stat에 기록 → 다음 sleep duration 갱신 예약    │
   └────────────────────────────────────────────────────────┘
```

### 4.2 Bucket — read/write × 크기별로 sleep을 따로 학습

```
 bucket = ddir + 2 * ilog2(sectors)        ddir: read=0, write=1

   sectors=8 (4KB):  ilog2(8)=3
     read  : 0 + 2*3 = 6   (짝수)
     write : 1 + 2*3 = 7   (홀수)

   index:  [0][1] [2][3] [4][5] [6][7] ... [14][15]
   dir  :   r  w   r  w   r  w   r  w        r   w
            └─ 작은 IO ───────────────────── 큰 IO ─┘
   (bucket >= 16 이면 ddir + 14 로 clamp)
```

실제 코드 (`block/blk-mq.c::blk_mq_poll_pas_bucket`):

```c
static int blk_mq_poll_pas_bucket(const struct bio *bio)
{
	unsigned int sectors;
	int ddir, bucket;

	if (!bio) return -1;
	if (bio_op(bio) != REQ_OP_READ && bio_op(bio) != REQ_OP_WRITE)
		return -1;
	sectors = bio_sectors(bio);
	if (!sectors) return -1;

	ddir = op_is_write(bio_op(bio)) ? 1 : 0;
	bucket = ddir + 2 * ilog2(sectors);

	if (bucket >= BLK_MQ_POLL_STATS_BKTS)            /* 16 */
		return ddir + BLK_MQ_POLL_STATS_BKTS - 2;
	return bucket;
}
```

### 4.3 sleep 단계 본체 — `blk_mq_poll_pas_sleep()`

자기 전에 duration을 갱신하고, 자는 동안의 queue depth 표본을 모은다:

```c
static void blk_mq_poll_pas_sleep(struct request_queue *q, struct bio *bio,
				  unsigned int flags, struct blk_mq_pas_poll_ctx *ctx)
{
	...
	if (q->switch_enabled && q->dpas_mode == DPAS_MODE_CP) {
		/* CP는 sleep 없이 전이 조건만 검사 */
		spin_lock_irqsave(&q->dpas_lock, lock_flags);
		blk_dpas_maybe_switch_mode(q);
		spin_unlock_irqrestore(&q->dpas_lock, lock_flags);
		return;
	}
	if (!q->pas_enabled || !q->pas_stat) return;
	if (flags & BLK_POLL_ONESHOT) return;
	if (!bio || bio_flagged(bio, BIO_LHP_POLL_SLEPT)) return;   /* 중복 sleep guard */

	bucket = blk_mq_poll_pas_bucket(bio);
	if (bucket < 0) return;

	cpu  = get_cpu();
	stat = per_cpu_ptr(q->pas_stat, cpu);

	if (q->switch_enabled) {                 /* PAS/OL 전환용 QD 표본 누적 */
		spin_lock_irqsave(&q->dpas_lock, lock_flags);
		q->dpas_qd++;
		q->dpas_qd_sum += q->dpas_qd;
		spin_unlock_irqrestore(&q->dpas_lock, lock_flags);
	}

	blk_mq_poll_pas_update_duration(q, &stat[bucket]);   /* 직전 결과 반영 */
	nsecs   = READ_ONCE(stat[bucket].dur);
	dur_cnt = stat[bucket].dur_cnt;
	q->last_poll_count++;
	put_cpu();

	if (!blk_mq_poll_sleep_nsec(bio, nsecs))   /* 실제 hrtimer sleep */
		goto out_qd;

	ctx->active = true;                        /* complete 단계에 넘길 컨텍스트 */
	ctx->cpu = cpu; ctx->bucket = bucket;
	ctx->dur_cnt = dur_cnt; ctx->dur = nsecs;
out_qd:
	if (q->switch_enabled) { /* QD 표본 되돌리기 */ ... }
}
```

### 4.4 oversleep / undersleep 판정과 duration 갱신

```
 깬 뒤 poll_count 로 판정:
   poll_count == 0  → OVERSLEEP  (자고 일어났더니 이미 완료 = latency 직접 낭비)
   poll_count  > 0  → UNDERSLEEP (덜 자서 깬 뒤 또 돌림 = CPU 낭비)
```

complete 단계가 결과를 `sr_pnlt`/`sr_last`에 밀어 넣는다 (`blk_mq_poll_pas_complete`):

```c
if (ctx->dur_cnt == stat[ctx->bucket].dur_cnt &&
    stat[ctx->bucket].dur_cnt != stat[ctx->bucket].dur_cnt_checked) {
	stat[ctx->bucket].dur_cnt_checked = stat[ctx->bucket].dur_cnt;
	stat[ctx->bucket].sr_pnlt = stat[ctx->bucket].sr_last;          /* 한 칸 밀기 */
	stat[ctx->bucket].sr_last = poll_count <= q->poll_threshold ? 0 : 1;
	stat[ctx->bucket].update_req = 1;                               /* 다음 sleep때 반영 */
}
```

그리고 다음 sleep 진입 때 `blk_mq_poll_pas_update_duration()`이 두 결과 조합으로 `adj`를 정하고 duration을 곱셈 보정한다:

```
   sr_pnlt sr_last  cur_case  의미          adj
   ────────────────────────────────────────────────
     0       0        0      over → over    adj -= dn       (sleep ↓)
     0       1        1      over → under   adj = div + up
     1       0        2      under → over   adj = div - dn
     1       1        3      under → under  adj += up       (sleep ↑)

   dur = dur * adj / div
   if (dur < d_init) { dur = d_init; if (switch_enabled) dpas_tf++; }
```

실제 코드:

```c
cur_case = stat->sr_pnlt * 2 + stat->sr_last;
switch (cur_case) {
case 0: stat->adj -= stat->dn;        break;   /* over, over   */
case 1: stat->adj = q->div + stat->up; break;  /* over, under  */
case 2: stat->adj = q->div - stat->dn; break;  /* under, over  */
case 3: stat->adj += stat->up;        break;   /* under, under */
}
if (stat->adj <= 0) stat->adj = q->div;

stat->dur = mul_u64_u64_div_u64(stat->dur, (u64)stat->adj, q->div);
if (stat->dur < q->d_init) {
	stat->dur = q->d_init;
	if (q->switch_enabled) {
		spin_lock_irqsave(&q->dpas_lock, lock_flags);
		q->dpas_tf++;             /* duration이 바닥에 자주 깔림 → PAS->OL 신호 */
		spin_unlock_irqrestore(&q->dpas_lock, lock_flags);
	}
}
stat->dur_cnt++;
```

### 4.5 up < dn 비대칭의 의미

```
   OVERSLEEP  (latency를 직접 까먹음)  → dn 으로 빠르게 줄인다
   UNDERSLEEP (CPU만 조금 더 씀)       → up 으로 천천히 늘린다
                                        => 보통 up < dn
```
oversleep은 사용자 체감 latency를 바로 갉아먹으므로 공격적으로 줄이고, undersleep은 CPU만 약간 더 쓰는 것이라 보수적으로 늘린다.

### 4.6 adaptive up/dn (`pas_adaptive_enabled`)

- **DPAS1 (`=1`)**: `dn`을 heat_up/cool_dn으로 가감속하고 `up = dn / updn_ratio`로 유도.
- **DPAS2 (`=2`)**: `up`만 가감속, `dn`은 그대로.

```c
if (q->pas_adaptive_enabled) {
	if (cur_case == 0 || cur_case == 3) {           /* 같은 판정 2연속 → heat up */
		if (q->pas_adaptive_enabled == 1) {
			stat->dn = stat->dn * (q->div + q->heat_up) / q->div;
			if (stat->dn > q->max_dn) stat->dn = q->max_dn;
			stat->up = stat->dn / q->updn_ratio;
		} else if (q->pas_adaptive_enabled == 2) {
			stat->up = stat->up * (q->div + q->heat_up) / q->div;
			if (stat->up > q->div / 10) stat->up = q->div / 10;
		}
	} else {                                        /* 판정 뒤집힘 → cool down */
		stat->up = stat->up * (q->div - q->cool_dn) / q->div;
		...
	}
}
```

### 4.7 중복 sleep 방지 guard — `BIO_LHP_POLL_SLEPT`

같은 bio가 완료 전에 `bio_poll()`로 여러 번 재진입할 수 있다. sleep은 첫 진입에서 한 번만 해야 한다. `blk_mq_poll_sleep_nsec()`가 bio flag로 가드한다:

```c
static bool blk_mq_poll_sleep_nsec(struct bio *bio, u64 nsecs)
{
	if (!bio)  return false;
	if (!nsecs) return false;
	if (bio_flagged(bio, BIO_LHP_POLL_SLEPT))   /* 이미 잤으면 skip */
		return false;
	bio_set_flag(bio, BIO_LHP_POLL_SLEPT);
	... /* hrtimer_sleeper로 nsecs 동안 io_schedule() */
	return true;
}
```

```
   첫 진입      : flag 없음 → sleep 실행 → flag set → true
   재-poll 진입 : flag 있음 → sleep 건너뜀        → false
```
이 guard는 PAS와 LHP 모두에서 쓰인다.

---

## 5. LHP(Low-power Hybrid Polling) 개념

LHP는 PAS가 꺼져 있을 때(`pas_enabled=0`) 동작한다. `poll_nsec`(sysfs `io_poll_delay`) 한 값으로 모드가 갈린다.

```
   io_poll_delay = -1   → CP        : sleep 없음, busy spin
   io_poll_delay =  N>0 → fixed LHP : 항상 N ns 만큼 자고 poll
   io_poll_delay =  0   → adaptive  : 같은 bucket 평균 latency / 2 만큼 자고 poll
```

`block/blk-mq.c::blk_mq_poll_lhp_sleep`:

```c
static void blk_mq_poll_lhp_sleep(struct request_queue *q, struct bio *bio,
				  unsigned int flags)
{
	u64 nsecs;
	if (flags & BLK_POLL_ONESHOT) return;
	if (q->poll_nsec < 0) return;             /* CP: sleep 없음 */
	if (q->poll_nsec > 0) nsecs = q->poll_nsec;        /* fixed */
	else                  nsecs = blk_mq_poll_lhp_nsecs(q, bio); /* adaptive */
	blk_mq_poll_sleep_nsec(bio, nsecs);
}
```

### 5.1 Adaptive LHP는 blk-stat 평균 latency를 쓴다

```c
static u64 blk_mq_poll_lhp_nsecs(struct request_queue *q, struct bio *bio)
{
	int bucket;
	if (!blk_poll_stats_enable(q)) return 0;
	bucket = blk_mq_poll_pas_bucket(bio);
	if (bucket < 0) return 0;
	if (q->poll_stat[bucket].nr_samples)
		return (q->poll_stat[bucket].mean + 1) / 2;   /* 평균 latency의 절반 */
	return 0;
}
```

`q->poll_stat`은 100ms마다 갱신된다 (`blk_mq_poll_stats_fn` → `blk_stat_activate_msecs(q->poll_cb, 100)`):

```
   IO 완료마다 latency sample 적재
        │  (100ms 주기 timer)
        ▼
   blk_mq_poll_stats_fn(): bucket별 평균을 q->poll_stat에 복사
        │
        ▼
   다음 LHP sleep이 q->poll_stat[bucket].mean/2 를 읽음
```

cold-start 시에는 `nr_samples==0`이라 sleep 0(=CP처럼)으로 동작하다가, 통계가 쌓이면 nonzero sleep으로 전이한다.

### 5.2 PAS vs LHP 구조적 차이

| 항목 | PAS | LHP |
|---|---|---|
| 활성 조건 | `pas_enabled=1` | `pas_enabled=0` |
| sleep duration | bucket별 학습된 `dur` (per-CPU) | fixed(`poll_nsec>0`) 또는 평균 latency/2(`poll_nsec==0`) |
| sleep 함수 | `blk_mq_poll_pas_sleep()` | `blk_mq_poll_lhp_sleep()` |
| 결과 피드백 | over/under로 `dur` 학습 | 없음 (blk-stat 평균만 따라감) |
| full DPAS 연동 | `switch_enabled`로 mode 전환에 참여 | 참여 안 함 |

---

## 6. ★full mode switching (자동 전환) — 이제 구현됨★

> 이전 노트는 "full mode switching은 설계/구현 중"이라고 적었지만, 현재 `dpas-kernel`에는 **완전히 구현되어 있다.** `switch_enabled=1`이면 `blk_dpas_maybe_switch_mode()`가 관찰 window가 끝날 때마다 mode를 바꾼다.

### 6.1 상태 기계 (FSM)

```
                         full DPAS state machine
                       (switch_enabled=1 일 때만)

                          시작 = PAS
                              │
              ┌───────────────┴────────────────┐
              │                                 │
        tf > param1                    param4>0 && avg_qd==10
              │ (sleep이 d_init에 자주        │ (평균 QD ≈ 1 → sleep 이득 없음)
              ▼  깔림 = 장치 바쁨)            ▼
        ┌─────────┐                       ┌─────────┐
        │   OL    │                       │   CP    │
        └─────────┘                       └─────────┘
          │     │                              │
 avg_qd   │     │ avg_qd > param3              │ cp_cnt >= param6
 <= param2│     │ (QD 높음 = 과부하)           │ (관찰 끝)
          ▼     ▼                              ▼
       ┌─────────┐   int_cnt >= param7    ┌─────────┐
       │   PAS   │ ◀───────────────────── │   INT   │
       └─────────┘   (submit path에서)    └─────────┘
                                              ▲
                                              │ OL의 avg_qd > param3
                                              └────────────────────
```

전이 요약:

| from | to | 조건 | 어디서 |
|---|---|---|---|
| PAS | OL | `dpas_tf > param1` | poll: maybe_switch_mode |
| PAS | CP | `param4>0 && avg_qd==10` (QD≈1) | poll: maybe_switch_mode |
| CP | PAS | `cp_cnt >= param6` | poll: maybe_switch_mode |
| OL | PAS | `avg_qd <= param2` | poll: maybe_switch_mode |
| OL | INT | `avg_qd > param3` | poll: maybe_switch_mode |
| INT | OL | `int_cnt >= param7` | **submit**: blk_dpas_prepare_bio |

> `avg_qd`는 `dpas_qd_sum * 10 / cnt` 로 **10배 스케일**된 평균 queue depth다. 그래서 `avg_qd == 10`은 평균 QD ≈ 1을 뜻하고, `param2/param3`도 x10 스케일로 비교한다.

### 6.2 실제 코드 — `blk_dpas_maybe_switch_mode()` (`block/blk-mq.c`)

```c
static void blk_dpas_maybe_switch_mode(struct request_queue *q)
{
	s64 avg_qd;
	lockdep_assert_held(&q->dpas_lock);          /* 반드시 dpas_lock 잡고 호출 */
	if (!q->switch_enabled) return;

	switch (q->dpas_mode) {
	case DPAS_MODE_CP:
		if ((s64)q->dpas_cp_cnt >= q->switch_param6) {
			q->dpas_mode = DPAS_MODE_PAS;        /* CP 관찰 끝 → PAS 복귀 */
			q->dpas_pas_cnt = 0; q->dpas_qd_sum = 0; q->dpas_tf = 0;
		}
		break;
	case DPAS_MODE_PAS:
		if ((s64)q->dpas_pas_cnt < q->switch_param5) break;   /* window 미충족 */
		avg_qd = (s64)q->dpas_qd_sum * 10 / q->dpas_pas_cnt;
		if ((s64)q->dpas_tf > q->switch_param1) {
			q->dpas_mode = DPAS_MODE_OL;          /* sleep 바닥 잦음 → OL */
			q->dpas_ol_cnt = 0;
		} else if (q->switch_param4 > 0 && avg_qd == 10) {
			q->dpas_mode = DPAS_MODE_CP;          /* QD≈1 → CP 재시도 */
			q->dpas_cp_cnt = 0;
		} else {
			q->dpas_pas_cnt = 0;                  /* 유지, window 리셋 */
		}
		q->dpas_qd_sum = 0; q->dpas_tf = 0;
		break;
	case DPAS_MODE_OL:
		if ((s64)q->dpas_ol_cnt < q->switch_param5) break;
		avg_qd = (s64)q->dpas_qd_sum * 10 / q->dpas_ol_cnt;
		if (avg_qd <= q->switch_param2) {
			q->dpas_mode = DPAS_MODE_PAS; q->dpas_pas_cnt = 0;  /* 한가 → PAS */
		} else if (avg_qd > q->switch_param3) {
			q->dpas_mode = DPAS_MODE_INT; q->dpas_int_cnt = 0;  /* 과부하 → INT */
		} else {
			q->dpas_ol_cnt = 0;
		}
		q->dpas_qd_sum = 0; q->dpas_tf = 0;
		break;
	case DPAS_MODE_INT:
		/* INT는 poll path를 안 타므로 INT->OL은 submit helper에서 처리 */
		break;
	}
}
```

이 함수는 두 곳에서 호출된다:
- `blk_mq_poll_pas_sleep()`: CP 모드일 때 sleep 대신 전이 검사
- `blk_mq_poll_pas_complete()`: completion 결과 반영 후 window 종료 검사

### 6.3 호출 위치 그림

```
 submit path                          poll path
 ───────────                          ─────────
 blk_dpas_prepare_bio()               blk_mq_poll_bio()
   └ INT면 int_cnt++                    ├ pas_sleep()
       int_cnt>=param7 → OL             │   └ CP면 maybe_switch_mode()
   (그 외 mode는 cnt++만)               └ pas_complete()
                                            └ maybe_switch_mode()
```

---

## 7. 5.18 vs 7.1 `dpas-kernel` 구조 비교 (업데이트)

### 7.1 5.18 (원본)

```
 상태 저장: per-CPU struct blk_switch (irq_poll_switch)
 훅 위치 : fs/iomap/direct-io.c + block/fops.c (경로별 분산)
 mode 전환: submit hook 안에서도 수행 (INT->OL 등)
 동기화  : N_POLL 이라는 약한 가짜 int lock
```

문제점:
1. 경로별 훅이 분산돼 한 경로를 빼먹으면 I/O가 DPAS mode를 무시함.
2. submit hook이 mode 전환까지 떠안아 책임이 뒤섞임.
3. `N_POLL`은 진짜 lock이 아니어서 동시성에 취약.

### 7.2 7.1 `dpas-kernel` (현재)

```
 상태 저장: request_queue 레벨 필드 (dpas_mode, pas_stat, dpas_qd, dpas_cnt..)
 submit 훅: blk_dpas_prepare_bio() 단일 helper (iomap + fops 둘 다 호출)
 poll  훅: blk_mq_poll_bio() (PAS/LHP/CP sleep 정책 + complete)
 mode 전환: blk_dpas_maybe_switch_mode() (poll/complete + INT은 submit)
 동기화  : spinlock_t dpas_lock (진짜 lock)
```

진행 상황 비교:

| 항목 | 이전 노트(구버전) | 현재 dpas-kernel |
|---|---|---|
| submit-path DPAS helper | ❌ 없음 (HIPRI면 무조건 polled) | ✅ `blk_dpas_prepare_bio()` |
| INT 강제(제출 단계) | ❌ 불가 | ✅ INT 모드면 `IOCB_HIPRI`/`REQ_POLLED` 제거 |
| full mode switching | ❌ 미구현 | ✅ `blk_dpas_maybe_switch_mode()` |
| 상태 보호 lock | ❌ 미설계 | ✅ `spinlock_t dpas_lock` |
| 경로 단일화 | △ poll path만 | ✅ submit(단일 helper) + poll 모두 |

> 즉, 이전 노트의 "남은 과제" 1·2·3번(submit helper / mode 전환 / lock)은 **이미 구현 완료**다. 남은 건 주로 검증·실험·튜닝(9절).

---

## 8. sysfs knob과 실제 디바이스 poll

### 8.1 `switch_enabled` write 시 상태 reset

`switch_enabled`를 켜고 끌 때마다 측정 window를 **PAS부터** 깨끗이 다시 시작한다 (`block/blk-sysfs.c`):

```c
static void queue_dpas_reset_switch_state(struct request_queue *q)
{
	q->dpas_mode = DPAS_MODE_PAS;            /* 항상 PAS에서 출발 */
	q->dpas_cp_cnt = 0; q->dpas_int_cnt = 0;
	q->dpas_pas_cnt = 0; q->dpas_ol_cnt = 0;
	q->dpas_qd = 0; q->dpas_qd_sum = 0; q->dpas_tf = 0;
}

static ssize_t queue_switch_enabled_store(struct gendisk *disk,
					  const char *page, size_t count)
{
	struct request_queue *q = disk->queue;
	...
	/* submit/poll이 동시에 mode를 볼 수 있어 lock 안에서 reset */
	spin_lock_irqsave(&q->dpas_lock, flags_lock);
	q->switch_enabled = val;
	queue_dpas_reset_switch_state(q);
	spin_unlock_irqrestore(&q->dpas_lock, flags_lock);
	return count;
}
```

### 8.2 노출되는 knob 목록 (queue 디렉터리)

```
 /sys/block/<dev>/queue/
   ├ pas_enabled            0/1     PAS on/off
   ├ pas_adaptive_enabled   0/1/2   0=off, 1=DPAS1(dn 조정), 2=DPAS2(up 조정)
   ├ ehp_enabled            0/1
   ├ io_poll_delay          -1/0/N  CP / adaptive LHP / fixed LHP(ns)
   ├ switch_enabled         0/1     full mode switching on/off
   ├ switch_param1          PAS->OL tf 임계값
   ├ switch_param2          OL->PAS 평균 QD 임계값 (x10)
   ├ switch_param3          OL->INT 평균 QD 임계값 (x10)
   ├ switch_param4          PAS->CP 허용 여부
   ├ switch_param5          PAS/OL 평가 I/O 개수
   ├ switch_param6          CP   평가 I/O 개수
   └ switch_param7          INT  평가 I/O 개수
```

값 검증은 매크로로 처리한다, 예: `QUEUE_DPAS_INT_RW(queue_switch_param1, switch_param1, -1, INT_MAX)`.

### 8.3 맨 끝: 실제 NVMe poll — `nvme_poll()`

DPAS의 sleep/전환은 전부 이 호출로 귀결된다. NVMe 드라이버는 인터럽트를 기다리지 않고 **completion queue(CQ)를 직접 긁는다** (`drivers/nvme/host/pci.c`):

```c
static int nvme_poll(struct blk_mq_hw_ctx *hctx, struct io_comp_batch *iob)
{
	struct nvme_queue *nvmeq = hctx->driver_data;
	bool found;

	if (!test_bit(NVMEQ_POLLED, &nvmeq->flags) ||   /* poll queue여야 함 */
	    !nvme_cqe_pending(nvmeq))                    /* CQ에 새 완료 있나? */
		return 0;

	spin_lock(&nvmeq->cq_poll_lock);
	found = nvme_poll_cq(nvmeq, iob);                /* phase bit 기반 수확 */
	spin_unlock(&nvmeq->cq_poll_lock);
	return found;
}
```

"완료가 있나?"는 CQE의 phase bit 한 개로 판단한다:

```c
static inline bool nvme_cqe_pending(struct nvme_queue *nvmeq)
{
	struct nvme_completion *hcqe = &nvmeq->cqes[nvmeq->cq_head];
	return (le16_to_cpu(READ_ONCE(hcqe->status)) & 1) == nvmeq->cq_phase;
}
```

```
   __blk_hctx_poll() ── do { ret = q->mq_ops->poll(hctx,iob); } while(ret==0 ...)
        │                       │
        │                       └─ nvme_poll() → nvme_cqe_pending()로 CQ 확인
        ▼
   ret>0 이면 poll_count와 함께 반환 → blk_mq_poll_pas_complete()로
```

> `NVMEQ_POLLED` 비트가 없는 큐(=일반 인터럽트 큐)는 `nvme_poll()`이 즉시 0을 반환한다. 그래서 부팅 시 `nvme.poll_queues=N`으로 **poll queue를 확보해야** HIPRI polling이 실제로 동작한다 (9절 VM/host 교훈 참고).

---

## 9. 실험/검증에서 배운 교훈

### 9.1 VM 환경

- QEMU emulated NVMe로는 `nvme_poll()` 경로까지 확인할 수 있지만, **절대 성능 수치는 논문급이 아니다.**
- `virtio_blk.poll_queues=1`, `nvme.poll_queues=1` 등 **poll queue를 켜야** HIPRI polling이 동작한다 (그래야 `NVMEQ_POLLED` 비트가 선다).
- cloud-init seed는 ISO가 아니라 **VFAT**으로 만들어야 initramfs 없이 직접 부팅할 때 읽힌다.

### 9.2 fio 실험

- **prefill(write)이 매우 중요**하다. `fio --create_only`는 unwritten extent만 만들어 read가 실제 I/O 없이 0을 반환한다.
- `randrepeat=1`이면 같은 seed로 같은 offset sequence를 반복한다. warm-up 효과 해석 시 주의.
- `pkill -USR1 -x fio`는 frontend뿐 아니라 **worker 프로세스까지** signal을 보내야 한다. worker에 안 닿으면 재-poll이 발생하지 않는다.

### 9.3 host 실험

- host 커널 부팅 시 **root disk/NVMe/NIC 드라이버**를 built-in 또는 initramfs로 준비해야 한다.
- `/boot/efi` vfat mount에 `CONFIG_NLS_ISO8859_1`이 필요할 수 있다.
- `nvme`가 built-in이면 `modprobe -r nvme`로 poll queue를 reset할 수 없다. 스크립트에서 sysfs knob을 명시적으로 reset해야 한다.

### 9.4 현재까지 확인된 성능 경향 (host Optane, job=1, 4K randread)

```
                 IOPS / latency           CPU 사용률
                 ──────────────           ──────────
   CP   ████████████████████ 100%   ████████████████████ 100%
   PAS  ██████████████████   ~90%   █████████████▌       ~68%
   LHP  ███████████████▍     ~77%   ███████████▍         ~57%
   INT  ██████               최저    ████                 최저

   즉:  IOPS:  CP > PAS > LHP > INT
        CPU :  CP > PAS > LHP > INT
```

> 단일 job, 4K random read, ext4 file direct I/O 조건의 경향 확인용. 멀티 job, 순서 randomize, CPU/IRQ 통제 등 추가 실험 필요.

---

## 10. 헷갈리기 쉬운 점 모음

### 10.1 `bio->bi_cookie`는 request tag가 아니다
`bi_cookie`는 **poll할 hctx 번호**다. `blk_mq_start_request()`에서 `rq->mq_hctx->queue_num`을 복사해 넣는다.

### 10.2 `REQ_POLLED`는 완료를 자동으로 만들지 않는다
`REQ_POLLED`는 "이 bio를 poll queue로 보낸다"는 표시일 뿐. 완료를 실제로 찾는 것은 `bio_poll()`/`blk_mq_poll_bio()` 호출이다.

### 10.3 sync DIO HIPRI 복구가 필요한 이유
최신 upstream은 sync DIO polling을 막고 io_uring 중심으로 옮겼다. 하지만 DPAS 실험은 `pvsync2 + hipri + direct=1` 같은 legacy sync DIO 경로를 전제로 하므로, `dpas-kernel`은 sync DIO HIPRI wait loop(`__iomap_dio_rw`의 `for(;;)`)를 복구했다.

### 10.4 `dio->submit.poll_bio` vs `iocb->private`
```
 dio->submit.poll_bio : sync DIO 내부 wait loop가 직접 bio_poll()할 때 사용
 iocb->private        : 외부 iopoll(예: io_uring)이 bio를 찾을 때 사용
```

### 10.5 `pas_adaptive_enabled=1` vs `=2`
- `1` (DPAS1): `dn`을 adaptive하게 조정하고 `up = dn / updn_ratio`로 맞춤.
- `2` (DPAS2): `up`만 adaptive하게 조정하고 `dn`은 고정.

### 10.6 `dur_cnt`는 IO 개수가 아니다
`dur_cnt`는 "현재 bucket `dur`의 세대 번호"다. `dur`가 갱신될 때마다 +1. complete 단계는 자기가 잘 때의 `dur_cnt`와 현재 `dur_cnt`가 같을 때만 결과를 반영한다(중간에 세대가 바뀌었으면 stale로 버림).

### 10.7 `avg_qd`는 10배 스케일이다
`avg_qd = dpas_qd_sum * 10 / cnt`. 그래서 PAS→CP 조건 `avg_qd == 10`은 평균 QD ≈ 1을 의미하고, `switch_param2/3`도 x10으로 비교해야 한다.

### 10.8 mode 전환의 진입점은 두 종류다
- INT 탈출(INT→OL)만 **submit** 경로(`blk_dpas_prepare_bio`)에서. (INT는 poll을 안 타므로)
- 나머지 전환은 전부 **poll/complete** 경로(`blk_dpas_maybe_switch_mode`)에서.

### 10.9 guard 테스트할 때 signal은 worker에 닿아야 한다
polling 코드는 fio worker가 syscall 안에서 돌 때만 실행된다. `pkill -USR1 -x fio`처럼 worker까지 타격해야 재-poll을 유도할 수 있다.

### 10.10 (주의) `switch_param5/6` = 0 설정 시 0 나눗셈 위험
`avg_qd = dpas_qd_sum * 10 / dpas_pas_cnt` 직전 가드는 `dpas_pas_cnt < switch_param5`다. sysfs 범위가 `-1..INT_MAX`라 `param5=0`을 넣으면 `cnt=0`에서도 가드를 통과해 0 나눗셈이 날 수 있다. 실험 시 `switch_param5/6/7`은 1 이상으로 둘 것.

---

## 11. 현재 남은 과제 (업데이트)

이전 노트의 1·2·3번(submit helper / mode 전환 / lock)은 ✅ 구현 완료. 남은 것:

1. **full mode switching 정확성 검증**
   - `tools/testing/selftests/dpas/full_mode_switching_static.py` 같은 정적 점검 외에, 실제 전이가 의도대로 도는지 런타임 추적(logging_enabled, tracepoint).
   - 0 나눗셈 가드(10.10), counter overflow, lock 구간 적정성 점검.

2. **성능 실험 확장**
   - `jobs=1,2,4,8,16,20` sweep.
   - mode 순서 randomize / Latin square.
   - CPU governor, IRQ affinity, background load 통제.
   - raw block device vs file DIO 비교.

3. **switch_param 튜닝 가이드 정립**
   - param1(tf), param2/3(QD x10), param5/6/7(window) 기본값과 민감도 정리.

4. **누락 경로 방지**
   - iomap + block fops + NVMe passthrough 경로 모두 helper를 타는지 재확인.
   - `bio_set_polled()`만 후킹하면 raw blockdev async 경로를 놓칠 수 있음에 주의.

5. **EHP**
   - `ehp_enabled` knob은 있으나 7.1 poll path에 실제 분기는 아직 약함. 필요 여부 결정.

---

## 12. 가장 중요한 코드 위치

| 목적 | 파일::함수 |
|---|---|
| **submit DPAS 훅 (mode별 REQ_POLLED set/clear)** | `block/blk-core.c::blk_dpas_prepare_bio()` |
| filesystem DIO HIPRI 제출 | `fs/iomap/direct-io.c::iomap_dio_submit_bio()` |
| raw blockdev async HIPRI 제출 | `block/fops.c::__blkdev_direct_IO_async()` |
| sync DIO wait loop (bio_poll 반복) | `fs/iomap/direct-io.c::__iomap_dio_rw()` |
| bio → request, cookie 기록 | `block/blk-mq.c::blk_mq_start_request()` |
| bio polling 진입 | `block/blk-core.c::bio_poll()` |
| **poll 3단계 (sleep/poll/complete)** | `block/blk-mq.c::blk_mq_poll_bio()` |
| PAS bucket 계산 | `block/blk-mq.c::blk_mq_poll_pas_bucket()` |
| PAS sleep / complete / duration 갱신 | `block/blk-mq.c::blk_mq_poll_pas_sleep/complete/update_duration()` |
| 중복 sleep guard | `block/blk-mq.c::blk_mq_poll_sleep_nsec()` (`BIO_LHP_POLL_SLEPT`) |
| LHP sleep | `block/blk-mq.c::blk_mq_poll_lhp_sleep/lhp_nsecs()` |
| **full mode 전환 FSM** | `block/blk-mq.c::blk_dpas_maybe_switch_mode()` |
| 실제 NVMe poll | `drivers/nvme/host/pci.c::nvme_poll()` / `nvme_cqe_pending()` |
| sysfs knob + reset | `block/blk-sysfs.c::queue_switch_enabled_store/queue_dpas_reset_switch_state()` |
| 자료구조 | `include/linux/blkdev.h`(enum dpas_mode, request_queue), `include/linux/blk_types.h`(blk_rq_pas_stat) |

---

## 13. 한 줄 요약

> DPAS는 "HIPRI I/O가 들어오면 현재 mode(INT/CP/PAS/OL)를 보고 `REQ_POLLED`를 켜거나 끄고(submit 훅 `blk_dpas_prepare_bio`), polling이면 poll 직전에 적절히 sleep해서 CPU를 아끼고(poll 훅 `blk_mq_poll_bio`의 sleep/poll/complete 3단계), 관찰 결과(tf·평균 QD·window)로 mode를 자동 전환한다(`blk_dpas_maybe_switch_mode`)"는 아이디어다. 5.18의 분산된 경로별 훅·약한 lock을 7.1 `dpas-kernel`에서 **queue-level 단일 helper + 진짜 spinlock + 단일 poll-path 정책**으로 깔끔하게 포팅했고, 이제 full mode switching까지 동작한다.
