# DPAS 커널 수정 종합 보고서

> 대상: `dpas-kernel/` (Linux v7.1-rc4 기반)
> 기준: base 커밋 `8fac1449a "Import Linux v7.1-rc4"` → 현재 working tree(미커밋 포함)
> 목적: base 커널에서 무엇이, 왜, 어떻게 바뀌었고, 그 결과 기대되는 효과는 무엇이며, 전체 I/O polling path가 이론적으로 어떻게 구성되는지를 이 문서 하나로 이해할 수 있게 한다.
> 검증: git diff(base→worktree) 전수, `history/*.md` 전수, 현재 파일 실제 상태, upstream/DPAS 출처 구분까지 3회 이상 교차검증함(§9).

---

## 0. 한 줄 요약 (TL;DR)

DPAS는 **NVMe 같은 초고속 블록장치에서 polling과 interrupt를 상황에 따라 바꿔 써서, latency를 낮추면서도 CPU 낭비를 줄이는** 기법이다. 이 작업은 논문(5.18 기반 `kernel/`)의 DPAS 아이디어를 최신 Linux 7.1-rc4(`dpas-kernel/`)에 **구조를 정리하면서 재이식**한 것이다.

핵심 설계 결정 세 가지:

1. **상태 저장을 `request_queue` 레벨로 통일** — 5.18식 per-cpu `irq_poll_switch`나 별도 모듈(`blk-dpas.c`)을 쓰지 않고, `struct request_queue`에 DPAS 필드를 직접 넣었다.
2. **정책 개입을 poll path 한 곳(`blk_mq_poll_bio()`)으로 단일화** — 5.18은 제출(submit) 경로 여러 곳에 훅이 분산돼 누락 위험이 컸다. 7.1 포팅은 sleep/feedback 정책을 poll 경로 한 곳에 모았다.
3. **sync Direct I/O HIPRI polling 경로 복구** — upstream이 막아둔 `pvsync2 + direct=1 + hipri` 경로를 연구 재현을 위해 되살렸다.

여기에 더해 working tree에는 **full mode-switching(INT↔CP↔PAS↔OL 자동 전환)** 의 제출측 helper와 전환 상태머신이 추가된 미커밋 단계가 있다.

---

## 1. 배경: DPAS와 두 개의 커널 트리

### 1.1 DPAS란

CPU가 장치 완료를 확인하는 방법은 크게 둘이다.

- **Classic Polling(CP)**: CPU가 쉬지 않고 완료를 확인(busy-spin). latency 최저, CPU 100%.
- **Interrupt(INT)**: task가 잠들고 완료 인터럽트로 깨어남. CPU 최소, latency 높음.

DPAS는 그 사이에 여러 모드를 두고, **poll 직전에 적절히 잠깐 자거나(LHP/PAS)**, **workload에 따라 모드를 전환**해서 "CP에 가까운 성능을 더 적은 CPU로" 얻으려 한다.

| 모드 | 이름 | 핵심 동작 |
|---|---|---|
| INT | Interrupt | `REQ_POLLED`를 끄고 인터럽트 완료 |
| CP | Classic Polling | sleep 없이 busy-spin polling |
| LHP | Low-power Hybrid Polling | poll 직전에 고정/적응 시간만큼 sleep |
| PAS | Poll-After-Sleep | bucket별로 학습한 sleep 후 poll |
| OL | OverLoad | I/O가 몰릴 때 쓰는 과부하 모드 |
| EHP | Early Hint Polling | bucket별로 poll/INT를 미리 결정(5.18 개념) |

### 1.2 저장소 안의 두 커널

- `kernel/` = **원본 DPAS 참조 트리(Linux 5.18 기반)**. 논문 구현. 수정 대상이 아니라 비교 기준이다.
- `dpas-kernel/` = **포팅 대상 트리(Linux 7.1-rc4 기반)**. 이 보고서가 분석하는 실제 수정 대상.

`dpas-kernel/Makefile` 기준 버전: `VERSION=7, PATCHLEVEL=1, SUBLEVEL=0, EXTRAVERSION=-rc4`.

### 1.3 왜 7.1로 옮기기가 까다로운가 (포팅의 근본 난점)

5.18과 7.1 사이에 block layer의 polling 구조 자체가 바뀌었다.

- **5.18**: polling이 `request` 기반이었다. `cookie → request` 역추적이 가능했고, hybrid polling 통계 인프라(`q->poll_stat`, `q->poll_cb`, `blk_mq_poll_nsecs()`)가 upstream에 존재했으며 DPAS/EHP/PAS가 그 위에 얹혀 있었다.
- **6.x~7.1**: upstream이 **hybrid polling을 삭제**했고, polling이 `bio` 기반(`bio_poll()`)으로 바뀌었다. `bio->bi_cookie`는 request tag가 아니라 **poll할 hctx 번호**가 되었다.

따라서 단순 복붙이 불가능했고, "request 기반 로직 → bio 기반 로직"으로 **번역**하고, 삭제된 통계 인프라를 **부분 복원**해야 했다. 이것이 아래 모든 수정의 공통 배경이다.

---

## 2. 전체 git 히스토리 (base 위에 쌓인 커밋)

base `8fac1449a` 위에 오래된→최신 순으로 다음 커밋이 쌓였고, 그 위에 **미커밋 working tree 변경**이 있다.

| 순서 | 커밋 | 제목 | 한 일 |
|---|---|---|---|
| base | `8fac1449a` | Import Linux v7.1-rc4 | 기준 커널 |
| 1 | `469d7c15c` | 커널 pas 최소 구현 | **모듈식 시도**: `block/blk-dpas.{c,h}` + Kconfig/Makefile. 별도 `struct dpas_queue` 포인터 + `struct pas_bucket`(ppm fixed-point), `DPAS_NR_BUCKETS=16` |
| 2 | `953fbd097` | 모듈화 취소, request_queue 직접 필드로 전환 | `blk-dpas.{c,h}` **삭제**, 상태를 `struct request_queue`에 직접 이동. 정적 selftest 3종 추가 |
| 3 | `347554c8d` | dio의 hipri path 복구 | iomap sync DIO HIPRI polling 복구 + `io_poll_delay` sysfs 복구 |
| 4 | `0820286b7` | 주석 수정 및 빌드 테스트 | iomap 주석 정리, `pas_sysfs_static.py` 추가 |
| 5 | `c1ea80a5f` | `blk_mq_poll_bio()` 최소 hook | bio-aware poll wrapper 설치(아직 sleep 없음, no-sleep checkpoint) |
| 6 | `19009d1c0` | fixed lhp 구현 | `BIO_LHP_POLL_SLEPT` flag, hrtimer sleep, `io_poll_delay` store 복구 |
| 7 | `8e7968051` | adaptive pas 도입 | PAS bucket, `sr_last/sr_pnlt` over/under 판정, `dur_cnt` guard, duration update |
| 8 | `658e97c65` | up/dn cooldn·heatup 포팅 | DPAS1/DPAS2 적응형 up/dn 조정 |
| 9 | `4be3fefb1` | adaptive lhp 포팅 | blk-stat 통계 인프라(`poll_cb`, `poll_stat`, `blk_stats_alloc_enable`) 복원 |
| 10 (HEAD) | `633cc0742` | 코드에 주석 추가 | `switch_param1~7` 의미 주석 |
| — | working tree(미커밋) | full DPAS mode-switch | `blk_dpas_prepare_bio()` 제출 helper + `blk_dpas_maybe_switch_mode()` 전환 상태머신 + `switch_enabled` sysfs + `dpas_mode`/카운터 |

> 중요한 흐름: **모듈식(1) → 직접필드(2)** 로의 방향 전환, **제출경로 복구(3) → poll hook(5) → fixed LHP(6) → adaptive PAS(7,8) → adaptive LHP 통계(9)** 의 단계적 확장, 마지막으로 **mode switching(미커밋)** 이라는 큰 그림이다.

### 2.1 누적 diffstat (base → working tree)

```
 block/blk-core.c                                   |  65 ++-
 block/blk-mq.c                                     | 559 ++++++++   (핵심 엔진)
 block/blk-mq.h                                     |   2 +
 block/blk-stat.c                                   |  24 +
 block/blk-stat.h                                   |   1 +
 block/blk-sysfs.c                                  | 340 ++++++     (sysfs knob)
 block/fops.c                                       |   5 +-
 fs/iomap/direct-io.c                               |  22 +-
 include/linux/blk_types.h                          |  14 +
 include/linux/blkdev.h                             |  66 ++-
 tools/testing/selftests/dpas/no_q_dpas_static.py   |  56 +++
 tools/testing/selftests/dpas/pas_queue_lifecycle_static.py | 84 ++++
 tools/testing/selftests/dpas/pas_sysfs_static.py   | 110 ++++
 tools/testing/selftests/dpas/request_queue_pas_stat_static.py | 64 +++
 14 files changed, 1395 insertions(+), 17 deletions(-)
```

### 2.2 왜 모듈식(1)을 버리고 직접필드(2)로 갔나

`469d7c15c`의 첫 시도는 upstream 친화적으로 `struct dpas_queue *`(별도 구조체 포인터) + `struct pas_bucket`(ppm 고정소수점) + `CONFIG_DPAS`를 두는 깔끔한 추상화였다. 그러나 **논문 실험 경로를 빠르게 재현**하는 것이 우선이라는 결정에 따라 `953fbd097`에서 이를 전부 버리고 5.18처럼 `request_queue`에 필드를 직접 박는 방식으로 바꿨다.

- 장점: 5.18 코드와 1:1 비교 쉬움, 실험 경로 재현이 빠름.
- 단점(인지하고 감수): 장기적으로 upstream cleanup 비용이 생김.

이 결정 때문에 이후 모든 상태(`pas_enabled`, `dpas_mode`, `pas_stat` 등)가 `struct request_queue` 안에 직접 들어가게 된다(§3.1).

---

## 3. 파일별 수정 상세 (무엇을 / 왜 / 기대효과)

