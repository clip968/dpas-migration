# 2026-06-05 bio -> request -> poll path 직관 보고서

이 문서는 `dpas-kernel`의 현재 코드 기준으로, `sync DIO HIPRI` 요청 하나가 어떻게 `bio`에서 `request`를 거쳐 `request_queue`의 PAS/LHP polling 정책까지 이어지는지 설명한다.

핵심 요약:

```text
사용자 read/write + HIPRI
        |
        v
iomap DIO가 bio 생성
        |
        |  bio->bi_opf |= REQ_POLLED
        |  dio->submit.poll_bio = bio
        v
blk-mq가 bio를 request로 변환/시작
        |
        |  rq->mq_hctx 선택
        |  bio->bi_cookie = rq->mq_hctx->queue_num
        v
sync DIO wait loop
        |
        |  bio_poll(dio->submit.poll_bio)
        v
bio_poll()
        |
        |  q = bdev_get_queue(bio->bi_bdev)
        |  cookie = bio->bi_cookie
        v
blk_mq_poll_bio(q, bio, cookie)
        |
        |  hctx = q->queue_hw_ctx[cookie]
        |  if pas_enabled: PAS sleep
        |  else: LHP sleep
        v
__blk_hctx_poll(q, hctx)
        |
        |  q->mq_ops->poll(hctx, iob)
        v
NVMe poll / completion 확인
```

중요한 관점은 "bio 전체가 드라이버 최하단까지 새 인자로 전달된다"가 아니다. 실제 장치 polling은 여전히 `hctx` 기반이다. 다만 7.1의 `bio_poll()` 경로에서 `bio`를 `blk_mq_poll_bio()`까지 보존해서, poll 직전 정책이 `bio`의 방향, 크기, polled flag, cookie를 볼 수 있게 만든 것이다.

## 1. bio가 polled bio가 되는 순간

위치:

- `dpas-kernel/fs/iomap/direct-io.c:iomap_dio_submit_bio()`
- `dpas-kernel/include/linux/bio.h:bio_set_polled()`

코드:

```c
/* fs/iomap/direct-io.c */
if (iocb->ki_flags & IOCB_HIPRI) {
	bio_set_polled(bio, iocb);
	dio->submit.poll_bio = bio;
}
```

```c
/* include/linux/bio.h */
static inline void bio_set_polled(struct bio *bio, struct kiocb *kiocb)
{
	bio->bi_opf |= REQ_POLLED;
	if (kiocb->ki_flags & IOCB_NOWAIT)
		bio->bi_opf |= REQ_NOWAIT;
}
```

변수 변화:

```text
입력:
  iocb->ki_flags = ... | IOCB_HIPRI
  bio->bi_opf    = 기존 op/flag
  dio->submit.poll_bio = NULL

실행 후:
  bio->bi_opf    = 기존 op/flag | REQ_POLLED
  dio->submit.poll_bio = bio
```

이 단계의 의미:

- `REQ_POLLED`는 "이 bio의 완료는 polling으로 찾을 수 있다"는 표시다.
- `dio->submit.poll_bio`는 sync DIO wait loop에서 다시 사용할 bio 포인터다.

그림:

```text
iocb
  ki_flags: IOCB_HIPRI
      |
      v
bio
  bi_opf: READ | REQ_POLLED
      ^
      |
dio->submit.poll_bio
```

## 2. request가 시작되며 bio cookie가 hctx 번호가 된다

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_start_request()`

코드:

```c
if (rq->bio && rq->bio->bi_opf & REQ_POLLED)
	WRITE_ONCE(rq->bio->bi_cookie, rq->mq_hctx->queue_num);
```

변수 변화:

```text
입력:
  rq->bio = bio
  bio->bi_opf has REQ_POLLED
  rq->mq_hctx = 선택된 hardware context
  rq->mq_hctx->queue_num = 예: 3
  bio->bi_cookie = BLK_QC_T_NONE 또는 이전 값

실행 후:
  bio->bi_cookie = 3
