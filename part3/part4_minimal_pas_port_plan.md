# Part 4 Minimal PAS-only 포팅 구현 계획

> **구현 agent용 지시:** 이 계획을 실제 구현할 때는 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`를 사용해서 작업 단위로 진행한다. 체크박스(`- [ ]`)는 구현 진행 상황 추적용이다.

**목표:** 최신 Linux kernel의 기존 polled I/O path 위에 PAS-only sleep-before-poll policy를 최소 범위로 이식한다.

**구조:** `request_queue`에는 `struct dpas_queue *dpas` pointer만 추가하고, PAS state/counter/sysfs logic은 DPAS 전용 helper로 분리한다. 초기 hook은 `blk_mq_poll()`에 두고, `blk_hctx_poll()`와 NVMe driver poll callback은 가능한 한 그대로 둔다.

**기술 범위:** Linux block layer C 코드, blk-mq, sysfs queue attribute, per-CPU counter, fio 기반 smoke 검증.

---

## 범위 고정

Part 4에서 구현한다.

```text
1. CONFIG_DPAS
2. request_queue -> dpas_queue pointer
3. q->dpas allocation/free
4. pas_enabled / pas_debug / pas_duration_ns sysfs
5. PAS-only sleep-before-poll hook
6. UNDER/OVER 최소 counter
7. pas_stats / pas_stats_reset
```

Part 4에서 구현하지 않는다.

```text
1. full DPAS mode switching
2. switch_enabled / switch_param*
3. CP / PAS overloaded / interrupt mode transition
4. NVMe queue remapping
5. submission-side REQ_POLLED 제어
6. YCSB/RocksDB macrobenchmark
```

Part 4의 핵심 판단은 다음 한 문장이다.

```text
Part 4는 queue mapping을 다시 만드는 단계가 아니라,
이미 HCTX_TYPE_POLL로 들어온 request의 poll path 앞에
PAS sleep-before-poll policy를 최소로 얹는 단계다.
```

## 파일 구조

| 파일 | 작업 | 책임 |
|---|---|---|
| `src/linux-upstream/block/Kconfig` | 수정 | `CONFIG_DPAS` option 추가 |
| `src/linux-upstream/block/Makefile` | 수정 | `blk-dpas.o` build 연결 |
| `src/linux-upstream/block/blk-dpas.h` | 생성 | block layer 내부 DPAS helper 선언 |
| `src/linux-upstream/block/blk-dpas.c` | 생성 | `struct dpas_queue`, init/free, sysfs helper, sleep/update/counter helper 구현 |
| `src/linux-upstream/include/linux/blkdev.h` | 수정 | `struct request_queue`에 guarded `struct dpas_queue *dpas` 추가 |
| `src/linux-upstream/block/blk-core.c` | 수정 | queue free path에서 `dpas_queue_exit(q)` 호출 |
| `src/linux-upstream/block/blk-mq.c` | 수정 | queue init 성공 후 `dpas_queue_init(q)`, `blk_mq_poll()` hook 추가 |
| `src/linux-upstream/block/blk-sysfs.c` | 수정 | `pas_enabled`, `pas_debug`, `pas_duration_ns`, `pas_stats`, `pas_stats_reset` sysfs entry 추가 |

## 작업 1: Kconfig와 build 연결

**파일:**
- 수정: `src/linux-upstream/block/Kconfig`
- 수정: `src/linux-upstream/block/Makefile`
- 생성: `src/linux-upstream/block/blk-dpas.h`
- 생성: `src/linux-upstream/block/blk-dpas.c`

- [ ] **단계 1: config option 추가**

`src/linux-upstream/block/Kconfig`의 `if BLOCK` 안에 다음 option을 추가한다. Kconfig help 문구는 kernel tree 관례에 맞춰 영어로 둔다.

```kconfig
config DPAS
	bool "DPAS PAS-only polling experiment"
	depends on BLOCK
	help
	  Enable the minimal PAS-only polling experiment for DPAS migration.
	  This option adds block-layer PAS state, sysfs controls, and
	  sleep-before-poll instrumentation. It does not enable full DPAS
	  mode switching or NVMe queue remapping.
```

- [ ] **단계 2: object build 연결**

`src/linux-upstream/block/Makefile`에 다음 줄을 추가한다.

```make
obj-$(CONFIG_DPAS)		+= blk-dpas.o
```

- [ ] **단계 3: 내부 helper header 생성**

`src/linux-upstream/block/blk-dpas.h`를 만든다. 이 header는 `CONFIG_DPAS=n`에서도 caller가 빌드되도록 no-op inline helper를 제공해야 한다. 이렇게 해야 `blk-mq.c`, `blk-core.c`, `blk-sysfs.c`에 `#ifdef CONFIG_DPAS`가 흩어지지 않는다.