### 3.1 `include/linux/blkdev.h` — DPAS 상태의 집

DPAS의 모든 런타임 상태가 여기 들어간다. 두 부분으로 나뉜다.

**(a) 상수와 `enum dpas_mode` (struct 밖에 선언)**

```c
#define BLK_MQ_POLL_STATS_BKTS 16   /* PAS/통계 bucket 개수 */
#define BLK_MQ_POLL_CLASSIC   -1    /* classic polling 표시값 */

enum dpas_mode {
    DPAS_MODE_INT = 0,
    DPAS_MODE_CP  = 1,
    DPAS_MODE_PAS = 2,
    DPAS_MODE_OL  = 3,
};
```

- **왜 struct 밖인가**: 초기에는 `enum`을 `struct request_queue` 내부에 선언해서 `-Werror` 빌드가 깨졌다(2026-06-14/15 기록). 타입 선언을 struct 밖(현재 파일 489번째 줄, struct는 그 아래)으로 빼서 해결했다. **검증: 현재 파일에서 `enum dpas_mode`는 489행(struct 밖), `dpas_mode` 필드는 526행(struct 안)으로 확인됨.**
- **왜 `BLK_MQ_POLL_CLASSIC=-1`**: upstream이 hybrid polling을 지우면서 이 상수도 사라졌는데, `io_poll_delay=-1`(classic) 의미를 되살리려고 재정의했다.

**(b) `struct request_queue`에 추가된 DPAS 필드들**

```c
int                           poll_nsec;       /* io_poll_delay (ns). -1=classic, 0=adaptive LHP, >0=fixed LHP */
struct blk_stat_callback     *poll_cb;         /* adaptive LHP 통계 수집 콜백 */
struct blk_rq_stat           *poll_stat;       /* bucket별 평균 latency 스냅샷 */
struct blk_rq_pas_stat __percpu *pas_stat;     /* PAS per-cpu bucket 학습 상태 */
int                           last_poll_count; /* 임시 checkpoint counter */

spinlock_t      dpas_lock;     /* mode/counter 보호 */
enum dpas_mode  dpas_mode;     /* 현재 모드 */
u32 dpas_cp_cnt, dpas_pas_cnt, dpas_ol_cnt, dpas_int_cnt;  /* 모드별 평가 카운터 */
u32 dpas_qd; u64 dpas_qd_sum; u32 dpas_tf;     /* queue-depth 누적/합, "too-fast"(floor 도달) 카운터 */

int pas_enabled;            /* PAS on/off */
int pas_adaptive_enabled;   /* 0=off, 1=DPAS1, 2=DPAS2 */
int ehp_enabled;            /* EHP knob(상태만 노출) */
int max_no_lock;            /* 5.18 호환 knob */
int poll_threshold;         /* over/under 판정 임계 poll_count */
int logging_enabled;        /* 디버그 로깅 knob */
int switch_enabled;         /* mode switching on/off */
int switch_param1~7;        /* 모드 전환 임계값들(§6) */
u64 div;                    /* fixed-point 분모(기본 1000000) */
u32 d_init;                 /* 초기/최소 sleep duration(us 단위 값) */
long long up_init, dn_init; /* up/dn 초기값 */
long long heat_up, cool_dn, min_dn, max_dn; int updn_ratio; /* DPAS1/2 조정 파라미터 */
unsigned long long cnt_rel_hybrid_poll, cnt_rel_fops, cnt_rel_comp_before_sleep, cnt_lock_d_c_separate; /* 디버그 카운터 */
```

또한 함수 프로토타입 `bool blk_dpas_prepare_bio(...)`이 선언된다.

- **왜 필요**: §2.2의 직접필드 결정에 따라, 모든 DPAS 상태를 queue 단위로 모았다. queue마다 독립적으로 모드/통계를 갖게 되어 장치별로 다른 정책을 쓸 수 있다.
- **기대효과**: 정책 코드가 `q->...` 한 곳에서 상태를 읽고, sysfs(§3.10)가 같은 필드를 runtime에 조절할 수 있다. 경로별로 상태가 흩어지지 않아 "누락 경로" 위험이 준다.

### 3.2 `include/linux/blk_types.h` — bio flag와 PAS 통계 구조체

```c
enum {
    ...
    BIO_LHP_POLL_SLEPT,   /* fixed/adaptive LHP·PAS sleep이 이미 적용된 bio 표시 */
    BIO_FLAG_LAST
};

struct blk_rq_pas_stat {
    u64 dur;            /* 이번에 잘 sleep duration(ns) */
    long long adj;      /* duration 조정 계수(fixed-point, q->div 기준) */
    long long up;       /* undersleep 시 증가폭 */
    long long dn;       /* oversleep 시 감소폭 */
    u8 sr_pnlt;         /* 전전번 sleep 결과(0=over, 1=under) */
    u8 sr_last;         /* 직전 sleep 결과 */
    u8 update_req;      /* 다음 duration 갱신 pending */
    u8 dur_cnt;         /* 현재 duration "세대" 번호 */
    u8 dur_cnt_checked; /* 이 세대 결과가 이미 반영됐는가 */
};
```

- **왜 bio flag인가**: 5.18은 `cookie→request` 복원 후 `RQF_MQ_POLL_SLEPT`(request flag)로 중복 sleep을 막았다. 7.1은 poll 경로가 `bio` 기반이라, 같은 역할을 `bio` flag로 **번역**했다. 같은 bio가 완료 전 여러 번 `bio_poll()`로 재진입해도 sleep은 딱 한 번만 하게 한다.
- **왜 `struct blk_rq_pas_stat`인가**: PAS의 bucket별 학습 상태를 담는 그릇. 초기 모듈식(ppm)과 달리 5.18식 `adj/up/dn`(분모 `div` 기준 fixed-point)으로 표현해 5.18 수식과 1:1 대응시켰다.
- **기대효과**: 중복 sleep 방지로 latency 폭증을 막고, bucket별 적응 학습의 메모리 레이아웃을 확정한다.

### 3.3 `block/blk-stat.{h,c}` — adaptive LHP 통계 인프라 복원

upstream이 지운 hybrid polling 통계 수집의 최소 부분을 되살렸다.

**`blk-stat.h`**: `bool blk_stats_alloc_enable(struct request_queue *q);` 선언 추가.

**`blk-stat.c`**: 구현 추가.

```c
bool blk_stats_alloc_enable(struct request_queue *q)
{
    struct blk_rq_stat *poll_stat;
    poll_stat = kcalloc(BLK_MQ_POLL_STATS_BKTS, sizeof(*poll_stat), GFP_ATOMIC);
    if (!poll_stat)
        return false;
    /* 여러 cpu가 동시에 처음 활성화할 수 있어 cmpxchg로 1회만 설치 */
    if (cmpxchg(&q->poll_stat, NULL, poll_stat) != NULL) {
        kfree(poll_stat);
        return true;
    }
    blk_stat_add_callback(q, q->poll_cb);
    return false;
}
```

- **왜 필요**: adaptive LHP가 읽을 `q->poll_stat[bucket]`(bucket별 mean/min/max/nr_samples)을 처음 한 번 만든다. polling hot path/atomic 문맥일 수 있어 `GFP_ATOMIC`을 쓰고, 동시 진입은 `cmpxchg`로 직렬화한다.
- **헷갈리기 쉬운 점**: 처음 성공적으로 할당한 호출은 `false`를 반환한다. 그래서 **adaptive LHP 첫 호출에서는 sleep이 0**일 수 있다(통계가 아직 없는 cold-start). 통계 window가 채워진 뒤부터 `mean/2` sleep이 가능해진다.
- **기대효과**: NVMe 드라이버 수정 없이, 공통 block layer 통계만으로 adaptive LHP를 구동할 기반을 제공한다.

### 3.4 `block/blk-core.c` — 제출 helper, bio_poll 진입 전환, queue 해제 정리

세 가지 변경이 있다.

**(a) `blk_free_queue()`에 통계 자원 정리 추가**

```c
if (q->poll_stat)
    blk_stat_remove_callback(q, q->poll_cb);
blk_stat_free_callback(q->poll_cb);
kfree(q->poll_stat);
```

- **왜**: §3.3에서 만든 `poll_cb`/`poll_stat`을 queue 소멸 시 누수 없이 정리해야 한다. `poll_cb`가 `q->stats->callbacks` 리스트에 연결될 수 있어, **`blk_free_queue_stats(q->stats)`보다 먼저** 콜백을 제거/해제해야 한다(순서 제약). 5.18은 이 정리를 `blk-sysfs.c:blk_release_queue()`에서 했지만 7.1 구조에 맞춰 `blk_free_queue()`로 위치를 옮겼다("이사").

**(b) `bio_poll()`이 `blk_mq_poll_bio()`로 진입하도록 전환**

```c
- ret = blk_mq_poll(q, cookie, iob, flags);
+ ret = blk_mq_poll_bio(q, bio, cookie, iob, flags);
```

- **왜**: PAS/LHP 정책은 "read냐 write냐, 크기, 중복 sleep 여부"를 알아야 하는데 그 정보는 전부 `bio`에 있다. 기존 `blk_mq_poll(q, cookie, ...)`는 bio를 받지 않으므로, **bio를 poll 정책까지 전달**하는 wrapper로 바꿨다.

**(c) `blk_dpas_prepare_bio()` 제출 helper 추가 (working tree, 미커밋)**

HIPRI I/O가 제출될 때 현재 `dpas_mode`를 보고 `REQ_POLLED`를 set/clear하고, 모드별 카운터를 올리는 함수다.