```

이 단계가 중요한 이유:

`bio_poll()`은 나중에 `request *rq`를 직접 받지 않는다. 그래서 어느 hctx를 poll해야 하는지 알 수 없다. 이 코드가 `bio->bi_cookie`에 `hctx queue_num`을 써주기 때문에 나중에 다음 복원이 가능해진다.

```text
request
  rq->mq_hctx -----------+
  rq->bio ----+          |
             v          v
           bio     hctx(queue_num=3)
             |
             +-- bi_cookie = 3
```

즉 `bio->bi_cookie`는 여기서 "request tag"라기보다 "poll할 hctx 번호"처럼 쓰인다.

## 3. sync DIO wait loop가 bio_poll()을 호출한다

위치:

- `dpas-kernel/fs/iomap/direct-io.c:__iomap_dio_rw()`

코드:

```c
WRITE_ONCE(iocb->private, dio->submit.poll_bio);

for (;;) {
	set_current_state(TASK_UNINTERRUPTIBLE);
	if (!READ_ONCE(dio->submit.waiter))
		break;

	if (dio->submit.poll_bio &&
	    (dio->submit.poll_bio->bi_opf & REQ_POLLED))
		bio_poll(dio->submit.poll_bio, NULL, 0);
	else
		blk_io_schedule();
}
```

변수 변화:

```text
입력:
  dio->submit.poll_bio = bio
  bio->bi_opf has REQ_POLLED
  bio->bi_cookie = hctx 번호
  flags argument to bio_poll = 0

실행:
  bio_poll(bio, NULL, 0)
```

여기서 기존 sleep-based wait와 달라진 점:

```text
IRQ wait:
  완료 interrupt를 기다리며 blk_io_schedule()

polled sync DIO:
  같은 bio를 들고 bio_poll()을 반복 호출
```

## 4. bio_poll()이 bio에서 q와 cookie를 복원한다

위치:

- `dpas-kernel/block/blk-core.c:bio_poll()`

코드:

```c
int bio_poll(struct bio *bio, struct io_comp_batch *iob, unsigned int flags)
{
	blk_qc_t cookie = READ_ONCE(bio->bi_cookie);
	struct block_device *bdev;
	struct request_queue *q;
	int ret = 0;

	bdev = READ_ONCE(bio->bi_bdev);
	if (!bdev)
		return 0;

	q = bdev_get_queue(bdev);
	if (cookie == BLK_QC_T_NONE)
		return 0;

	blk_flush_plug(current->plug, false);

	if (!percpu_ref_tryget(&q->q_usage_counter))
		return 0;
	if (queue_is_mq(q)) {
		ret = blk_mq_poll_bio(q, bio, cookie, iob, flags);
	}
	blk_queue_exit(q);
	return ret;
}
```

변수 변화:

```text
입력 bio:
  bio->bi_bdev   = 대상 block device
  bio->bi_cookie = 예: 3

bio_poll 내부:
  cookie = 3
  bdev   = bio->bi_bdev
  q      = bdev_get_queue(bdev)
  ret    = 0

mq queue이면:
  ret = blk_mq_poll_bio(q, bio, 3, iob, flags)
```

여기서 현재 포팅의 핵심 변경은 기존 `blk_mq_poll(q, cookie, ...)`가 아니라 `blk_mq_poll_bio(q, bio, cookie, ...)`로 들어간다는 점이다.

```text
기존 일반 mq poll:
  q + cookie만 전달
  bio 정보 없음

현재 DPAS/PAS-aware poll:
  q + cookie + bio 전달
  bio 방향/크기/flag를 볼 수 있음
```

## 5. blk_mq_poll_bio()가 hctx를 찾고 PAS/LHP를 선택한다

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_poll_bio()`

