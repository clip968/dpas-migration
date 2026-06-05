# 재-poll guard 테스트 실패 원인 보고서

> 작성일: 2026-06-06
> 주제: `BIO_LHP_POLL_SLEPT` / PAS guard 재검증 테스트가 06-05에 실패한 이유와, 06-04에 성공한 이유를 코드와 함께 직관적으로 정리
> 대상 커널: `7.1.0-rc4-dpas-vm-g4be3fefb1311` (`dpas-kernel/`)

---

## 0. TL;DR (한 줄 요약)

```
guard(안전장치)는 멀쩡했다.
06-05에는 "polling 도는 worker 프로세스"가 아니라 엉뚱한 프로세스에 signal을 보내서,
테스트할 상황(재-poll) 자체가 만들어지지 않았을 뿐이다.
```

- **검증하려던 것**: "같은 bio가 polling 경로에 두 번 들어올 때(재-poll), guard가 두 번째 sleep을 막는가?"
- **재-poll을 만드는 유일한 방아쇠**: polling 도는 worker에게 signal을 날려 poll 루프를 I/O 완료 전에 탈출시키는 것
- **06-05 실패**: signal이 worker에 안 닿음 → 재-poll 0회 → guard를 시험할 sample이 없었음
- **06-04 성공**: `pkill -x fio`로 worker까지 signal을 박음 → 재-poll 1346회 발생 → 그 1346회에서 sleep 0회 = guard 정상 작동 실측

---

## 1. 무엇을 테스트하려고 했나 (배경)

DPAS의 LHP/PAS polling 경로에는 **"같은 I/O 요청(bio)에 대해 sleep은 딱 한 번만"** 이라는 안전장치가 있다.
이 안전장치를 통과하지 못하면 I/O 하나 처리하는 데 sleep이 수십~수천 번 누적되어 latency가 폭발한다.

```
            ┌─────────────────────────────────────────────┐
            │  검증 목표                                    │
            │                                              │
            │  같은 bio가 polling 경로에 두 번 이상         │
            │  들어와도(재-poll), 두 번째부터는 sleep을      │
            │  건너뛰는가?  ← 이걸 guard라 부른다           │
            └─────────────────────────────────────────────┘
```

- adaptive LHP 경로의 guard: `BIO_LHP_POLL_SLEPT` 플래그
- PAS 경로의 guard: 같은 개념의 PAS guard

문제는, **재-poll 상황을 인위적으로 만들지 않으면 guard가 일할 기회 자체가 없다**는 점이다.
그래서 "재-poll을 어떻게 유도하느냐"가 테스트의 전부다.

---

## 2. 먼저 알아야 할 것: fio는 프로세스가 하나가 아니다

```
   fio 실행
      │
      ├──► [frontend 프로세스]   job을 fork하고 waitpid()로 기다리기만 함
      │                          ★ I/O를 직접 하지 않음
      │
      └──► [worker 프로세스]      실제로 read() syscall에 들어가서
                                 커널 안 polling 루프를 도는 프로세스
                                 ★ guard 코드는 이 worker가 있을 때만 실행됨
                                   (trace의 fio-2922가 바로 이 worker)
```

**핵심**: guard가 동작하는 커널 코드(`blk_mq_poll_bio`, `blk_mq_poll_sleep_nsec`)는
**worker가 syscall로 들어와 있을 때만** 실행된다. frontend는 이 코드 근처에도 오지 않는다.

→ 그래서 signal은 **반드시 worker에 닿아야** 의미가 있다. 이게 06-04와 06-05를 가른 지점이다.

---

## 3. 핵심 구조: 루프가 두 겹이다

재-poll이 왜 생기는지 이해하려면 **중첩된 두 루프**를 봐야 한다.