```c
bool blk_dpas_prepare_bio(struct request_queue *q, struct bio *bio, struct kiocb *iocb)
{
    if (!q->switch_enabled) {        /* switching off → 항상 polled */
        bio_set_polled(bio, iocb);
        return true;
    }
    spin_lock_irqsave(&q->dpas_lock, flags);
    switch (q->dpas_mode) {
    case DPAS_MODE_INT:
        iocb->ki_flags &= ~IOCB_HIPRI;   /* ★ 제출 시점에 polling 강제 해제 */
        bio_clear_polled(bio);
        q->dpas_int_cnt++;
        if (q->dpas_int_cnt >= q->switch_param7) {  /* INT→OL 전이 */
            q->dpas_mode = DPAS_MODE_OL; q->dpas_ol_cnt = 0;
            q->dpas_qd_sum = 0; q->dpas_tf = 0;
        }
        polled = false; break;
    case DPAS_MODE_CP:  bio_set_polled(bio, iocb); q->dpas_cp_cnt++;  break;
    case DPAS_MODE_PAS: bio_set_polled(bio, iocb); q->dpas_pas_cnt++; break;
    case DPAS_MODE_OL:  bio_set_polled(bio, iocb); q->dpas_ol_cnt++;  break;
    default:            bio_set_polled(bio, iocb);                    break;
    }
    spin_unlock_irqrestore(&q->dpas_lock, flags);
    return polled;   /* true=polled로 제출, false=INT(인터럽트)로 제출 */
}
```

- **왜 필요**: 5.18 DPAS의 절반은 "제출 시점 `REQ_POLLED` 제어"였다. 특히 **INT 모드는 제출 단계에서 `IOCB_HIPRI`/`REQ_POLLED`를 지워야** 인터럽트 완료로 가게 된다. poll 루프에서 `bio_poll()`만 안 부른다고 INT가 되지는 않는다(이미 polled로 제출됐으면 poll queue로 가버림). 그래서 제출측 helper가 반드시 필요하다.
- **기대효과**: 모드에 따라 제출 자체를 polled/interrupt로 가르고, 평가용 카운터(`cp/pas/ol/int_cnt`)를 쌓아 자동 전환(§3.9, §6)의 입력을 만든다.
- **주의**: `blk_dpas_*` 함수들은 커널 표준 탭 들여쓰기가 아니라 4-space 들여쓰기로 작성돼 있다(현재 `git diff --check`는 통과하지만 커널 스타일상 정리 필요). 이는 미커밋 단계의 알려진 cosmetic 이슈다(§10).

### 3.5 `block/fops.c` — raw block device 비동기 DIO 제출 경로

base(upstream)는 단순히 HIPRI면 무조건 polled로 제출했다.

```c
- if (iocb->ki_flags & IOCB_HIPRI) {
-     bio->bi_opf |= REQ_POLLED;
+ if (iocb->ki_flags & IOCB_HIPRI &&
+     blk_dpas_prepare_bio(bdev_get_queue(bio->bi_bdev), bio, iocb)) {
      submit_bio(bio);
      WRITE_ONCE(iocb->private, bio);
  } else { ... }
```

- **왜**: `/dev/nvme0n1` 직접 비동기 DIO 경로도 DPAS 모드 제어 아래 두기 위해서다. `blk_dpas_prepare_bio()`가 `false`(INT)를 반환하면 polled 제출 분기를 건너뛰어 인터럽트 완료 경로로 간다.
- **왜 이 경로가 중요**: 06-06 매핑 조사에서 확인된 7.1의 "누락 경로 위험". 7.1은 `REQ_POLLED`를 거는 지점이 ① iomap(`bio_set_polled()` 헬퍼) ② raw blockdev(인라인 `bio->bi_opf |= REQ_POLLED`) ③ NVMe passthrough(rq 레벨)로 **방식이 갈린다**. 헬퍼만 후킹하면 ②를 놓친다. 그래서 ②도 명시적으로 helper를 거치게 했다.
- **부가 변경**: `#include <linux/blk_types.h>` 추가(타입 가시성).

### 3.6 `fs/iomap/direct-io.c` — sync Direct I/O HIPRI polling 복구

이 파일 변경이 "왜 upstream을 일부 역행하는가"의 핵심이다.

**(a) `struct iomap_dio`에 `poll_bio` 추적 필드 추가**

```c
struct { struct iov_iter *iter; struct task_struct *waiter;
+        struct bio *poll_bio;
} submit;
```

**(b) 제출 시 polled bio 추적 (mode helper 경유)**

```c
- /* Sync dio can't be polled reliably */
- if ((iocb->ki_flags & IOCB_HIPRI) && !is_sync_kiocb(iocb)) {
-     bio_set_polled(bio, iocb);
-     WRITE_ONCE(iocb->private, bio);
+ if (iocb->ki_flags & IOCB_HIPRI) {
+     if (blk_dpas_prepare_bio(bdev_get_queue(bio->bi_bdev), bio, iocb))
+         dio->submit.poll_bio = bio;
  }
```

- **핵심**: upstream은 `!is_sync_kiocb(iocb)` 조건으로 **sync DIO의 polling을 막아** 두었다. DPAS 실험(`pvsync2 + hipri + direct=1`, 즉 legacy sync DIO)을 재현하려면 이 빗장을 풀어야 한다. 그래서 sync 여부와 무관하게 HIPRI면 추적하도록 바꾸고, 모드 helper를 거치게 했다.

**(c) submit loop 이후 `iocb->private` 연결**

```c
WRITE_ONCE(iocb->private, dio->submit.poll_bio);
```

**(d) sync wait loop가 직접 `bio_poll()` 하도록 변경**

```c
- blk_io_schedule();
+ if (dio->submit.poll_bio && (dio->submit.poll_bio->bi_opf & REQ_POLLED))
+     bio_poll(dio->submit.poll_bio, NULL, 0);
+ else
+     blk_io_schedule();
```

- **왜 wait loop까지 고쳐야 하나**: polling으로 제출했으면 **polling으로 기다려야** 한다. upstream이 sync polling을 막은 진짜 이유는 "원리적 불가"가 아니라 "sync wait loop가 아무도 `bio_poll()`을 호출하지 않아 hang 위험"이었다. 그래서 제출(b)과 대기(d)를 한 세트로 같이 맞췄다.
- **`poll_bio` vs `iocb->private`**: `poll_bio`는 sync wait loop가 직접 `bio_poll()`할 때, `iocb->private`는 외부 iopoll(`iocb_bio_iopoll()`)이 bio를 찾을 때 쓴다. 목적이 달라 둘 다 유지한다.
- **기대효과**: `pvsync2 + direct=1 + hipri=1` 한 줄짜리 sync read가 다시 `bio_poll() → blk_mq_poll_bio() → nvme_poll()`까지 내려간다. VM kprobe로 hipri=0일 때 0, hipri=1일 때만 poll 경로가 도는 것을 실측 확인했다(§9, 2026-05-28 기록).

### 3.7 `block/blk-mq.h` — 새 진입점 프로토타입

```c
int blk_mq_poll_bio(struct request_queue *q, struct bio *bio, blk_qc_t cookie,
                    struct io_comp_batch *iob, unsigned int flags);
```

- 기존 `blk_mq_poll()`은 남겨두고(다른 caller 보존), bio를 받는 새 진입점을 추가 선언했다. 실제 정의는 `blk-mq.c`(§3.8).

### 3.8 `block/blk-mq.c` — DPAS 핵심 엔진 (가장 큰 변경, +559)

이 파일이 sleep 정책, PAS 학습, mode 전환의 실제 구현이 모인 곳이다. 기능 블록별로 본다.

#### 3.8.1 헤더와 forward 선언

`<linux/spinlock.h>, <linux/blk-mq.h>, <linux/log2.h>, <linux/math64.h>, <linux/hrtimer.h>`를 추가했다.
- `log2`(ilog2 bucket 계산), `math64`(`mul_u64_u64_div_u64` fixed-point), `hrtimer`(sleep), `spinlock`(dpas_lock) 때문이다.

#### 3.8.2 통계 bucket 함수 — request용/bio용 두 벌

```c
/* 기록용: 완료된 request를 어느 통계 bucket에 넣을지 (adaptive LHP 통계 콜백이 요구) */
static int blk_mq_poll_stats_bkt(const struct request *rq) {
    ddir = rq_data_dir(rq); sectors = blk_rq_stats_sectors(rq);
    if (!sectors) return -1;
    bucket = ddir + 2 * ilog2(sectors);
    if (bucket >= BLK_MQ_POLL_STATS_BKTS) return ddir + BLK_MQ_POLL_STATS_BKTS - 2;
    return bucket;
}
/* 조회용: bio로 PAS/LHP bucket 계산 */
static int blk_mq_poll_pas_bucket(const struct bio *bio) { /* 동일 공식, op/sectors는 bio에서 */ }
```

- **왜 두 벌인가**: `blk_stat_alloc_callback()`은 **request 기반** bucket 콜백을 강제한다(기록용). 반면 poll 직전 정책은 **bio**밖에 없다(조회용). 그래서 같은 공식 `ddir + 2*ilog2(sectors)`를 두 함수로 분리했다.
- **헷갈리기 쉬운 점**: 두 함수의 공식이 어긋나면 "다른 서랍을 읽는" 조용한 버그가 된다. 주석으로만 묶여 있어 정적 테스트로 묶는 것을 고려 중.
- **bucket 예시**: 4KB read → sectors=8, ddir=0 → `0 + 2*ilog2(8)=6`. 4KB write → bucket=7. read=짝수, write=홀수.

#### 3.8.3 PAS bucket 초기값 — `init_pas_stat()`

```c
stat->dur=dur; stat->adj=adj; stat->up=up; stat->dn=dn;
stat->sr_pnlt=0; stat->sr_last=1;        /* 0=over, 1=under 관례 */
stat->dur_cnt=1; stat->dur_cnt_checked=0; stat->update_req=0;
```
- `dur_cnt`는 IO 개수가 아니라 **현재 `dur`의 "세대 번호"** 다. `dur_cnt_checked`/`update_req`는 같은 세대 결과가 중복 반영되지 않게 막는 guard.

#### 3.8.4 queue 초기화/해제 — `blk_mq_init_allocated_queue()`, `blk_mq_release()`