코드:

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

	if (q->pas_enabled)
		blk_mq_poll_pas_sleep(q, bio, flags, &pas);
	else
		blk_mq_poll_lhp_sleep(q, bio, flags);

	ret = __blk_hctx_poll(q, hctx, iob, flags, &poll_count);
	blk_mq_poll_pas_complete(q, &pas, ret, poll_count);

	return ret;
}
```

초기 변수:

```text
q = bio가 속한 request_queue
bio = polled bio
cookie = hctx 번호
pas = {
  active = false,
  cpu = 0,
  bucket = 0,
  dur_cnt = 0,
  dur = 0
}
poll_count = 0
```

중간 변화:

```text
hctx = q->queue_hw_ctx[cookie]

예:
  cookie = 3
  hctx = q->queue_hw_ctx[3]
```

분기:

```text
q->pas_enabled = 1
  -> PAS path
  -> bio 크기/방향 bucket 기반 adaptive sleep

q->pas_enabled = 0
  -> LHP path
  -> io_poll_delay 기반 fixed/adaptive sleep
```

그림:

```text
                  +--------------------+
bio + q + cookie -> blk_mq_poll_bio() |
                  +---------+----------+
                            |
                            v
                  hctx = q->queue_hw_ctx[cookie]
                            |
              +-------------+-------------+
              |                           |
       pas_enabled=1                pas_enabled=0
              |                           |
              v                           v
       PAS sleep                    LHP sleep
              |                           |
              +-------------+-------------+
                            |
                            v
                    __blk_hctx_poll()
```

## 6. PAS path: bio로 bucket을 고른다

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_poll_pas_bucket()`

코드:

```c
static int blk_mq_poll_pas_bucket(const struct bio *bio)
{
	unsigned int sectors;
	int ddir;
	int bucket;

	if (!bio)
		return -1;

	if (bio_op(bio) != REQ_OP_READ && bio_op(bio) != REQ_OP_WRITE)
		return -1;

	sectors = bio_sectors(bio);
	if (!sectors)
		return -1;

	ddir = op_is_write(bio_op(bio)) ? 1 : 0;
	bucket = ddir + 2 * ilog2(sectors);

	if (bucket >= BLK_MQ_POLL_STATS_BKTS)
		return ddir + BLK_MQ_POLL_STATS_BKTS - 2;

	return bucket;
}
```

예시 1: 4KB read

```text
bio_op(bio) = REQ_OP_READ
bio_sectors(bio) = 8       # 512B * 8 = 4096B

ddir = 0
ilog2(8) = 3
bucket = 0 + 2 * 3 = 6
```

예시 2: 4KB write

```text
bio_op(bio) = REQ_OP_WRITE
bio_sectors(bio) = 8

ddir = 1
ilog2(8) = 3
bucket = 1 + 2 * 3 = 7
```

직관:

```text
read buckets:   0, 2, 4, 6, 8, ...
write buckets:  1, 3, 5, 7, 9, ...

4KB read  -> bucket 6
4KB write -> bucket 7
```

## 7. PAS path: per-CPU bucket state를 읽고 sleep한다

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_poll_pas_sleep()`

코드:

```c
static void blk_mq_poll_pas_sleep(struct request_queue *q, struct bio *bio,
				  unsigned int flags,
				  struct blk_mq_pas_poll_ctx *ctx)
{
	struct blk_rq_pas_stat *stat;
	u8 dur_cnt;
	int bucket;
	int cpu;
	u64 nsecs;

	if (!q->pas_enabled || !q->pas_stat)
		return;

	if (flags & BLK_POLL_ONESHOT)
		return;

	if (!bio || bio_flagged(bio, BIO_LHP_POLL_SLEPT))
		return;

	bucket = blk_mq_poll_pas_bucket(bio);
	if (bucket < 0)
		return;

	cpu = get_cpu();
	stat = per_cpu_ptr(q->pas_stat, cpu);

	blk_mq_poll_pas_update_duration(q, &stat[bucket]);

	nsecs = READ_ONCE(stat[bucket].dur);
	dur_cnt = stat[bucket].dur_cnt;
	q->last_poll_count++;
	put_cpu();

	if (!blk_mq_poll_sleep_nsec(bio, nsecs))
		return;