필수 helper interface:

```c
struct request_queue;
struct blk_mq_hw_ctx;
struct io_comp_batch;

struct dpas_poll_sample {
	u64 requested_sleep_ns;
	u64 actual_sleep_ns;
	bool slept;
	bool skipped;
};

int dpas_queue_init(struct request_queue *q);
void dpas_queue_exit(struct request_queue *q);
bool dpas_poll_enabled(struct request_queue *q, unsigned int flags);
int dpas_poll_sleep_before(struct request_queue *q,
			   struct blk_mq_hw_ctx *hctx,
			   blk_qc_t cookie,
			   unsigned int flags,
			   struct dpas_poll_sample *sample);
void dpas_poll_update_after(struct request_queue *q,
			    const struct dpas_poll_sample *sample,
			    int ret);
ssize_t dpas_sysfs_show_enabled(struct request_queue *q, char *page);
ssize_t dpas_sysfs_store_enabled(struct request_queue *q,
				 const char *page, size_t count);
ssize_t dpas_sysfs_show_debug(struct request_queue *q, char *page);
ssize_t dpas_sysfs_store_debug(struct request_queue *q,
			       const char *page, size_t count);
ssize_t dpas_sysfs_show_duration_ns(struct request_queue *q, char *page);
ssize_t dpas_sysfs_store_duration_ns(struct request_queue *q,
				     const char *page, size_t count);
ssize_t dpas_sysfs_show_stats(struct request_queue *q, char *page);
ssize_t dpas_sysfs_store_stats_reset(struct request_queue *q,
				     const char *page, size_t count);
```

- [ ] **단계 4: stub 구현 생성**

`src/linux-upstream/block/blk-dpas.c`를 만들고 init/free/sysfs helper의 disabled 기본 동작만 구현한다. 이 작업에서는 아직 sleep 동작을 넣지 않는다.

기대 동작:

```text
dpas_queue_init(q):
  memory가 있으면 q->dpas를 할당한다.

dpas_queue_exit(q):
  q->dpas를 free하고 pointer를 NULL로 만든다.

pas_enabled:
  기본값은 0이다.

pas_debug:
  기본값은 0이다.

pas_duration_ns:
  기본값은 0이다.

pas_stats:
  모든 counter가 0인 상태로 출력된다.
```

- [ ] **단계 5: build 확인**

실행:

```bash
cd src/linux-upstream
make olddefconfig
make -j"$(nproc)" block/
```

기대 결과:

```text
CONFIG_DPAS=y일 때 block/blk-dpas.o가 build된다.
CONFIG_DPAS=n일 때 blk-dpas.o 참조가 남지 않는다.
```

## 작업 2: Queue state 배치와 lifecycle

**파일:**
- 수정: `src/linux-upstream/include/linux/blkdev.h`
- 수정: `src/linux-upstream/block/blk-mq.c`
- 수정: `src/linux-upstream/block/blk-core.c`
- 수정: `src/linux-upstream/block/blk-dpas.c`

- [ ] **단계 1: request_queue pointer 추가**

`struct request_queue`에 아래 pointer만 guarded field로 추가한다. old DPAS처럼 `pas_enabled`, `switch_enabled`, `switch_param*`를 직접 여러 개 넣지 않는다.

```c
#ifdef CONFIG_DPAS
	struct dpas_queue	*dpas;
#endif
```

필요하면 주변 struct declaration 영역에 forward declaration도 추가한다.

```c
#ifdef CONFIG_DPAS
struct dpas_queue;
#endif
```

- [ ] **단계 2: blk-mq queue setup 이후 초기화**

`blk_mq_alloc_queue()`에서 `blk_mq_init_allocated_queue(set, q)`가 성공한 뒤 `dpas_queue_init(q)`를 호출한다.

정책:

```text
q->dpas allocation이 실패해도 request_queue 생성은 실패시키지 않는다.
이 경우 q->dpas는 NULL로 남기고 DPAS/PAS만 disabled 상태로 둔다.
sysfs store는 helper policy에 따라 -ENOMEM 또는 -EINVAL을 반환한다.
```

- [ ] **단계 3: RCU free 전에 해제**

`blk_free_queue(q)`에서 `call_rcu(&q->rcu_head, blk_free_queue_rcu)`로 queue memory가 넘어가기 전에 `dpas_queue_exit(q)`를 호출한다.