- **`poll_cb` 할당**: `q->poll_cb = blk_stat_alloc_callback(blk_mq_poll_stats_fn, blk_mq_poll_stats_bkt, BLK_MQ_POLL_STATS_BKTS, q)`. 실패 시 `err_poll`로 가서 free + `q->poll_cb=NULL`.
- **DPAS 상태 기본값 초기화**:
  ```c
  spin_lock_init(&q->dpas_lock);
  q->switch_enabled = 0; q->dpas_mode = DPAS_MODE_PAS;
  q->dpas_cp_cnt=q->dpas_pas_cnt=q->dpas_ol_cnt=q->dpas_int_cnt=0;
  q->dpas_qd=0; q->dpas_qd_sum=0; q->dpas_tf=0;
  q->poll_nsec = BLK_MQ_POLL_CLASSIC;   /* 기본 classic */
  q->max_no_lock=100; q->poll_threshold=0; q->div=1000000;
  q->d_init=100; q->up_init=10000; q->dn_init=100000;
  q->heat_up=50000; q->cool_dn=100000; q->min_dn=10000; q->max_dn=100000; q->updn_ratio=10;
  q->switch_param1=0; param2=10; param3=10; param4=1; param5=100; param6=1000; param7=10000;
  ```
- **per-cpu `pas_stat` 할당**: `__alloc_percpu(...)` 후 모든 cpu × 모든 bucket을 `init_pas_stat(d_init, div, up_init, dn_init)`로 초기화.
- **`blk_mq_release()`**: `free_percpu(q->pas_stat); q->pas_stat=NULL;` 추가로 누수 방지.
- **기대효과**: queue 하나가 만들어질 때 DPAS 기본 모드(PAS), classic poll_nsec, per-cpu bucket이 모두 준비된다. 기본 `switch_enabled=0`이라 자동 전환은 꺼진 안전 상태로 시작한다.

#### 3.8.5 완료 시 통계 적립 — `__blk_mq_end_request_acct()`

```c
if (rq->rq_flags & RQF_STATS) {
    blk_mq_poll_stats_start(rq->q);   /* 100ms 수집 timer 장전 */
    blk_stat_add(rq, now);            /* 이번 completion latency 적립 */
}
```
- **왜**: adaptive LHP가 읽을 `q->poll_stat[bucket].mean`이 갱신되려면, 완료 시점에 latency를 적립하고 수집 timer를 켜야 한다. 이 줄이 없으면 adaptive LHP가 읽을 과거 latency가 영영 안 생긴다.

#### 3.8.6 통계 수집 on/콜백 — `blk_mq_poll_stats_start/fn()`, `blk_poll_stats_enable()`

```c
static void blk_mq_poll_stats_start(struct request_queue *q) {
    if (!q->poll_stat || blk_stat_is_active(q->poll_cb)) return;
    blk_stat_activate_msecs(q->poll_cb, 100);    /* 100ms window */
}
static void blk_mq_poll_stats_fn(struct blk_stat_callback *cb) {
    struct request_queue *q = cb->data;
    for (bucket=0; bucket<BLK_MQ_POLL_STATS_BKTS; bucket++)
        if (cb->stat[bucket].nr_samples)
            q->poll_stat[bucket] = cb->stat[bucket];  /* 게시판에 스냅샷 복사 */
}
```
- **3단 저장 구조**: `cb->cpu_stat`(락 없는 hot-path 적립) → `cb->stat`(100ms마다 합산, 여기서 mean 계산) → `q->poll_stat[bucket]`(polling 경로가 읽는 완성 스냅샷). `if (nr_samples)` 조건 덕에 이번 window에 샘플 없는 bucket은 지난 값을 유지한다.

#### 3.8.7 공통 sleep helper — `blk_mq_poll_sleep_nsec()`

```c
static bool blk_mq_poll_sleep_nsec(struct bio *bio, u64 nsecs) {
    if (!bio || !nsecs) return false;
    if (bio_flagged(bio, BIO_LHP_POLL_SLEPT)) return false;  /* 중복 sleep 차단 */
    bio_set_flag(bio, BIO_LHP_POLL_SLEPT);
    /* hrtimer_sleeper를 TASK_UNINTERRUPTIBLE로 걸고 io_schedule()로 CPU 양보 */
    ...
    return true;
}
```
- **왜 `BIO_LHP_POLL_SLEPT`**: 같은 bio가 완료 전 재-poll로 다시 들어와도 두 번 자지 않게 한다(중복 sleep = latency 폭증). PAS·LHP 공통.
- **왜 `hrtimer_setup_sleeper_on_stack`**: 7.1 API에 맞춤(5.18의 `hrtimer_init_sleeper_on_stack` 대체). `io_schedule()`로 자야 CPU가 다른 일을 할 수 있어 polling보다 CPU를 아낀다.

#### 3.8.8 LHP sleep — `blk_mq_poll_lhp_sleep()`, `blk_mq_poll_lhp_nsecs()`

```c
static void blk_mq_poll_lhp_sleep(q, bio, flags) {
    if (flags & BLK_POLL_ONESHOT) return;
    if (q->poll_nsec < 0)  return;                 /* classic: sleep 없음 */
    if (q->poll_nsec > 0)  nsecs = q->poll_nsec;   /* fixed LHP: 고정 시간 */
    else                   nsecs = blk_mq_poll_lhp_nsecs(q, bio); /* adaptive: mean/2 */
    blk_mq_poll_sleep_nsec(bio, nsecs);
}
static u64 blk_mq_poll_lhp_nsecs(q, bio) {
    if (!blk_poll_stats_enable(q)) return 0;       /* 통계 없으면 0(cold-start) */
    bucket = blk_mq_poll_pas_bucket(bio);
    if (q->poll_stat[bucket].nr_samples)
        return (q->poll_stat[bucket].mean + 1) / 2;
    return 0;
}
```
- **세 모드 분기**: `io_poll_delay=-1`→classic, `>0`→fixed LHP, `=0`→adaptive LHP. 이전에는 `poll_nsec<=0`이면 바로 return해서 `=0`이 죽은 경로였는데, `<0`만 return하도록 고쳐 `=0`(adaptive)을 살렸다.
- **왜 mean/2**: 완료 예상 시간 전부를 자면 oversleep 위험이 커서, 평균의 절반만 자고 나머지는 polling으로 확인한다. 평균 20us면 ~10us sleep 후 poll.
- **VM 실측(§9)**: cold-start에서 처음 ~1177회 sleep은 0ns였고, 통계 window가 채워진 뒤 nonzero(p50 ~26us)로 전이함을 kprobe로 확인.

#### 3.8.9 `__blk_hctx_poll()` — poll_count를 돌려주는 실제 polling 루프

```c
static int __blk_hctx_poll(q, hctx, iob, flags, unsigned int *poll_countp) {
    unsigned int poll_count = 0;
    do {
        ret = q->mq_ops->poll(hctx, iob);          /* = nvme_poll() */
        if (ret > 0) { *poll_countp = poll_count; return ret; }
        if (task_sigpending(current)) { *poll_countp = UINT_MAX; return 1; }  /* sentinel */
        if (ret < 0 || (flags & BLK_POLL_ONESHOT)) break;
        cpu_relax(); poll_count++;
    } while (!need_resched());
    *poll_countp = poll_count; return 0;
}
/* 기존 blk_hctx_poll()은 __blk_hctx_poll(...,NULL) wrapper로 보존 */
```
- **왜 분리**: 기존 `blk_hctx_poll()`은 완료만 반환했다. PAS는 "sleep 후 busy-poll을 몇 번 돌았는가"(`poll_count`)가 필요해서, 이를 선택적으로 돌려주는 `__blk_hctx_poll()`을 만들고 기존 함수는 wrapper로 남겼다.
- **`poll_count` 의미**: latency 자체가 아니라 sleep 이후 busy-poll 루프 횟수. PAS의 over/under 판정 입력.
- **`UINT_MAX` sentinel**: signal 때문에 완료 없이 1을 반환한 경우, PAS 결과로 반영하지 않도록 표시.
- **알려진 동작(2026-06-04)**: 이 커널 기본 설정이 `PREEMPT_LAZY`라 `need_resched()` 탈출 경로는 사실상 동작하지 않는다. 재-poll은 `task_sigpending()` 경로로만 유도됐다(검증 시 기억할 점).

#### 3.8.10 PAS sleep — `blk_mq_poll_pas_sleep()`

```c
/* switch_enabled이고 모드가 CP면: PAS sleep 없이 mode 전환만 검사하고 반환 (CP=busy poll) */
if (q->switch_enabled && q->dpas_mode == DPAS_MODE_CP) {
    blk_dpas_maybe_switch_mode(q); return;
}
if (!q->pas_enabled || !q->pas_stat) return;
if (flags & BLK_POLL_ONESHOT) return;
if (!bio || bio_flagged(bio, BIO_LHP_POLL_SLEPT)) return;   /* 재-poll이면 skip */
bucket = blk_mq_poll_pas_bucket(bio);
cpu = get_cpu(); stat = per_cpu_ptr(q->pas_stat, cpu);
if (q->switch_enabled) { q->dpas_qd++; q->dpas_qd_sum += q->dpas_qd; }  /* QD 회계 */
blk_mq_poll_pas_update_duration(q, &stat[bucket]);   /* 지난 결과를 dur에 반영 */
nsecs = stat[bucket].dur; dur_cnt = stat[bucket].dur_cnt;
q->last_poll_count++; put_cpu();
if (!blk_mq_poll_sleep_nsec(bio, nsecs)) goto out_qd;  /* 실제 sleep */
ctx = { active=true, cpu, bucket, dur_cnt, dur=nsecs };  /* feedback용 영수증 */
out_qd: if (q->switch_enabled && q->dpas_qd) q->dpas_qd--;
```
- **왜 get_cpu/put_cpu**: per-cpu state는 임계구간에서 snapshot만 잡고, 실제 sleep은 `put_cpu()` 이후에 한다(자는 동안 per-cpu lock을 쥐면 안 됨).
- **`ctx`(영수증)**: "CPU c, bucket b, dur_cnt 세대 g, dur=d로 잤다"를 기록해, 완료 후 피드백을 같은 슬롯/세대에만 반영하게 한다.