	ctx->active = true;
	ctx->cpu = cpu;
	ctx->bucket = bucket;
	ctx->dur_cnt = dur_cnt;
	ctx->dur = nsecs;
}
```

처음 들어올 때:

```text
ctx->active = false
bio flag BIO_LHP_POLL_SLEPT = false
q->pas_enabled = 1
q->pas_stat != NULL
```

예시 값:

```text
bio = 4KB read
bucket = 6
cpu = 2

stat = per_cpu_ptr(q->pas_stat, 2)
stat[6].dur = 30000
stat[6].dur_cnt = 42
```

실행 후:

```text
nsecs = 30000
dur_cnt = 42
q->last_poll_count = q->last_poll_count + 1

blk_mq_poll_sleep_nsec(bio, 30000)
  -> bio에 BIO_LHP_POLL_SLEPT flag set
  -> 30000ns sleep

ctx->active = true
ctx->cpu = 2
ctx->bucket = 6
ctx->dur_cnt = 42
ctx->dur = 30000
```

왜 `ctx`가 필요한가:

```text
PAS sleep 전:
  "나는 CPU 2의 bucket 6에서 dur_cnt 42 세대의 dur=30000으로 잤다"

poll 완료 후:
  "방금 completion 결과를 같은 CPU/bucket/dur_cnt에 반영해도 되는가?"
```

즉 `ctx`는 sleep과 completion feedback을 연결하는 임시 영수증이다.

## 8. 공통 sleep helper: 같은 bio는 한 번만 잔다

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_poll_sleep_nsec()`

코드:

```c
static bool blk_mq_poll_sleep_nsec(struct bio *bio, u64 nsecs)
{
	struct hrtimer_sleeper hs;
	ktime_t kt;

	if (!bio)
		return false;

	if (!nsecs)
		return false;

	if (bio_flagged(bio, BIO_LHP_POLL_SLEPT))
		return false;

	bio_set_flag(bio, BIO_LHP_POLL_SLEPT);

	kt = ktime_set(0, nsecs);
	...
	io_schedule();
	...
	return true;
}
```

변수 변화:

```text
입력:
  bio flag BIO_LHP_POLL_SLEPT = false
  nsecs = 30000

실행:
  bio_set_flag(bio, BIO_LHP_POLL_SLEPT)
  io_schedule()로 sleep

출력:
  bio flag BIO_LHP_POLL_SLEPT = true
  return true
```

같은 bio가 다시 `bio_poll()`로 들어오면:

```text
bio flag BIO_LHP_POLL_SLEPT = true
  -> sleep하지 않음
  -> return false
```

직관:

```text
첫 poll:
  bio [not slept] -> sleep -> bio [slept]

재-poll:
  bio [slept] -> skip sleep
```

## 9. 실제 completion poll은 mq_ops->poll()

위치:

- `dpas-kernel/block/blk-mq.c:__blk_hctx_poll()`

코드:

```c
static int __blk_hctx_poll(struct request_queue *q, struct blk_mq_hw_ctx *hctx,
			   struct io_comp_batch *iob, unsigned int flags,
			   unsigned int *poll_countp)
{
	unsigned int poll_count = 0;
	int ret;

	do {
		ret = q->mq_ops->poll(hctx, iob);
		if (ret > 0) {
			if (poll_countp)
				*poll_countp = poll_count;
			return ret;
		}
		if (task_sigpending(current)) {
			if (poll_countp)
				*poll_countp = UINT_MAX;
			return 1;
		}
		if (ret < 0 || (flags & BLK_POLL_ONESHOT))
			break;
		cpu_relax();
		poll_count++;
	} while (!need_resched());

	if (poll_countp)
		*poll_countp = poll_count;
	return 0;
}
```

변수 변화:

```text
초기:
  poll_count = 0

loop 1:
  ret = q->mq_ops->poll(hctx, iob)

completion 없음:
  ret = 0
  poll_count = 1

loop 2:
  ret = q->mq_ops->poll(hctx, iob)

completion 발견:
  ret = 1 또는 그 이상
  *poll_countp = 1
  return ret
```