```
┌──────────────────────────────────────────────────────────────────┐
│ 바깥 루프 (iomap)          fs/iomap/direct-io.c:882~891            │
│                                                                    │
│   for (;;) {                                                       │
│       if (!dio->submit.waiter)   ← I/O 끝났으면 탈출               │
│           break;                                                   │
│       bio_poll(dio->submit.poll_bio, ...);  ← 같은 bio 반복 호출   │
│   }                                                                │
│                          │                                         │
│                          ▼                                         │
│   ┌────────────────────────────────────────────────────────────┐ │
│   │ 안쪽 루프 (__blk_hctx_poll)   block/blk-mq.c:5388~          │ │
│   │                                                              │ │
│   │   do {                                                       │ │
│   │       ret = q->mq_ops->poll(hctx, iob);  ← nvme_poll() 1회   │ │
│   │       if (ret > 0) return ret;           ← I/O 완료 → 정상   │ │
│   │       if (task_sigpending(current))                          │ │
│   │           return 1;                      ← signal이면 탈출!  │ │
│   │       ...                                                    │ │
│   │   } while (!need_resched());                                 │ │
│   └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**바깥 루프의 결정적 성질**: `bio_poll()`의 **리턴값을 보지 않는다.**
오직 `dio->submit.waiter`(= I/O 완료 여부)만 보고, 매번 **똑같은 `dio->submit.poll_bio`** 를 넘긴다.

`fs/iomap/direct-io.c:882`

```c
for (;;) {
    set_current_state(TASK_UNINTERRUPTIBLE);
    if (!READ_ONCE(dio->submit.waiter))   // I/O 완료 시 waiter=NULL → break
        break;

    if (dio->submit.poll_bio &&
        (dio->submit.poll_bio->bi_opf & REQ_POLLED))
        bio_poll(dio->submit.poll_bio, NULL, 0);   // ★ 같은 bio 반복
    else
        blk_io_schedule();
}
```

---

## 4. 호출 체인

```
  read() syscall
     │
     ▼
  iomap for(;;) 루프 ─────────────────────────────────► fs/iomap/direct-io.c:882
     │
     ▼
  bio_poll(bio) ──────────────────────────────────────► block/blk-core.c:948
     │   (내부에서 blk_mq_poll_bio 호출: blk-core.c:977)
     ▼
  blk_mq_poll_bio(q, bio, ...) ───────────────────────► block/blk-mq.c:5702
     │
     ├──► blk_mq_poll_lhp_sleep(q, bio, flags)  ← ① sleep 시도 (guard 여기)
     │        └─► blk_mq_poll_sleep_nsec(bio, nsecs) ─► block/blk-mq.c:5432
     │
     └──► __blk_hctx_poll(q, hctx, ...)         ← ② 실제 polling
              └─► nvme_poll 반복 / sigpending 검사 ──► block/blk-mq.c:5388
```

`block/blk-mq.c:5702` — 진입할 때마다 **무조건 sleep 먼저, 그 다음 polling**:

```c
int blk_mq_poll_bio(struct request_queue *q, struct bio *bio, blk_qc_t cookie,
                    struct io_comp_batch *iob, unsigned int flags)
{
    ...
    if (q->pas_enabled)
        blk_mq_poll_pas_sleep(q, bio, flags, &pas);
    else
        blk_mq_poll_lhp_sleep(q, bio, flags);   // ① sleep 시도

    ret = __blk_hctx_poll(q, hctx, iob, flags, &poll_count);   // ② polling
    blk_mq_poll_pas_complete(q, &pas, ret, poll_count);
    return ret;
}
```

---

## 5. 재-poll은 어떻게 생기나 (정상 vs signal)

### 5-1. 정상 (signal 없음) → 재-poll 안 생김

```
 iomap ── bio_poll(bio) 1회 호출
            │
            ├─ sleep 1회 (bio에 도장 BIO_LHP_POLL_SLEPT 찍음)
            │
            └─ __blk_hctx_poll: nvme_poll()를 I/O 끝날 때까지 계속 돌림
                    (cpus_allowed=1이라 경쟁자 없음 → need_resched 안 뜸)
                    → ret > 0 (완료)로 정상 리턴
            │
            ▼
       iomap: waiter == NULL → for(;;) break.  끝.

 결과: bio_poll() 딱 1회 → 같은 bio 재진입 없음 → 재-poll 0회