#### 3.8.11 PAS feedback — `blk_mq_poll_pas_complete()`

```c
if (!ctx->active || ret <= 0 || poll_count == UINT_MAX || !q->pas_stat) return;
cpu = get_cpu(); if (cpu != ctx->cpu) { put_cpu(); return; }   /* 다른 CPU면 포기 */
stat = per_cpu_ptr(q->pas_stat, ctx->cpu);
if (ctx->dur_cnt == stat[bucket].dur_cnt &&
    stat[bucket].dur_cnt != stat[bucket].dur_cnt_checked) {     /* 세대 중복 방지 */
    stat[bucket].dur_cnt_checked = stat[bucket].dur_cnt;
    stat[bucket].sr_pnlt = stat[bucket].sr_last;
    stat[bucket].sr_last = poll_count <= q->poll_threshold ? 0 : 1;  /* over/under */
    stat[bucket].update_req = 1;
}
if (q->switch_enabled) blk_dpas_maybe_switch_mode(q);
put_cpu();
```
- **판정**: `poll_count <= poll_threshold`(기본 0)면 oversleep(0), 아니면 undersleep(1). 즉 자고 일어나니 이미 완료였으면 너무 잤다(over), 깨서도 여러 번 돌았으면 덜 잤다(under).
- **여기서 dur을 바꾸지 않는다**: `update_req=1`만 남기고, 실제 갱신은 다음번 같은 bucket 진입(§3.8.12)에서 한다. 한 박자 늦춰 race를 줄이는 설계.
- **알려진 한계(2026-06-04)**: 같은 bio가 재-poll된 인스턴스는 PAS 결과 갱신이 누락된다(sleep한 호출은 sigpending/0으로 끝나고, 완료를 찾은 재-poll 호출은 ctx inactive). 재-poll이 잦은 contention에서 PAS 학습이 정체 → 이것이 mode switching의 동기와 직결.

#### 3.8.12 PAS duration 학습 + DPAS1/DPAS2 — `blk_mq_poll_pas_update_duration()`

```c
if (!stat->update_req) return;
stat->update_req = 0;
cur_case = stat->sr_pnlt * 2 + stat->sr_last;   /* 최근 두 판정의 2-bit 조합 */
switch (cur_case) {
case 0: stat->adj -= stat->dn;          break;  /* over→over : 더 줄임 */
case 1: stat->adj = q->div + stat->up;  break;  /* over→under */
case 2: stat->adj = q->div - stat->dn;  break;  /* under→over */
case 3: stat->adj += stat->up;          break;  /* under→under : 더 늘림 */
}
if (stat->adj <= 0) stat->adj = q->div;
stat->dur = mul_u64_u64_div_u64(stat->dur, (u64)stat->adj, q->div);  /* dur *= adj/div */
if (stat->dur < q->d_init) {
    stat->dur = q->d_init;                       /* 최소값 clamp */
    if (q->switch_enabled) q->dpas_tf++;         /* floor 도달 → "too fast" 카운트 */
}
stat->dur_cnt++;

if (q->pas_adaptive_enabled) {
    if (cur_case == 0 || cur_case == 3) {        /* 같은 판정 연속 → heat-up(조정폭 ↑) */
        if (==1) { stat->dn = stat->dn*(div+heat_up)/div; clamp max_dn; stat->up = stat->dn/updn_ratio; }  /* DPAS1: dn 조정 */
        else if (==2) { stat->up = stat->up*(div+heat_up)/div; clamp div/10; }                              /* DPAS2: up만 */
    } else {                                     /* 방향 전환 → cool-down(조정폭 ↓) */
        stat->up = stat->up*(div-cool_dn)/div;
        if (==1) { clamp up>=min_dn/updn_ratio; stat->dn = stat->up*updn_ratio; }
        else if (==2) { clamp up>=div/10000; }
    }
}
```
- **수식 의미**: `adj/div`가 곱셈 계수. 기본 `div=1000000`, `heat_up=50000`→`(div+heat_up)/div=1.05`(5%↑), `cool_dn=100000`→`(div-cool_dn)/div=0.9`(10%↓). 정수 fixed-point로 부동소수점 회피.
- **왜 `up < dn`(기본 up=10000, dn=100000, 비율 10)**: oversleep은 latency를 직접 낭비하므로 **빠르게 줄이고(dn 큼)**, undersleep은 CPU 낭비라 **천천히 늘린다(up 작음)**.
- **DPAS1 vs DPAS2**: DPAS1(`=1`)은 `dn`을 조정하고 `up=dn/ratio`로 동반 이동(공격적). DPAS2(`=2`)는 `up`만 조정, `dn` 고정(보수적). VM 실측(2026-06-04)에서 DPAS1은 `dn/up=10` 유지, DPAS2는 `up`만 변동하는 것을 확인.
- **`dpas_tf`(too-fast)**: 학습 `dur`이 최소값 `d_init`까지 떨어진 횟수. PAS sleep이 더는 도움 안 되는 과부하 신호로 보고, mode switching에서 PAS→OL 전이 트리거로 쓴다(§3.8.13).

#### 3.8.13 모드 전환 상태머신 — `blk_dpas_maybe_switch_mode()` (working tree)

`q->dpas_lock`을 쥔 상태에서 호출(`lockdep_assert_held`). `switch_enabled`일 때만 동작.

```c
s64 avg_qd;
switch (q->dpas_mode) {
case DPAS_MODE_CP:   /* 충분히 평가하면 PAS로 복귀 */
    if ((s64)q->dpas_cp_cnt >= q->switch_param6) { → PAS; reset pas_cnt/qd_sum/tf; }
    break;
case DPAS_MODE_PAS:
    if ((s64)q->dpas_pas_cnt < q->switch_param5) break;       /* 평가 window 미달 */
    avg_qd = (s64)q->dpas_qd_sum * 10 / q->dpas_pas_cnt;      /* 평균 QD ×10 */
    if ((s64)q->dpas_tf > q->switch_param1)        { → OL; }  /* floor 자주 → 과부하 */
    else if (q->switch_param4 > 0 && avg_qd == 10) { → CP; }  /* QD==1.0 → busy-poll 유리 */
    else { q->dpas_pas_cnt = 0; }                            /* 유지 */
    reset qd_sum, tf; break;
case DPAS_MODE_OL:
    if ((s64)q->dpas_ol_cnt < q->switch_param5) break;
    avg_qd = (s64)q->dpas_qd_sum * 10 / q->dpas_ol_cnt;
    if (avg_qd <= q->switch_param2)      { → PAS; }   /* 한가해짐 */
    else if (avg_qd > q->switch_param3)  { → INT; }   /* 더 몰림 → 인터럽트 */
    else { q->dpas_ol_cnt = 0; }
    reset qd_sum, tf; break;
case DPAS_MODE_INT:
    break;   /* INT→OL 전이는 제출 helper(blk_dpas_prepare_bio)에서 int_cnt>=param7로 */
}
```
- **왜 poll/완료 경로에서 전환**: 5.18은 제출 훅에서 전환까지 해서 책임이 뒤섞였다. 7.1은 전환 판단을 PAS sleep/완료 경로로 옮겨 제출은 "polled/INT 결정"만 하게 분리했다. 단, INT→OL만은 제출측에서(§3.4) 한다(INT는 poll 루프에 진입조차 안 하므로).
- **`s64` 캐스팅**: 카운터는 `u32`/`u64`, `switch_param`은 `int`(−1 허용)라 signed/unsigned 혼합 비교 버그를 막으려 `(s64)` 캐스팅을 적용했다(2026-06-15 이후 정리된 현재 상태).
- **기대효과**: workload의 평균 queue-depth와 floor 도달 빈도에 따라 INT↔CP↔PAS↔OL을 자동으로 오가는 정책 레이어.

#### 3.8.14 오케스트레이터 — `blk_mq_poll_bio()`

```c
int blk_mq_poll_bio(q, bio, cookie, iob, flags) {
    struct blk_mq_pas_poll_ctx pas = {};
    if (!blk_mq_can_poll(q)) return 0;
    hctx = q->queue_hw_ctx[cookie];
    if (q->pas_enabled) blk_mq_poll_pas_sleep(q, bio, flags, &pas);  /* PAS 경로 */
    else                blk_mq_poll_lhp_sleep(q, bio, flags);        /* LHP/classic 경로 */
    ret = __blk_hctx_poll(q, hctx, iob, flags, &poll_count);         /* 실제 poll */
    blk_mq_poll_pas_complete(q, &pas, ret, poll_count);              /* 피드백 */
    return ret;
}
```
- **단일 진입점**: §1.1의 모든 모드가 여기서 갈린다. `pas_enabled`로 PAS/LHP를 가르고, 공통적으로 `__blk_hctx_poll()`로 실제 NVMe poll을 한 뒤, PAS면 피드백을 남긴다.
- **`blk_mq_can_poll()`**: upstream 7.1 함수(DPAS 추가 아님). DPAS는 이걸 그대로 활용한다.

### 3.9 `block/blk-sysfs.c` — runtime 실험 인터페이스 (+340)

DPAS의 모든 파라미터를 `/sys/block/<dev>/queue/` 아래 sysfs로 노출한다. 실험자가 재빌드 없이 모드/파라미터를 바꾸기 위함이다.

**(a) `io_poll_delay` show/store 복구**

base는 `poll_delay`를 상수 `-1`만 반환하는 죽은 knob였다. 이를 되살렸다.

```c
queue_poll_delay_show:  q->poll_nsec==BLK_MQ_POLL_CLASSIC ? -1 : q->poll_nsec/1000 (us)
queue_poll_delay_store: poll 지원 queue에서, val==-1 → classic, val>=0 → poll_nsec = val*1000(ns)
```
- **핵심**: `val>=0`을 허용해 `io_poll_delay=0`(adaptive LHP)을 켤 수 있게 했다. `echo -1`=classic, `echo 10`=fixed 10us, `echo 0`=adaptive.

**(b) 타입별 store helper + 매크로**