중요한 의미:

- PAS/LHP는 poll 전에 sleep을 넣는 공통 block-layer 정책이다.
- 실제 NVMe completion 확인은 여전히 `q->mq_ops->poll(hctx, iob)`가 한다.
- `poll_count`는 "sleep 이후 busy polling을 몇 번 돌았는가"다.

## 10. PAS feedback: poll_count로 다음 sleep 시간을 준비한다

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_poll_pas_complete()`

코드:

```c
static void blk_mq_poll_pas_complete(struct request_queue *q,
				     struct blk_mq_pas_poll_ctx *ctx,
				     int ret, unsigned int poll_count)
{
	struct blk_rq_pas_stat *stat;
	int cpu;

	if (!ctx->active || ret <= 0 || poll_count == UINT_MAX || !q->pas_stat)
		return;

	cpu = get_cpu();
	if (cpu != ctx->cpu) {
		put_cpu();
		return;
	}

	stat = per_cpu_ptr(q->pas_stat, ctx->cpu);
	if (ctx->dur_cnt == stat[ctx->bucket].dur_cnt &&
	    stat[ctx->bucket].dur_cnt != stat[ctx->bucket].dur_cnt_checked) {
		stat[ctx->bucket].dur_cnt_checked = stat[ctx->bucket].dur_cnt;
		stat[ctx->bucket].sr_pnlt = stat[ctx->bucket].sr_last;
		stat[ctx->bucket].sr_last = poll_count <= q->poll_threshold ? 0 : 1;
		stat[ctx->bucket].update_req = 1;
	}

	put_cpu();
}
```

예시:

```text
ctx:
  active = true
  cpu = 2
  bucket = 6
  dur_cnt = 42

ret = 1
poll_count = 0
q->poll_threshold = 0

현재 stat[6]:
  dur_cnt = 42
  dur_cnt_checked = 41
  sr_last = 1
```

실행 후:

```text
dur_cnt_checked = 42
sr_pnlt = 1
sr_last = 0     # poll_count <= threshold 이므로 oversleep 쪽 판정
update_req = 1
```

다른 예:

```text
poll_count = 12
q->poll_threshold = 0

sr_last = 1     # poll_count > threshold 이므로 undersleep 쪽 판정
update_req = 1
```

이 함수는 `dur`을 직접 바꾸지 않는다. 다음번 같은 bucket에 들어올 때 `update_req`를 보고 duration을 바꾼다.

## 11. 다음 PAS 호출에서 duration이 바뀐다

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_poll_pas_update_duration()`

코드:

```c
static void blk_mq_poll_pas_update_duration(struct request_queue *q,
					    struct blk_rq_pas_stat *stat)
{
	int cur_case;

	if (!stat->update_req)
		return;

	stat->update_req = 0;

	cur_case = stat->sr_pnlt * 2 + stat->sr_last;
	switch (cur_case) {
	case 0: /* overslept, overslept */
		stat->adj -= stat->dn;
		break;
	case 1: /* overslept, underslept */
		stat->adj = q->div + stat->up;
		break;
	case 2: /* underslept, overslept */
		stat->adj = q->div - stat->dn;
		break;
	case 3: /* underslept, underslept */
		stat->adj += stat->up;
		break;
	}

	if (stat->adj <= 0)
		stat->adj = q->div;

	stat->dur = mul_u64_u64_div_u64(stat->dur, (u64)stat->adj, q->div);
	if (stat->dur < q->d_init)
		stat->dur = q->d_init;

	stat->dur_cnt++;
	...
}
```

직관:

```text
0 = oversleep  = 너무 오래 잤다. poll하자마자 이미 완료였다.
1 = undersleep = 덜 잤다. 깨어난 뒤에도 poll을 여러 번 돌았다.
```

case table:

```text
sr_pnlt sr_last  cur_case  의미                 조정
   0       0        0      over -> over          sleep 줄이는 쪽
   0       1        1      over -> under         div + up
   1       0        2      under -> over         div - dn
   1       1        3      under -> under        sleep 늘리는 쪽
```

예시:

```text
q->div = 1000000
stat->dur = 30000
stat->up = 10000
stat->dn = 100000
stat->sr_pnlt = 1
stat->sr_last = 1

cur_case = 1 * 2 + 1 = 3
stat->adj += stat->up

만약 stat->adj가 1000000이었다면:
  stat->adj = 1010000
  stat->dur = 30000 * 1010000 / 1000000 = 30300
  stat->dur_cnt++
```

즉 undersleep이 계속 나오면 다음 sleep duration이 커진다. oversleep이 계속 나오면 줄어든다.

## 12. LHP path: PAS가 꺼졌을 때

위치:

- `dpas-kernel/block/blk-mq.c:blk_mq_poll_lhp_sleep()`
- `dpas-kernel/block/blk-mq.c:blk_mq_poll_lhp_nsecs()`

코드:

```c
static void blk_mq_poll_lhp_sleep(struct request_queue *q, struct bio *bio,
				  unsigned int flags)
{
	u64 nsecs;

	if (flags & BLK_POLL_ONESHOT)
		return;

	/* classic polling, sleep 없음 */
	if (q->poll_nsec < 0)
		return;

	/* fixed LHP, 사용자가 지정한 시간만큼 sleep */
	if (q->poll_nsec > 0)
		nsecs = q->poll_nsec;
	/* adaptive LHP, 과거 평균 latency / 2만큼 sleep */
	else
		nsecs = blk_mq_poll_lhp_nsecs(q, bio);

	blk_mq_poll_sleep_nsec(bio, nsecs);
}
```

모드:

```text
q->pas_enabled = 0

q->poll_nsec = -1
  -> classic polling
  -> sleep 없음

q->poll_nsec = 10000
  -> fixed LHP
  -> 10000ns sleep

q->poll_nsec = 0
  -> adaptive LHP
  -> q->poll_stat[bucket].mean / 2 만큼 sleep
```

adaptive LHP 계산:

```c
static u64 blk_mq_poll_lhp_nsecs(struct request_queue *q, struct bio *bio)
{
	int bucket;

	if (!blk_poll_stats_enable(q))
		return 0;

	bucket = blk_mq_poll_pas_bucket(bio);
	if (bucket < 0)
		return 0;

	if (q->poll_stat[bucket].nr_samples)
		return (q->poll_stat[bucket].mean + 1) / 2;

	return 0;
}
```

변수 예시:

```text
bio = 4KB read
bucket = 6

q->poll_stat[6].nr_samples = 200
q->poll_stat[6].mean = 60000

nsecs = (60000 + 1) / 2 = 30000
```

즉 adaptive LHP는 "최근 같은 bucket IO 평균 latency의 절반만큼 자고 poll하자"는 방식이다.

## 13. 한 요청을 숫자로 따라가기

가정:

```text
요청: 4KB read, sync DIO, HIPRI
bio_sectors = 8
bio_op = REQ_OP_READ
rq->mq_hctx->queue_num = 3
q->pas_enabled = 1
q->poll_threshold = 0
현재 CPU = 2

stat[CPU2][bucket6]:
  dur = 30000
  adj = 1000000
  up = 10000
  dn = 100000
  sr_pnlt = 1
  sr_last = 1
  update_req = 0
  dur_cnt = 42
  dur_cnt_checked = 41
```

실행:

```text
1. iomap_dio_submit_bio()
   bio->bi_opf |= REQ_POLLED
   dio->submit.poll_bio = bio

2. blk_mq_start_request()
   bio->bi_cookie = 3

3. sync wait loop
   bio_poll(bio, NULL, 0)

4. bio_poll()
   cookie = 3
   q = bdev_get_queue(bio->bi_bdev)
   blk_mq_poll_bio(q, bio, 3, NULL, 0)

5. blk_mq_poll_bio()
   hctx = q->queue_hw_ctx[3]
   pas = {}
   poll_count = 0

6. blk_mq_poll_pas_sleep()
   bucket = 0 + 2 * ilog2(8) = 6
   cpu = 2
   nsecs = stat[6].dur = 30000
   dur_cnt = 42
   q->last_poll_count++
   bio flag BIO_LHP_POLL_SLEPT set
   sleep 30000ns
   ctx = { active=true, cpu=2, bucket=6, dur_cnt=42, dur=30000 }

7. __blk_hctx_poll()
   ret = q->mq_ops->poll(hctx, NULL)
   예: 첫 loop에서 바로 completion 발견
   poll_countp = 0
   ret = 1

8. blk_mq_poll_pas_complete()
   ctx active true
   ret > 0
   poll_count = 0
   cpu still 2
   dur_cnt matches 42

   dur_cnt_checked = 42
   sr_pnlt = old sr_last = 1
   sr_last = poll_count <= 0 ? 0 : 1 = 0
   update_req = 1
```

다음 같은 bucket 요청:

```text
blk_mq_poll_pas_update_duration()
  update_req = 1 이므로 duration 갱신
  cur_case = sr_pnlt * 2 + sr_last = 1 * 2 + 0 = 2
  stat->adj = q->div - stat->dn
  stat->dur = stat->dur * stat->adj / q->div
  dur_cnt++
```

이전 요청에서 poll_count가 0이었다는 것은 "너무 오래 잤을 가능성"으로 보고 다음 sleep을 줄이는 방향으로 조정한다.

## 14. 왜 이 구조가 필요한가

7.1의 polling 경로는 `bio_poll()` 중심이다. 그런데 PAS/LHP는 다음 정보를 알아야 한다.

```text
필요한 정보:
  read인가 write인가?
  IO 크기가 얼마인가?
  같은 bio에 이미 sleep을 적용했는가?
  어느 hctx를 poll해야 하는가?
```

이 정보는 각각 여기 있다.

```text
bio_op(bio)                   -> read/write
bio_sectors(bio)              -> IO size
BIO_LHP_POLL_SLEPT flag       -> 중복 sleep 방지
bio->bi_cookie                -> hctx 번호
bio->bi_bdev -> request_queue -> q 상태와 sysfs knob
```

따라서 현재 포팅의 구조는 이렇게 요약된다.

```text
bio는 정책 판단용 정보 묶음
request는 hctx 배정과 실제 장치 제출 단위
request_queue는 PAS/LHP 상태와 sysfs knob 저장소
hctx는 실제 mq_ops->poll 대상
```

한 줄 결론:

```text
bio에서 "무슨 IO인가"를 보고,
request에서 "어느 hctx로 갔는가"를 cookie로 bio에 되돌려 쓰고,
request_queue에서 "어떤 polling 정책을 쓸 것인가"를 고른 뒤,
hctx 기반으로 실제 NVMe poll을 수행한다.
```

## 15. 현재 이해할 때 주의할 점

- `BIO_LHP_POLL_SLEPT` 이름은 LHP지만 PAS path에서도 중복 sleep 방지용으로 같이 쓴다.
- PAS completion feedback은 `blk_mq_poll_pas_complete()`에서 바로 `dur`을 바꾸지 않고 `update_req=1`만 남긴다. 실제 `dur` 갱신은 다음 sleep 진입 때 한다.
- `bio->bi_cookie`는 이 포팅에서 hctx selector로 중요하다. cookie가 `BLK_QC_T_NONE`이면 `bio_poll()`은 아무것도 못 하고 0을 반환한다.
- `poll_count`는 IO latency 자체가 아니라 sleep 이후 busy poll loop 횟수다. PAS는 이 값을 oversleep/undersleep 판정에 쓴다.
- 실제 device polling은 `q->mq_ops->poll(hctx, iob)`이고, NVMe driver 코드는 이 포팅에서 직접 수정하지 않았다.