- [ ] **단계 4: lifecycle 검증**

실행:

```bash
cd src/linux-upstream
make -j"$(nproc)" block/
```

kernel boot 이후 runtime 확인:

```bash
find /sys/block -maxdepth 2 -name pas_enabled -print
```

기대 결과:

```text
DPAS allocation이 실패해도 queue 생성 자체는 실패하지 않는다.
CONFIG_DPAS=y이고 attribute visibility 조건을 만족하는 queue에서만 DPAS sysfs file이 보인다.
```

## 작업 3: 최소 sysfs 인터페이스

**파일:**
- 수정: `src/linux-upstream/block/blk-sysfs.c`
- 수정: `src/linux-upstream/block/blk-dpas.c`

- [ ] **단계 1: queue entry 추가**

아래 queue attribute를 추가한다.

```text
pas_enabled
pas_debug
pas_duration_ns
pas_stats
pas_stats_reset
```

가능하면 기존 `QUEUE_RW_ENTRY()` pattern을 따른다.

- [ ] **단계 2: visibility check 추가**

request-based queue에서만 PAS attribute를 노출한다. 최소 조건은 다음과 같다.

```text
queue_is_mq(q)
q->mq_ops != NULL
q->mq_ops->poll != NULL
```

poll callback이 없는 device에서는 `pas_enabled`가 의미 없으므로 store에서 성공시키지 않는다.

- [ ] **단계 3: sysfs 동작 정의**

필수 동작:

```text
pas_enabled:
  show -> "0\n" 또는 "1\n"
  store -> 0 또는 1만 허용

pas_debug:
  show -> "0\n" 또는 "1\n"
  store -> 0 또는 1만 허용

pas_duration_ns:
  show -> 현재 fixed duration ns 값
  store -> unsigned integer ns 값 허용

pas_stats:
  show -> multiline counter snapshot 출력
  store -> 지원하지 않음

pas_stats_reset:
  show -> "0\n"
  store 1 -> counter reset
```

- [ ] **단계 4: sysfs smoke 확인**

kernel boot 이후 실행:

```bash
cat /sys/block/<dev>/queue/pas_enabled
echo 1 | sudo tee /sys/block/<dev>/queue/pas_enabled
cat /sys/block/<dev>/queue/pas_enabled
cat /sys/block/<dev>/queue/pas_stats
echo 1 | sudo tee /sys/block/<dev>/queue/pas_stats_reset
```

기대 결과:

```text
pas_enabled가 0에서 1로 바뀐다.
pas_stats를 읽을 수 있다.
pas_stats_reset이 warning이나 oops 없이 counter를 reset한다.
```

## 작업 4: PAS-only poll hook

**파일:**
- 수정: `src/linux-upstream/block/blk-mq.c`
- 수정: `src/linux-upstream/block/blk-dpas.c`
- 수정: `src/linux-upstream/block/blk-dpas.h`

- [ ] **단계 1: blk_hctx_poll() 주변에 hook 추가**

`blk_mq_poll()`의 논리 구조를 아래처럼 바꾼다.

```c
int blk_mq_poll(struct request_queue *q, blk_qc_t cookie,
		struct io_comp_batch *iob, unsigned int flags)
{
	struct blk_mq_hw_ctx *hctx;
	struct dpas_poll_sample sample = { };
	int ret;

	if (!blk_mq_can_poll(q))
		return 0;

	hctx = q->queue_hw_ctx[cookie];

	if (dpas_poll_enabled(q, flags))
		dpas_poll_sleep_before(q, hctx, cookie, flags, &sample);

	ret = blk_hctx_poll(q, hctx, iob, flags);

	dpas_poll_update_after(q, &sample, ret);

	return ret;
}
```

실제 patch에서는 기존 return semantics를 보존해야 한다. `dpas_poll_enabled()`가 false이면 현재 kernel과 동일하게 동작해야 한다.

- [ ] **단계 2: sleep 금지 조건 존중**

`dpas_poll_enabled(q, flags)`는 아래 조건에서 false를 반환해야 한다.

```text
q->dpas == NULL
pas_enabled == 0
flags가 one-shot 또는 target-specific no-sleep behavior를 의미함
pas_duration_ns == 0
q->mq_ops == NULL
q->mq_ops->poll == NULL
```

현재 `src/linux-upstream` tree에는 `BLK_POLL_ONESHOT`만 보인다. old DPAS 5.18 tree에는 `BLK_POLL_NOSLEEP`도 있으므로, target kernel에 실제로 정의되어 있지 않은 한 최신 tree patch에서 `BLK_POLL_NOSLEEP`를 참조하지 않는다.