`queue_dpas_store_int/u32/ll()`로 범위 검증(min/max) + poll 지원 확인을 공통화하고, `QUEUE_DPAS_INT_RW / U32_RW / LL_RW` 매크로로 show/store 쌍을 대량 생성했다.

**(c) PAS 파라미터 store 시 per-cpu 재초기화**

```c
queue_d_init_store:  ... → queue_dpas_reinit_pas_stats(q, q->div);
queue_up_init_store: ... → queue_dpas_reinit_pas_stats(q, q->div + q->up_init);
queue_dn_init_store: ... → queue_dpas_reinit_pas_stats(q, q->div + q->up_init);
```
- **왜**: `pas_d_init` 등은 단순 값 저장으로 부족하고, **모든 cpu의 모든 bucket을 새 초기값으로 재초기화**해야 의미가 있다. 그래서 `pas_d_init`에 쓰면 사실상 PAS 학습 상태 reset 역할도 한다(검증 시 cold-start를 만드는 knob로 활용).

**(d) `switch_enabled` show/store + 상태 reset (working tree)**

```c
queue_switch_enabled_store: 0/1 검증 후, dpas_lock 안에서
    q->switch_enabled = val; queue_dpas_reset_switch_state(q);
/* reset: dpas_mode=PAS, 모든 cp/int/pas/ol_cnt=0, qd=0, qd_sum=0, tf=0 */
```
- **왜 reset**: switching을 켜고 끌 때 모드/카운터를 깨끗한 PAS 상태에서 다시 시작해야 전환 판단이 오염되지 않는다.

**(e) 노출되는 sysfs 엔트리 등록**

`blk_mq_queue_attrs[]`에 다음을 추가: `pas_enabled, pas_adaptive_enabled, ehp_enabled, pas_max_no_lock, pas_poll_threshold, logging_enabled, pas_d_init, pas_up_init, pas_dn_init, pas_heat_up, pas_cool_dn, pas_min_dn, pas_max_dn, switch_enabled, switch_param1~7`.

- **기대효과**: README가 광고하는 Claim 1(커널 인터페이스 가용성)을 충족한다. 매크로/벤치 스크립트가 이 knob들로 모드를 세팅한다.
- **주의**: `ehp_enabled`, `max_no_lock`, `logging_enabled` 등은 knob(그릇)은 복구됐지만 EHP/로깅 본체 로직은 아직 7.1에 완전 이식되지 않았다(상태 저장만). §7 참고.

### 3.10 `tools/testing/selftests/dpas/*.py` — 정적 회귀 테스트

소스 텍스트를 정적 검사하는 4개 파이썬 테스트가 추가됐다(런타임 아님, 빌드 전 가드).

| 파일 | 추가 커밋 | 검사 목적 | 현재 상태 |
|---|---|---|---|
| `pas_sysfs_static.py` | `0820286b7` | PAS/switch sysfs knob 노출 정책 검사 | **현재 FAIL** — 옛 정책(`switch_enabled`는 backing logic 전까지 금지)을 검사하는데, 지금은 backing logic이 생겨 충돌 |
| `no_q_dpas_static.py` | `953fbd097` | `q->dpas` split-state skeleton 사용 금지 가드 | **현재 FAIL** — 현재 설계가 `request_queue` 직접 필드 방식이라 정책 갱신 필요 |
| `pas_queue_lifecycle_static.py` | `953fbd097` | queue 생성/해제 시 PAS 자원 정리 검사 | PASS |
| `request_queue_pas_stat_static.py` | `953fbd097` | `request_queue`의 `pas_stat` 구조 검사 | PASS |

- **의미**: 두 테스트의 FAIL은 코드 결함이 아니라 **설계가 테스트보다 앞서 나간** 상태다(2026-06-14/15 기록). full DPAS 직접필드 설계 확정 후 두 테스트 정책을 갱신해야 한다.

---

## 4. 전체 커널 path (이론적 구성)

HIPRI sync Direct I/O read 하나가 제출부터 완료·학습까지 거치는 전체 경로다. (raw blockdev async는 `fops.c` 진입만 다르고 이후 동일.)

### 4.1 단계별 흐름도

```
[사용자] preadv2(..., RWF_HIPRI) 또는 fio --hipri=1  (pvsync2 + direct=1)
   │  → kiocb->ki_flags |= IOCB_HIPRI
   ▼
[제출] 파일시스템 DIO: fs/iomap/direct-io.c : iomap_dio_submit_bio()
   │      if (IOCB_HIPRI) { if (blk_dpas_prepare_bio(q, bio, iocb)) dio->submit.poll_bio = bio; }
   │   raw blockdev:      block/fops.c : __blkdev_direct_IO_async()
   │      if (IOCB_HIPRI && blk_dpas_prepare_bio(q,bio,iocb)) { submit_bio(bio); iocb->private=bio; }
   │
   │   blk_dpas_prepare_bio() ── switch_enabled=0 → 무조건 bio_set_polled (REQ_POLLED on)
   │                          └─ switch_enabled=1 → dpas_mode 보고:
   │                               INT → IOCB_HIPRI/REQ_POLLED clear (인터럽트 완료로 감), return false
   │                               CP/PAS/OL → REQ_POLLED on + 모드 카운터++
   ▼
[변환] blk-mq가 bio → request 변환/시작
   │   block/blk-mq.c : blk_mq_start_request()   ← ※ UPSTREAM 7.1 코드(DPAS 추가 아님)
   │      if (rq->bio && REQ_POLLED) WRITE_ONCE(rq->bio->bi_cookie, rq->mq_hctx->queue_num);
   │   → bio->bi_cookie = "poll할 hctx 번호" (request tag가 아님)
   ▼
[대기] sync DIO wait loop: fs/iomap/direct-io.c : __iomap_dio_rw()
   │      for (;;) { if (!waiter) break;
   │                 if (poll_bio && (poll_bio->bi_opf & REQ_POLLED)) bio_poll(poll_bio,NULL,0);
   │                 else blk_io_schedule(); }
   ▼
[진입] block/blk-core.c : bio_poll()
   │      q = bdev_get_queue(bio->bi_bdev);  cookie = bio->bi_cookie;
   │      if (queue_is_mq(q)) ret = blk_mq_poll_bio(q, bio, cookie, iob, flags);   ← DPAS 전환점
   ▼
[정책] block/blk-mq.c : blk_mq_poll_bio()
   │      hctx = q->queue_hw_ctx[cookie];
   │      ┌── pas_enabled=1 → blk_mq_poll_pas_sleep()  ── bucket=ddir+2*ilog2(sectors)
   │      │                                              ├ (switch_enabled & CP) → 전환검사만 후 return
   │      │                                              ├ update_duration(지난 결과를 dur에 반영)
   │      │                                              ├ QD 회계(dpas_qd/qd_sum)
   │      │                                              └ blk_mq_poll_sleep_nsec(bio, dur)  ← hrtimer sleep
   │      └── pas_enabled=0 → blk_mq_poll_lhp_sleep()  ── poll_nsec<0: sleep 없음(CP)
   │                                                     ── poll_nsec>0: 고정 sleep(fixed LHP)
   │                                                     ── poll_nsec=0: poll_stat[bucket].mean/2(adaptive LHP)
   │      (sleep은 BIO_LHP_POLL_SLEPT flag로 bio당 1회만)
   ▼
[poll] block/blk-mq.c : __blk_hctx_poll()
   │      do { ret = q->mq_ops->poll(hctx, iob);  ← = drivers/nvme/host/pci.c : nvme_poll()
   │           if (ret>0) return ret;  if (sigpending) return UINT_MAX sentinel;
   │           cpu_relax(); poll_count++; } while (!need_resched());
   ▼
[완료] NVMe completion 발견 → ret>0, poll_count 확정
   ▼
[피드백] block/blk-mq.c : blk_mq_poll_pas_complete()  (PAS only)
   │      poll_count<=poll_threshold ? over(0) : under(1)  → sr_pnlt/sr_last 갱신, update_req=1
   │      if (switch_enabled) blk_dpas_maybe_switch_mode()   ← 모드 전환 판단
   ▼
[학습 반영] 다음번 같은 bucket 진입 시 update_duration()이 cur_case로 dur 조정 (+ DPAS1/2 up/dn)

[병렬-통계] 모든 RQF_STATS 완료마다: __blk_mq_end_request_acct()
   │      blk_mq_poll_stats_start(q)(100ms timer) + blk_stat_add(rq,now)
   │      → timer 만료 시 blk_mq_poll_stats_fn()이 q->poll_stat[bucket]에 mean 스냅샷
   │      → adaptive LHP가 이 값을 읽어 mean/2 sleep
```

### 4.2 path를 떠받치는 핵심 데이터 흐름

- **`bio`** = "무슨 I/O인가"의 정보 묶음: `bio_op`(read/write), `bio_sectors`(크기) → bucket 결정. `REQ_POLLED` flag → poll 대상 여부. `BIO_LHP_POLL_SLEPT` → 중복 sleep 방지. `bi_cookie` → hctx 번호. `bi_bdev` → `request_queue` 복원.
- **`request`** = hctx 배정·실제 장치 제출 단위. polled bio의 cookie에 `mq_hctx->queue_num`을 써준다(upstream).
- **`request_queue`** = DPAS 정책/상태/sysfs knob 저장소(`pas_enabled`, `poll_nsec`, `dpas_mode`, `pas_stat`, `poll_stat` …).
- **`hctx`** = 실제 `mq_ops->poll`(=`nvme_poll`) 대상.

핵심 통찰: **bio 전체가 드라이버까지 새 인자로 내려가는 게 아니다.** 실제 장치 polling은 여전히 hctx 기반이다. 다만 7.1의 `bio_poll()` 경로에서 `bio`를 `blk_mq_poll_bio()`까지 **보존**해서, poll 직전 정책이 bio의 방향/크기/flag/cookie를 볼 수 있게 만든 것이 이 포팅의 골자다. NVMe 드라이버 코드는 한 줄도 바뀌지 않았다.