```

이게 06-05에 관측된 "정상 종료" 상황이다.

### 5-2. worker에 signal이 걸렸을 때 → 재-poll 발생

```
 ① iomap ── bio_poll(bio) ── sleep 1회(도장 찍음) ── __blk_hctx_poll 진입
                                                          │
                                                          ▼
 ② nvme_poll() 1회 → I/O 아직 미완료(ret==0)
    → task_sigpending(current) == true   🚩
    → return 1   ★ I/O 안 끝났는데 polling 중단하고 나감
                                                          │
                                                          ▼
 ③ bio_poll 리턴 → iomap은 리턴값 무시, waiter 여전히 set
    → bio_poll(같은 bio) 다시 호출  =====> 재-poll !!!
                                                          │
                                                          ▼
 ④ 두 번째 진입: bio에 이미 도장 있음 → sleep 건너뜀 (guard 작동)
    nvme_poll() 1회 → 또 미완료 → 또 sigpending → 또 return 1 → 또 재-poll ...
                                                          │
                                                          ▼
 ⑤ 언젠가 nvme_poll()이 ret>0(완료) → 정상 경로 → waiter=NULL → 루프 종료
```

**중요한 질문: 왜 signal이 안 풀려서 ②~④가 반복되나?**

→ signal 처리(delivery)는 **syscall이 userspace로 복귀하는 순간에만** 일어난다.
지금은 `read()` syscall 안의 iomap 루프에서 맴도는 중이라 **userspace로 못 올라간다.**
그래서 `TIF_SIGPENDING` 깃발이 안 꺼지고, 매 재진입마다 `task_sigpending()`이 계속 true다.

```
   userspace (위)   │  ← signal은 여기로 "올라가야" 처리되고 깃발이 꺼진다
  ─────────────────┼──────────────────────────────────────────────
   kernel (아래)    │  read() syscall ─► iomap 루프 ─► poll ─► (signal) ─► 탈출
                    │        ▲                                        │
                    │        └──────── 같은 bio 재-poll ◄─────────────┘
                    │
                    │   polling이라 위로 못 올라감 → 깃발 안 꺼짐 → 반복
```

→ history 06-06의 표현: "worker에 signal이 닿으면 guard-bit 재-poll이 **최소 1번은 반드시** 찍힌다."

---

## 6. `task_sigpending(current)` 자세히

`include/linux/sched/signal.h:382`

```c
static inline int task_sigpending(struct task_struct *p)
{
    return unlikely(test_tsk_thread_flag(p, TIF_SIGPENDING));
}
```

한 줄짜리다. 하는 일은 **"이 task에 `TIF_SIGPENDING` 깃발이 켜져 있나?"** 검사뿐.

| 요소 | 의미 |
|------|------|
| `current` | 지금 이 CPU에서 실행 중인 task = polling 도는 fio worker |
| `TIF_SIGPENDING` | "처리할 signal이 와 있다"는 per-thread 깃발(비트 1개) |
| `test_tsk_thread_flag` | 그 비트가 켜졌는지 읽기 |
| `unlikely(...)` | "거의 false다"라는 컴파일러 분기 예측 힌트(값엔 영향 없음) |

**깃발의 일생**

```
 [SET]   누가 pkill -USR1 fio 로 signal 전송
            → 커널이 signal을 task pending 큐에 넣고 깃발 ON 🚩
            → ★ read() syscall이 켜는 게 아니라, 외부 signal이 비동기로 켠다

 [CLEAR] signal이 실제로 delivery될 때 깃발 OFF
            → delivery는 "커널 → userspace 복귀" 경계에서만 일어남
            → polling 중엔 복귀를 못 하므로 깃발이 안 꺼짐