- [ ] **단계 3: fixed-duration sleep 먼저 구현**

첫 working patch에서는 `pas_duration_ns`를 고정 sleep duration으로 사용한다. adaptive duration update는 첫 pass에 넣지 않는다.

이유:

```text
1. 먼저 hook이 실제로 실행되는지 counter로 확인해야 한다.
2. adaptive update까지 동시에 넣으면 실패 원인이 sleep 위치인지 update logic인지 분리하기 어렵다.
3. old DPAS의 sr_last/sr_pnlt/update_req/dur_cnt 의미는 이후 checkpoint에서 대조한다.
```

- [ ] **단계 4: 첫 poll 결과 분류**

sleep 이후 첫 `blk_hctx_poll()` 결과를 다음처럼 분류한다.

```text
ret > 0 -> OVER
ret == 0 -> UNDER
ret < 0 -> ERROR
```

각 결과는 `trace_validation_plan.md`의 matching counter에 반영한다.

- [ ] **단계 5: build 확인**

실행:

```bash
cd src/linux-upstream
make -j"$(nproc)" block/
```

기대 결과:

```text
unused static function warning이 없어야 한다.
CONFIG_DPAS=n에서 동작 변화가 없어야 한다.
CONFIG_DPAS=y, pas_enabled=0에서 동작 변화가 없어야 한다.
```

## 작업 5: 최소 runtime 검증

**파일:**
- 참조: `part3/trace_validation_plan.md`
- 참조: `part3/porting_risk_register.md`
- 생성: 구현을 시작한 뒤 `part4/` 아래 local run note

- [ ] **단계 1: disabled 기준선 확인**

`pas_enabled=0` 상태에서 polled fio workload를 실행한다.

기록할 것:

```text
fio command
kernel version
device name
pas_stats before
pas_stats after
dmesg warning/oops status
```

기대 결과:

```text
pas_sleep_attempt_count는 0으로 유지된다.
poll_enter_count는 증가할 수 있다.
fio는 완료된다.
```

- [ ] **단계 2: enabled fixed-duration 실행**

설정:

```bash
echo 1 | sudo tee /sys/block/<dev>/queue/pas_enabled
echo 10000 | sudo tee /sys/block/<dev>/queue/pas_duration_ns
```

같은 polled fio workload를 실행한다.

기대 결과:

```text
pas_sleep_attempt_count가 증가한다.
pas_under_count 또는 pas_over_count가 증가한다.
timer_failure_count가 sleep_done_count보다 과도하게 크지 않다.
fio가 완료된다.
dmesg에 warning이나 oops가 없다.
```

- [ ] **단계 3: duration 민감도 sanity 확인**

짧은 test 두 개를 실행한다.

```bash
echo 1000 | sudo tee /sys/block/<dev>/queue/pas_duration_ns
echo 50000 | sudo tee /sys/block/<dev>/queue/pas_duration_ns
```

기대 결과:

```text
duration을 바꾸면 UNDER/OVER 비율도 바뀐다.
비율이 전혀 바뀌지 않으면 hook이 실제 first poll 전에 도달하는지 다시 확인한다.
```

## 작업 6: Part 4 완료 gate

Part 4는 아래 조건이 모두 참일 때만 완료로 본다.

- [ ] `CONFIG_DPAS=n` build가 통과한다.
- [ ] `CONFIG_DPAS=y` build가 통과한다.
- [ ] `pas_enabled=0`에서 PAS sleep이 발생하지 않는다.
- [ ] `pas_enabled=1`에서 polled I/O 중 sleep counter가 증가한다.
- [ ] `pas_stats`를 읽고 reset할 수 있다.
- [ ] `nvme_pci_map_queues()`를 queue remapping 목적으로 수정하지 않았다.
- [ ] `switch_enabled`, `switch_param*`, `N_INT`, `N_PAS`, full mode state machine을 추가하지 않았다.
- [ ] smoke run 중 dmesg에 warning, oops, hang이 없다.

## Part 4 시작 handoff 문장

Part 4 구현을 시작할 때는 아래 문장을 기준으로 삼는다.

```text
Part 4는 request_queue에 q->dpas state를 붙이고,
최소 sysfs control과 counter를 추가한 뒤,
blk_mq_poll()에 guarded sleep-before-poll hook을 넣어 PAS-only를 구현한다.
full DPAS mode switching, submission-side interrupt control,
NVMe queue remapping은 의도적으로 이후 Part로 넘긴다.
```