---

## 5. 모드별 동작과 sysfs knob 매핑

### 5.1 모드를 만드는 knob 조합

| 모드 | `pas_enabled` | `io_poll_delay` | `pas_adaptive_enabled` | poll 경로에서 일어나는 일 |
|---|:---:|:---:|:---:|---|
| INT | 0 | (무관) | 0 | HIPRI 없이/REQ_POLLED clear → 인터럽트 완료(또는 switch_enabled에서 제출측 강제) |
| CP | 0 | -1 | 0 | sleep 없이 busy-spin polling |
| fixed LHP | 0 | >0 (us) | 0 | 고정 시간 sleep 후 poll |
| adaptive LHP | 0 | 0 | 0 | `poll_stat[bucket].mean/2` sleep 후 poll |
| PAS | 1 | (무관) | 0 | bucket 학습 `dur` sleep, up/dn 고정 |
| DPAS1 | 1 | (무관) | 1 | PAS + `dn` 적응 조정(`up=dn/ratio`) |
| DPAS2 | 1 | (무관) | 2 | PAS + `up`만 적응 조정(`dn` 고정) |
| OL/자동전환 | — | — | — | `switch_enabled=1` 시 `dpas_mode`가 런타임에 INT↔CP↔PAS↔OL 자동 이동 |

> 벤치 스크립트 실측 knob(2026-06-06 host smoke): INT=`io_poll_delay=-1,pas_enabled=0`; CP=`io_poll_delay=-1,pas_enabled=0,io_poll=1`; LHP=`io_poll_delay=0,pas_enabled=0`; PAS=`io_poll_delay=0,pas_enabled=1,pas_adaptive_enabled=1`.

### 5.2 전체 sysfs knob 레퍼런스 (`/sys/block/<dev>/queue/`)

| knob | request_queue 필드 | 기본값 | 허용 범위 | 의미 |
|---|---|---:|---|---|
| `io_poll_delay` | `poll_nsec` | -1 | -1 / 0 / >0 (us) | classic / adaptive LHP / fixed LHP |
| `pas_enabled` | `pas_enabled` | 0 | 0~1 | PAS on/off |
| `pas_adaptive_enabled` | `pas_adaptive_enabled` | 0 | 0~2 | 0=off,1=DPAS1,2=DPAS2 |
| `ehp_enabled` | `ehp_enabled` | 0 | 0~1 | EHP knob(상태만) |
| `pas_max_no_lock` | `max_no_lock` | 100 | 1~INT_MAX | 5.18 호환 knob |
| `pas_poll_threshold` | `poll_threshold` | 0 | 0~INT_MAX | over/under 판정 임계 poll_count |
| `logging_enabled` | `logging_enabled` | 0 | 0~2 | 디버그 로깅 knob |
| `pas_d_init` | `d_init` | 100 | 100~99000 | 초기/최소 sleep duration(쓰면 bucket 재초기화) |
| `pas_up_init` | `up_init` | 10000 | 100~99000 | up 초기값(쓰면 재초기화) |
| `pas_dn_init` | `dn_init` | 100000 | 10000~990000 | dn 초기값(쓰면 재초기화) |
| `pas_heat_up` | `heat_up` | 50000 | 0~INT_MAX | 조정폭 확대 계수(=1.05x) |
| `pas_cool_dn` | `cool_dn` | 100000 | 0~999999 | 조정폭 축소 계수(=0.9x) |
| `pas_min_dn` | `min_dn` | 10000 | 10000~990000 | DPAS1 dn 하한 |
| `pas_max_dn` | `max_dn` | 100000 | 10000~990000 | DPAS1 dn 상한 |
| `switch_enabled` | `switch_enabled` | 0 | 0~1 | 자동 mode switching on/off(쓰면 상태 reset) |
| `switch_param1` | `switch_param1` | 0 | -1~INT_MAX | PAS→OL: `dpas_tf` 임계값 |
| `switch_param2` | `switch_param2` | 10 | -1~INT_MAX | OL→PAS: 평균 QD(×10) 임계값 |
| `switch_param3` | `switch_param3` | 10 | -1~INT_MAX | OL→INT: 평균 QD(×10) 임계값 |
| `switch_param4` | `switch_param4` | 1 | -1~INT_MAX | PAS→CP 전환 허용 여부(>0) |
| `switch_param5` | `switch_param5` | 100 | -1~INT_MAX | PAS/OL 평가 I/O 개수(window) |
| `switch_param6` | `switch_param6` | 1000 | -1~INT_MAX | CP 평가 I/O 개수 |
| `switch_param7` | `switch_param7` | 10000 | -1~INT_MAX | INT 평가 I/O 개수 |
| (내부 div) | `div` | 1000000 | — | fixed-point 분모 |
| (내부 ratio) | `updn_ratio` | 10 | — | DPAS1 `dn = up * ratio` |

---

## 6. 모드 전환(switch_param) 의미 정리

`switch_enabled=1`일 때만 동작. 평균 QD는 `qd_sum*10/cnt`로 ×10 정수 표현(즉 `10`==평균 QD 1.0).

```
            (제출측: int_cnt >= param7)
   INT ───────────────────────────────────► OL
    ▲                                         │
    │ (OL: avg_qd > param3)                   │ (OL: avg_qd <= param2)
    │                                         ▼
   OL ◄──── (PAS: dpas_tf > param1) ──── PAS ◄┘
    │                                    │  ▲
    │                                    │  │ (CP: cp_cnt >= param6)
    └────────────────────────────────►  ▼  │
        (PAS: param4>0 & avg_qd==10) →  CP ─┘
```

- **INT→OL**: INT는 poll 루프에 안 들어가므로, 제출 helper(`blk_dpas_prepare_bio`)에서 `dpas_int_cnt >= switch_param7`이면 OL로.
- **CP→PAS**: CP 모드로 `switch_param6`개 평가 후 PAS로 복귀(busy-poll을 무한정 유지하지 않음).
- **PAS→OL**: PAS 학습 `dur`이 최소값(floor)에 도달한 횟수 `dpas_tf`가 `switch_param1`(기본 0) 초과 → 과부하로 보고 OL.
- **PAS→CP**: 평가 window(`param5`) 동안 평균 QD가 정확히 1.0(`avg_qd==10`)이고 `param4>0`이면 → 단일 in-flight라 busy-poll이 유리 → CP.
- **OL→PAS**: 평균 QD ≤ `param2` → 한가해짐 → PAS 복귀.
- **OL→INT**: 평균 QD > `param3` → 더 몰림 → 인터럽트가 유리 → INT.

---

## 7. upstream(7.1)과 DPAS 수정의 경계 (오해 방지)

검증 중 "DPAS가 추가했다"고 착각하기 쉬운, 그러나 **사실은 upstream 7.1 코드**인 것들:

- **`blk_mq_start_request()`의 `bio->bi_cookie = rq->mq_hctx->queue_num` 기록** — base `8fac1449a`의 `block/blk-mq.c:1392`에 이미 존재. DPAS는 이걸 **활용**할 뿐 수정하지 않았다. (이 보고서의 path에서 cookie 복원이 가능한 이유.)
- **`blk_mq_can_poll()`** — upstream 7.1 함수. `blk_mq_poll_bio()`가 호출만 한다.
- **`bio_set_polled()` / `bio_clear_polled()` / `REQ_POLLED`** — upstream bio polling 인프라.

반대로 **DPAS가 명시적으로 바꾼/되살린 것**:

- base `fops.c`는 `if (iocb->ki_flags & IOCB_HIPRI) { bio->bi_opf |= REQ_POLLED; }`로 무조건 polled 제출 → DPAS가 `blk_dpas_prepare_bio()` 경유로 교체.
- base `iomap/direct-io.c`는 `!is_sync_kiocb(iocb)` 조건으로 sync polling 차단 → DPAS가 제거하고 sync wait loop에서 직접 `bio_poll()` 하도록 복구.
- base `blk-sysfs.c`의 `io_poll_delay`는 상수 -1 더미 → DPAS가 실제 store/show 복구.
- upstream이 삭제한 hybrid polling 통계(`poll_cb`/`poll_stat`/`blk_stats_alloc_enable`)를 부분 복원.

> 이 경계를 분명히 해야 "이 줄이 DPAS 수정이다"라는 잘못된 귀속을 피할 수 있다.

---

## 8. PAS 학습을 숫자로 따라가기 (직관 예시)

가정: 4KB read(bucket 6), `pas_enabled=1`, `poll_threshold=0`, CPU 2, `div=1000000`.
초기 `stat[CPU2][6]`: `dur=30000, adj=1000000, up=10000, dn=100000, sr_pnlt=1, sr_last=1, dur_cnt=42, dur_cnt_checked=41, update_req=0`.

1. `blk_mq_poll_pas_sleep()`: `nsecs = dur = 30000`, `BIO_LHP_POLL_SLEPT` 세팅, 30us sleep. 영수증 `ctx={cpu=2,bucket=6,dur_cnt=42,dur=30000}`.
2. `__blk_hctx_poll()`: 자고 일어나 첫 poll에서 즉시 완료 → `ret=1, poll_count=0`.
3. `blk_mq_poll_pas_complete()`: `poll_count(0) <= threshold(0)` → oversleep. `sr_pnlt=이전 sr_last(1)`, `sr_last=0`, `dur_cnt_checked=42`, `update_req=1`.
4. 다음번 같은 bucket 진입 → `update_duration()`: `cur_case = 1*2+0 = 2`(under→over) → `adj = div - dn = 900000` → `dur = 30000 * 900000/1000000 = 27000`. `dur_cnt=43`. **sleep을 줄였다.**

반대로 undersleep이 연속(case 3)이면 `adj += up` → `dur`이 1.x%씩 커진다. 즉 PAS는 device latency 부근으로 `dur`을 수렴시킨다. (2026-06-04 VM kprobe: cold-start `dur=100`에서 시작해 ~30us 부근으로 수렴 후 진동, `dur_cnt` u8 wrap을 넘어서도 guard 정상 동작 확인.)