```

**왜 poll 루프가 이걸 검사하나?**
polling은 CPU를 안 놓는 busy-spin이라, signal이 와도 무시하면 프로세스가 영영 응답을 못 한다.
그래서 "받을 signal 생겼으면 일단 멈추고 나가자"고 검사한다. 이 탈출이 **부수적으로** 재-poll을 만든다.

`block/blk-mq.c:5402`

```c
if (task_sigpending(current)) {
    if (poll_countp)
        *poll_countp = UINT_MAX;   // "signal 때문에 탈출" sentinel (PAS 통계용)
    return 1;                      // I/O 미완료여도 즉시 복귀 → 재-poll 유발
}
```

---

## 7. guard 본체

`block/blk-mq.c:5432`

```c
static bool blk_mq_poll_sleep_nsec(struct bio *bio, u64 nsecs)
{
    struct hrtimer_sleeper hs;
    ktime_t kt;

    if (!bio)
        return false;
    if (!nsecs)
        return false;

    if (bio_flagged(bio, BIO_LHP_POLL_SLEPT))   // ★ 이미 도장 있으면
        return false;                            //    sleep 안 하고 즉시 리턴

    bio_set_flag(bio, BIO_LHP_POLL_SLEPT);       // 첫 진입에서만 도장 찍음
    ... 실제 hrtimer sleep + io_schedule() ...
    return true;
}
```

```
 첫 진입       :  도장 없음 → 도장 찍고 mean/2 만큼 sleep   (정상)
 재-poll 진입  :  도장 있음 → return false, sleep 건너뜀    (guard 작동) ★
```

guard가 없으면 재-poll 1346회마다 또 `mean/2`(약 26us)씩 자버려 latency가 폭발한다.

---

## 8. 06-04는 왜 성공하고 06-05는 왜 실패했나

재-poll을 만들려면 **worker task에 `TIF_SIGPENDING`이 set**되어야 한다.
frontend에 set돼봐야 frontend는 poll 루프를 안 도니 아무 효과 없다.

```
                06-04 (성공)                     06-05 (실패)
        ┌───────────────────────┐        ┌───────────────────────┐
        │  pkill -USR1 -x fio    │        │  frontend PID 1개에만  │
        │                        │        │  kill (추정)           │
        └───────────────────────┘        └───────────────────────┘
                  │                                  │
        signal 도달 범위                     signal 도달 범위
        ┌───────────────────────┐        ┌───────────────────────┐
        │ frontend  ✅           │        │ frontend  ✅           │
        │ worker    ✅ ★         │        │ worker    ❌ ★         │
        └───────────────────────┘        └───────────────────────┘
                  │                                  │
        worker poll 루프 조기 탈출           worker는 방해 없이
        → 재-poll 발생                       I/O 한 번에 완료
                  │                                  │
        ┌───────────────────────┐        ┌───────────────────────┐
        │ 재-poll 1346회         │        │ 재-poll 0회            │
        │ → 그 1346회 sleep 0    │        │ → guard 시험 sample 없음│
        │ → guard 작동 확인 ✅   │        │ → 판정 불가 (고장 아님) │
        └───────────────────────┘        └───────────────────────┘
```

### 06-04 성공의 3박자

1. **회사 전체 타격**: `pkill -USR1 -x fio` 는 이름이 `fio`인 **모든 프로세스(frontend + worker)** 에 전송 → worker에 깃발 set
2. **타이밍**: fio 시작 **0.4초 후** storm 시작. SIGUSR1 기본 동작은 프로세스 종료인데, fio가 자체 핸들러(status dump) 설치를 끝낸 뒤라 안 죽고 방해만 받음
3. **고빈도**: 3ms 간격 400회 → worker가 I/O in-flight인 짧은 순간을 확실히 포착

### 06-05 실패 양상 (history 06-05 기록)

| 시도 | 결과 |
|------|------|
| 기본 SIGUSR1 storm | fio가 `User defined signal 1`로 사망 (exit 138) — 핸들러 설치 전 signal |
| `LD_PRELOAD` noop shim 사용 | startup race로 여전히 exit 138 |
| shim + 0.5s + 3ms 간격 | segfault (exit 139) — 고빈도 delivery로 user-space 불안정 |
| shim + 0.5s + 20ms 간격 (164발) | fio 정상 종료, 그러나 **재-poll 0회** — signal이 worker에 안 닿음 |

→ 안정적으로 끝난 run조차 모든 poll entry가 fresh bio였고 guard-bit 재진입이 0회.
즉 "guard가 막았다"가 아니라 **"guard를 시험할 재-poll이 안 생겼다"** 가 정확한 기록이다.

---

## 9. 잠깐 의심했던 점과 그 해소

06-05에 재-poll 유도가 안 되자 "그럼 06-04의 guard 성공 기록도 가짜 아닌가?"라는 의심이 생겼다.
06-06에 **원본 trace를 다시 집계**하여 해소했다.

`/tmp/guard-signal.trace` (06-04 14:13 생성, 14MB) 재집계 결과:

```
  poll_entry 28252
     ├── fresh 진입  (lhp=1,  guard bit 없음)        26906  →  sleep 26906회 (전부 실제 sleep)
     └── 재-poll 진입(lhp=33, guard bit 0x20 set)     1346  →  sleep     0회  ★★★

  재-poll 1346회 전부에서 두 번째 sleep이 차단됨 = guard 정상 작동 실측 증거
