# Part 3 Step 5 - Trace and Counter Validation Plan

대상 커널 트리: `src/linux-upstream`

비교 기준: `kernel` DPAS 5.18 artifact

이 문서는 Part 3 Step 5의 첫 번째 산출물이다. 목적은 Part 4에서 PAS-only 최소 포팅을 시작하기 전에, 어떤 counter와 log로 "PAS path가 실제로 실행되었다"를 확인할지 정하는 것이다.

## 한 줄 결론

Part 4의 검증은 per-I/O `printk()`가 아니라 counter 중심으로 시작한다. PAS-only에서 먼저 증명해야 하는 것은 `blk_mq_poll()` 경로가 `q->dpas` state를 읽고, sleep-before-poll을 수행하며, sleep 직후 poll 결과를 `UNDER` 또는 `OVER`로 분류한다는 점이다.

## 범위

Part 4에 포함한다.

```text
PAS-only:
  - pas_enabled path 진입 여부
  - sleep-before-poll 수행 여부
  - sleep 요청 시간과 실제 sleep 시간
  - sleep 직후 poll 결과
  - UNDER/OVER 분류
  - 최소 duration update 횟수
```

Part 4에서 제외한다.

```text
Full DPAS:
  - CP / PAS normal / PAS overloaded / interrupt mode switching
  - switch_param*
  - submission-side REQ_POLLED 제어
  - NVMe queue remapping
  - YCSB/RocksDB macrobenchmark
```

## 계측 위치

초기 hook 후보는 `src/linux-upstream/block/blk-mq.c`의 `blk_mq_poll()`이다.

현재 최신 kernel 흐름:

```text
bio_poll()
  -> blk_mq_poll(q, cookie, iob, flags)
     -> blk_hctx_poll(q, q->queue_hw_ctx[cookie], iob, flags)
        -> q->mq_ops->poll(hctx, iob)
```

Part 4 PAS-only 계측 지점:

```text
blk_mq_poll()
  |
  +-- counter: poll_enter
  +-- if !blk_mq_can_poll(q): counter: skip_cannot_poll
  +-- if !q->dpas or !pas_enabled: counter: skip_disabled
  +-- if flags forbid sleep: counter: skip_nosleep
  |
  +-- before sleep:
  |     counter: sleep_attempt
  |     sample requested duration
  |
  +-- after sleep:
  |     counter: sleep_done or timer_failure
  |     sample actual sleep time
  |
  +-- first poll after sleep:
        ret = blk_hctx_poll(...)
        ret > 0: completion available after sleep
        ret == 0: completion not yet available after sleep
        ret < 0: driver/error path
```

## 최소 counter

아래 counter는 `struct dpas_queue` 또는 그 아래 per-CPU stats에 둔다. 처음에는 전역 합산보다 per-CPU counter가 hot path에서 안전하다. sysfs show에서 합산한다.