---

## 9. 검증 내역 (3회 이상 교차검증)

이 보고서의 사실관계는 서로 다른 소스로 최소 3중 교차검증했다.

**검증 1 — git diff 전수 (base `8fac1449a` → working tree)**
- 14개 파일(소스 10 + 테스트 4)의 전체 diff를 직접 확보·판독. diffstat 합계 `+1395 −17` 일치.
- 커밋별 stat과 누적 diff가 일관됨을 확인.

**검증 2 — `history/*.md` 전수 판독과 대조**
- README, `DPAS-학습-노트.md`, 일일 기록(05-27~06-15), 전용 보고서(mode-switch-submit-path-mapping, bio-request-poll-flow-report 등)를 읽고 코드와 대조.
- 설계 결정(모듈식→직접필드, 제출경로→poll경로 단일화, sync DIO 복구 이유)이 코드와 모순 없음을 확인.

**검증 3 — 현재 파일 실제 상태 확인**
- `enum dpas_mode`가 `struct request_queue` **밖** 489행, 필드는 526행 → 06-15 빌드 수정 반영 확인.
- `git diff --check`(base 대비) **clean**(공백 오류 없음). `blk_dpas_*` 함수는 4-space 들여쓰기(cosmetic 이슈, §10).
- `blk_dpas_maybe_switch_mode()`에 `(s64)` 캐스팅 적용됨 → 06-15 노트가 지적한 signed/unsigned 비교가 현재 정리된 상태.

**검증 4 — upstream/DPAS 출처 구분 (오귀속 방지)**
- `blk_mq_start_request()` cookie 기록과 `blk_mq_can_poll()`이 base에 이미 존재 → upstream임을 확인(§7).
- base `fops.c`/`iomap`/`blk-sysfs.c`의 원형을 확인해 DPAS가 무엇을 교체했는지 특정.

**런타임 검증(기록 기반, VM/host)** — 이 작업 세션에서 직접 실행하진 않았고 history에 기록된 결과를 인용:
- VM kprobe로 `hipri=1`일 때만 `bio_poll→blk_mq_poll_bio→__blk_hctx_poll→nvme_poll` 경로 진입, `hipri=0`은 0회(2026-05-28).
- fixed/adaptive LHP·PAS sleep 진입과 `BIO_LHP_POLL_SLEPT` 중복 차단 실측(2026-06-04/05/06). adaptive LHP cold-start sleep 0→mean/2 전이 확인.
- DPAS1/DPAS2 up/dn 분기 차이 실측(2026-06-04).

> 한계: 본 세션은 정적/소스/git 레벨 검증과 history 대조까지 수행했다. 커널 빌드·부팅·fio 실측은 직접 재실행하지 않았으며, 위 런타임 수치는 history 기록의 인용이다.

---

## 10. 확인된 성능 경향 (참고)

host Optane, `jobs=1`, 4KiB random read, ext4 file direct I/O, repeats=5 (2026-06-06 기록):

| 모드 | IOPS(평균) | CP 대비 IOPS | CPU total | 비고 |
|---|---:|---:|---:|---|
| CP | 97,940 | 100.0% | ~100% | 최고 IOPS/최저 latency, CPU 포화 |
| PAS | 88,370 | 90.2% | 68.5% | CP의 90% IOPS를 CPU 68%로 |
| LHP | 75,357 | 76.9% | 56.8% | CPU는 PAS보다 낮지만 IOPS도 낮음 |
| INT | 70,297 | 71.8% | 35.7% | CPU 최저, IOPS/latency 최약 |

- 순위: IOPS·latency·CPU 모두 **CP > PAS > LHP > INT**. PAS가 "CP에 가까운 성능 + 상당한 CPU 절감"이라는 DPAS의 목표를 정량적으로 보여준다.
- 주의: 단일 job·고정 모드 순서·QEMU/host 환경 차이가 섞인 경향 확인용 수치다. 논문급 통계로 쓰려면 multi-job sweep, 순서 randomize, CPU governor/IRQ affinity 통제가 더 필요하다(2026-06-11~13 기록).

---

## 11. 현재 상태와 남은 리스크

### 11.1 안정적으로 동작이 확인된 부분 (커밋됨, HEAD=`633cc0742`)
- sync DIO HIPRI 복구, `blk_mq_poll_bio()` 단일 진입점.
- fixed/adaptive LHP, adaptive PAS(DPAS1/DPAS2), `BIO_LHP_POLL_SLEPT` 중복 sleep guard.
- 전 sysfs knob 노출, blk-stat 통계 인프라 복원.

### 11.2 미완성/미커밋 단계 (working tree)
- **full mode switching**(`blk_dpas_prepare_bio` + `blk_dpas_maybe_switch_mode` + `switch_enabled`)은 아직 커밋 전이며, 다음 정리가 필요:
  - `blk_dpas_*` 함수의 **4-space 들여쓰기 → 커널 탭 스타일** 정리(현재 `git diff --check`는 통과하나 checkpatch 스타일 미정리).
  - `pas_sysfs_static.py`, `no_q_dpas_static.py` 두 정적 테스트가 새 설계와 충돌해 **FAIL** → 정책 갱신 필요(§3.10).
  - 기본 커널 빌드(`-Werror`) 통과 여부 최종 확인 필요(06-15 enum 위치 수정 후 재검증 권장).

### 11.3 알려진 동작상 한계 (검증 시 기억할 것)
- **재-poll 시 PAS 학습 정체**: 같은 bio가 재-poll되면 PAS 결과 갱신이 누락된다(`ctx` inactive/sigpending). contention에서 hybrid polling이 약하다는 관찰과 연결되며, 이는 mode switching의 존재 이유다.
- **`PREEMPT_LAZY` 환경**: `__blk_hctx_poll()`의 `need_resched()` 탈출 경로가 사실상 비활성. 재-poll은 signal 경로로만 유도됨.
- **EHP/OL/logging 본체 미이식**: knob(`ehp_enabled`, `logging_enabled`, `max_no_lock`)과 OL 모드 enum은 있으나, 5.18식 EHP bucket 판정·로깅 로직 전체는 아직 이식되지 않았다(상태 그릇만 존재).
- **bucket 함수 이중성**: `blk_mq_poll_stats_bkt(rq)`(기록용)와 `blk_mq_poll_pas_bucket(bio)`(조회용)의 공식이 어긋나면 조용한 버그. 정적 테스트로 묶는 것을 고려 중.
- **cold-start**: adaptive LHP/PAS는 첫 통계 window(~100ms) 동안 sleep 0(classic처럼 동작) → 첫 측정 구간 해석 주의.

---

## 12. 핵심 코드 위치 지도

| 목적 | 파일 : 함수 |
|---|---|
| filesystem DIO HIPRI 제출 + 모드 helper | `fs/iomap/direct-io.c : iomap_dio_submit_bio()` |
| sync DIO wait loop(직접 bio_poll) | `fs/iomap/direct-io.c : __iomap_dio_rw()` |
| raw blockdev async HIPRI 제출 | `block/fops.c : __blkdev_direct_IO_async()` |
| 제출측 모드 결정(REQ_POLLED set/clear) | `block/blk-core.c : blk_dpas_prepare_bio()` |
| bio polling 진입 | `block/blk-core.c : bio_poll()` |
| queue 자원 정리 | `block/blk-core.c : blk_free_queue()` |
| bio→request cookie 기록 *(upstream)* | `block/blk-mq.c : blk_mq_start_request()` |
| poll 단일 진입점/PAS·LHP 분기 | `block/blk-mq.c : blk_mq_poll_bio()` |
| 실제 poll 루프(poll_count) | `block/blk-mq.c : __blk_hctx_poll()` |
| 공통 sleep(중복 guard) | `block/blk-mq.c : blk_mq_poll_sleep_nsec()` |
| PAS sleep / 피드백 / 학습 | `block/blk-mq.c : blk_mq_poll_pas_sleep/complete/update_duration()` |
| PAS·LHP bucket 계산 | `block/blk-mq.c : blk_mq_poll_pas_bucket()` / `blk_mq_poll_stats_bkt()` |
| LHP sleep / adaptive 계산 | `block/blk-mq.c : blk_mq_poll_lhp_sleep/lhp_nsecs()` |
| 통계 수집 on/콜백 | `block/blk-mq.c : blk_mq_poll_stats_start/fn()` |
| 모드 전환 상태머신 | `block/blk-mq.c : blk_dpas_maybe_switch_mode()` |
| 통계 배열 1회 할당 | `block/blk-stat.c : blk_stats_alloc_enable()` |
| DPAS 상태/필드/enum | `include/linux/blkdev.h` |
| bio flag / PAS stat 구조체 | `include/linux/blk_types.h` |
| sysfs knob 전부 | `block/blk-sysfs.c` |
| 실제 NVMe poll *(미수정)* | `drivers/nvme/host/pci.c : nvme_poll()` |

---

## 13. 결론

DPAS 7.1 포팅은 "5.18 논문의 아이디어는 유지하되 구현은 정리한다"는 일관된 원칙으로 진행됐다. 그 결과:

1. **상태는 `request_queue`로 집약**되어 경로별 분산·누락 위험이 줄었고,
2. **정책은 `blk_mq_poll_bio()` 한 곳으로 단일화**되어 sleep/학습/전환이 한 흐름에서 관리되며,
3. **upstream이 막은 sync DIO HIPRI와 삭제한 통계 인프라를 연구 재현 목적으로 복구**했다.

기능적으로 INT/CP/fixed·adaptive LHP/PAS/DPAS1/DPAS2까지 커밋되어 동작이 확인됐고, full mode switching(INT↔CP↔PAS↔OL 자동 전환)이 working tree에 미커밋 상태로 들어와 마지막 정리(스타일·정적 테스트 정책·빌드 재확인)를 남겨두고 있다. 성능 경향(CP>PAS>LHP>INT, PAS가 CP의 ~90% IOPS를 ~68% CPU로)은 DPAS의 핵심 가설을 정량적으로 뒷받침한다.