```

또한 06-04 → 06-05 사이 커널 커밋은 `658e97c65`(cooldn/heatup), `4be3fefb1`(adaptive lhp) 둘뿐이고,
재-poll 메커니즘 3요소는 **전부 무변경**임을 diff로 확인했다:

- `task_sigpending()` early-return: `block/blk-mq.c:5402`
- `BIO_LHP_POLL_SLEPT` guard: `block/blk-mq.c:5443`
- 같은 bio로 `bio_poll()` 재호출하는 iomap 루프: `fs/iomap/direct-io.c:882~891`

→ "adaptive LHP 포팅이 재-poll 경로를 죽였다"는 가설은 **기각**. 원인은 커널이 아니라 signal harness.

---

## 10. 코드 레퍼런스 인덱스

| 역할 | 위치 |
|------|------|
| iomap 바깥 루프 (같은 bio 반복 호출) | `dpas-kernel/fs/iomap/direct-io.c:882~891` (bio_poll @888) |
| `bio_poll()` 정의 | `dpas-kernel/block/blk-core.c:948` (blk_mq_poll_bio 호출 @977) |
| `blk_mq_poll_bio()` (sleep→poll) | `dpas-kernel/block/blk-mq.c:5702` (sleep 분기 @5718) |
| `__blk_hctx_poll()` 안쪽 루프 | `dpas-kernel/block/blk-mq.c:5388` |
| nvme_poll 호출 | `dpas-kernel/block/blk-mq.c:5396` |
| `task_sigpending()` early-return | `dpas-kernel/block/blk-mq.c:5402` |
| `blk_mq_poll_sleep_nsec()` (guard) | `dpas-kernel/block/blk-mq.c:5432` |
| `BIO_LHP_POLL_SLEPT` 검사 | `dpas-kernel/block/blk-mq.c:5443` |
| `BIO_LHP_POLL_SLEPT` 도장 | `dpas-kernel/block/blk-mq.c:5446` |
| `task_sigpending()` 정의 | `dpas-kernel/include/linux/sched/signal.h:382` |

---

## 11. 다음 작업 (테스트 계획)

```
 1. harness 복원
    └─ guest 안에서 pkill -USR1 -x fio, 3ms 간격, fio 시작 0.5초 후 storm
       (shim은 startup race 보험으로 병행 가능)

 2. signal 도달을 데이터로 확인 (추정 → 실측)
    └─ 같은 trace에 signal:signal_generate / signal:signal_deliver 를
       worker PID 필터로 추가 → "signal이 worker에 닿았는가" 확정

 3. 본 테스트 2건
    ├─ PAS guard 재현 run  (pas_enabled=1, io_poll_delay=-1)
    │     → 06-04 수치(재-poll 발생 + guard 차단) 재현 확인
    └─ adaptive LHP guard run (pas_enabled=0, io_poll_delay=0)   ★ 원래 목표
          → 같은 bio 재-poll 시 BIO_LHP_POLL_SLEPT가 중복 sleep 차단하는지 판정

 4. (1~3 실패 시에만) deterministic 커널 hook
    └─ __blk_hctx_poll()을 강제로 1회 early return → 확정적 재-poll
       ※ 코드 변경이므로 사용자 승인 필요
```

**가장 먼저 할 것**: 1번 + 2번을 한 trace에서 동시에 거는 것.
harness를 06-04 방식으로 고치면서 "이번엔 signal이 worker에 닿았다"를 tracepoint로 못 박아야,
재-poll 결과(발생/0회)가 비로소 의미를 가진다.