| Counter | Scope | 증가 위치 | 의미 |
|---|---|---|---|
| `poll_enter_count` | per-CPU | `blk_mq_poll()` 진입 | polled completion path가 호출된 횟수 |
| `pas_enabled_count` | per-CPU | `q->dpas && pas_enabled` 확인 후 | PAS policy가 적용 가능한 상태였던 횟수 |
| `pas_sleep_attempt_count` | per-CPU | sleep 직전 | PAS가 sleep-before-poll을 시도한 횟수 |
| `pas_sleep_done_count` | per-CPU | sleep 정상 복귀 후 | 실제 sleep을 끝낸 횟수 |
| `pas_sleep_skip_disabled_count` | per-CPU | `!q->dpas` 또는 disabled | PAS가 꺼져 있어서 건너뛴 횟수 |
| `pas_sleep_skip_nosleep_count` | per-CPU | `BLK_POLL_ONESHOT` 또는 target kernel의 no-sleep equivalent | caller semantics를 보존하기 위해 sleep을 건너뛴 횟수 |
| `pas_timer_failure_count` | per-CPU | sleep이 요청 duration을 채우지 못했거나 signal/resched 조건으로 조기 복귀 | PAS sleep이 정상 측정값으로 쓰기 어려운 횟수 |
| `pas_completion_after_sleep_count` | per-CPU | sleep 직후 첫 poll `ret > 0` | sleep 뒤 바로 completion을 찾은 횟수 |
| `pas_no_completion_after_sleep_count` | per-CPU | sleep 직후 첫 poll `ret == 0` | sleep 뒤에도 completion이 없던 횟수 |
| `pas_under_count` | per-CPU | `ret == 0` 기준 1차 분류 | sleep duration이 짧았다고 보는 횟수 |
| `pas_over_count` | per-CPU | `ret > 0` 기준 1차 분류 | sleep duration이 길었거나 completion을 늦게 확인했다고 보는 횟수 |
| `pas_update_count` | per-CPU | duration/history update 성공 후 | UNDER/OVER 결과를 다음 duration에 반영한 횟수 |
| `pas_update_skip_duplicate_count` | per-CPU | 같은 generation을 이미 반영한 경우 | 중복 update guard가 동작한 횟수 |
| `pas_error_count` | per-CPU | `ret < 0` 또는 내부 error | 정상 PAS result로 분류하지 않은 횟수 |

`UNDER`와 `OVER`의 1차 판정은 다음 정의로 시작한다.

```text
UNDER:
  sleep 후 첫 poll에서 completion을 찾지 못함.
  해석: 요청한 sleep duration이 device latency보다 짧았을 가능성이 큼.

OVER:
  sleep 후 첫 poll에서 completion을 바로 찾음.
  해석: completion이 이미 준비되어 있었고, 더 일찍 poll했어도 됐을 가능성이 있음.
```

이 판정은 Part 4 구현 중 old DPAS의 `sr_last`, `sr_pnlt`, `update_req`, `dur_cnt` 의미와 다시 대조한다. 다만 Step 5 계획 단계에서는 counter 이름과 계측 위치를 먼저 고정한다.

## Full DPAS용 예약 counter

아래 counter는 Step 5 문서에 이름만 남기고 Part 4 구현에서는 제외한다.

| Counter | Part 4 상태 | 이유 |
|---|---|---|
| `dpas_mode_cp_count` | 제외 | classic polling mode switching은 Part 5 이후 범위 |
| `dpas_mode_pas_normal_count` | 제외 | PAS-only에는 단일 PAS mode만 있음 |
| `dpas_mode_pas_overloaded_count` | 제외 | overloaded mode는 queue depth policy 필요 |
| `dpas_mode_interrupt_count` | 제외 | true interrupt mode는 submission-side 제어 검토 필요 |
| `dpas_transition_count` | 제외 | mode transition state machine이 Part 4 범위를 넘음 |

## 최소 로그 형식

기본은 counter다. 로그는 debug knob가 켜져 있을 때만 rate-limit 또는 tracepoint 방식으로 제한한다.

권장 이벤트 형식:

```text
cpu=<id> q=<disk> hctx=<queue_num> cookie=<cookie> mode=pas_only duration_ns=<n> actual_sleep_ns=<n> result=<UNDER|OVER|SKIP|ERROR> ret=<n> qd=<n>
```

필드 의미:

| Field | 의미 | Part 4 필수 여부 |
|---|---|---|
| `cpu` | 현재 CPU | 필수 |
| `q` | 대상 disk/request_queue 식별자 | 권장 |
| `hctx` | poll 대상 hctx queue number | 필수 |
| `cookie` | `bio->bi_cookie`에서 온 hctx selector | 필수 |
| `mode` | Part 4에서는 항상 `pas_only` | 필수 |
| `duration_ns` | 요청한 sleep duration | 필수 |
| `actual_sleep_ns` | 측정된 실제 sleep 시간 | 필수 |
| `result` | `UNDER`, `OVER`, `SKIP`, `ERROR` | 필수 |
| `ret` | sleep 뒤 첫 poll 결과 | 필수 |
| `qd` | queue depth snapshot | 선택 |

예시:

```text
cpu=3 q=nvme0n1 hctx=5 cookie=5 mode=pas_only duration_ns=12000 actual_sleep_ns=13240 result=OVER ret=1 qd=4
cpu=3 q=nvme0n1 hctx=5 cookie=5 mode=pas_only duration_ns=9000 actual_sleep_ns=8950 result=UNDER ret=0 qd=5
```

## sysfs 노출 후보

Part 4의 sysfs는 enable과 관측에 필요한 최소 항목만 둔다.

```text
/sys/block/<dev>/queue/pas_enabled
/sys/block/<dev>/queue/pas_debug
/sys/block/<dev>/queue/pas_duration_ns
/sys/block/<dev>/queue/pas_stats
/sys/block/<dev>/queue/pas_stats_reset
```

`pas_stats` 출력 초안:

```text
poll_enter=<n>
enabled=<n>
sleep_attempt=<n>
sleep_done=<n>
skip_disabled=<n>
skip_nosleep=<n>
timer_failure=<n>
under=<n>
over=<n>
update=<n>
update_skip_duplicate=<n>
error=<n>
```

## 검증 절차

1. `CONFIG_DPAS=n` 빌드에서 추가 symbol 참조가 없어야 한다.
2. `CONFIG_DPAS=y`, `pas_enabled=0`에서 `pas_sleep_attempt_count`가 증가하지 않아야 한다.
3. `CONFIG_DPAS=y`, `pas_enabled=1`, polled I/O workload에서 `pas_sleep_attempt_count`가 증가해야 한다.
4. `pas_sleep_attempt_count == pas_sleep_done_count + pas_timer_failure_count` 관계가 대체로 유지되어야 한다.
5. polled workload에서 `pas_under_count + pas_over_count + pas_error_count`가 sleep 뒤 첫 poll 시도 수와 맞아야 한다.
6. `printk()`를 켜지 않은 상태에서 fio latency가 counter 수집 자체 때문에 크게 흔들리지 않아야 한다.
7. 최신 `src/linux-upstream`에는 `BLK_POLL_ONESHOT`만 보이므로, old DPAS의 `BLK_POLL_NOSLEEP`를 그대로 참조하지 않아야 한다.

## 성공 기준

Part 4 시작 전 Step 5의 성공 기준은 다음 문장을 코드 위치와 counter 이름으로 설명할 수 있는 것이다.

```text
Part 4 PAS-only는 blk_mq_poll()에서 q->dpas를 확인하고,
PAS가 켜진 경우 sleep-before-poll을 한 뒤,
첫 poll 결과를 UNDER/OVER counter로 기록한다.
로그는 기본 비활성이고, 검증은 sysfs counter 중심으로 수행한다.
```

## 근거

- 최신 kernel `src/linux-upstream/block/blk-core.c`: `bio_poll()`은 `bio->bi_cookie`를 읽고 `blk_mq_poll(q, cookie, ...)`로 들어간다.
- 최신 kernel `src/linux-upstream/block/blk-mq.c`: `blk_mq_poll()`은 `q->queue_hw_ctx[cookie]`로 hctx를 찾고 `blk_hctx_poll()`을 호출한다.
- 최신 kernel `src/linux-upstream/block/blk-mq.c`: `blk_hctx_poll()`은 `q->mq_ops->poll(hctx, iob)`를 반복 호출하고 기본 loop에는 sleep이 없다.
- DPAS 5.18 `kernel/block/blk-mq.c`: old artifact는 `blk_mq_poll_hybrid()`와 `blk_mq_poll_classic()`에 sleep과 result update를 섞어 넣었다.
- DPAS 5.18 `kernel/include/linux/blk_types.h`: `struct blk_rq_pas_stat`는 `dur`, `sr_last`, `sr_pnlt`, `update_req`, `dur_cnt` 계열 state를 둔다.
