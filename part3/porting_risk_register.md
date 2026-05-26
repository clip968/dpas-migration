# Part 3 Step 5 - Porting Risk Register

대상: Part 4 Minimal PAS-only port

이 문서는 Part 3 Step 5의 두 번째 산출물이다. 목적은 Part 4에서 실제 코드를 수정하기 전에, PAS-only 범위에서 실패할 가능성이 높은 지점을 먼저 적고 검증 방법을 정하는 것이다.

## 범위 결정

Part 4의 기준선은 다음과 같다.

```text
Initial hook:
  blk_mq_poll()

Initial state placement:
  request_queue -> struct dpas_queue *dpas
  dpas_queue -> per-CPU PAS state/counters

Included:
  PAS-only sleep-before-poll
  pas_enabled sysfs
  minimal duration state
  UNDER/OVER counters

Excluded:
  full DPAS mode switching
  switch_param*
  NVMe queue remapping
  submission-side interrupt mode
```

## Risk Register

| ID | Risk | Impact | Likelihood | Mitigation | Verification |
|---|---|---:|---:|---|---|
| R1 | `blk_mq_poll()`에서 sleep하면 caller context와 충돌할 수 있음 | High | Medium | 최신 tree의 `BLK_POLL_ONESHOT`, old DPAS tree의 `BLK_POLL_NOSLEEP`, signal/resched 조건을 구분한다. 최신 tree에 없는 old-only flag를 참조하지 않고 sleep 가능 조건을 helper 하나로 격리한다. | one-shot/no-sleep-equivalent workload에서 `pas_sleep_skip_nosleep_count`만 증가하고 sleep counter는 증가하지 않는지 확인 |
| R2 | hot path counter/log overhead가 latency를 왜곡함 | High | High | 기본은 per-CPU counter만 증가시킨다. per-I/O 로그는 `pas_debug`가 켜진 경우에만 제한적으로 허용한다. | `pas_enabled=0`과 `pas_enabled=1,duration=0`의 fio latency 차이를 비교 |
| R3 | `q->dpas` lifecycle 오류로 NULL deref 또는 use-after-free 발생 | High | Medium | allocation/free를 queue lifecycle에 붙이고 모든 사용 지점에 NULL check를 둔다. allocation 실패 시 queue는 유지하고 DPAS만 disabled 상태로 둔다. | `pas_enabled` sysfs 접근, device remove, module unload 또는 reboot path에서 crash가 없는지 확인 |
| R4 | `blk_mq_poll()`에는 request pointer가 없어 old DPAS의 request-level guard를 바로 구현하기 어려움 | High | High | Part 4는 queue/per-CPU state 기준으로 시작한다. request-level generation guard가 필요하다는 증거가 나오면 별도 패치로 `struct request` 확장을 검토한다. | `pas_update_skip_duplicate_count`와 under/over 합계가 비정상적으로 튀는지 확인 |
| R5 | 같은 I/O에 대해 sleep 또는 UNDER/OVER update가 여러 번 반영될 수 있음 | High | Medium | duration generation counter와 per-CPU last-update snapshot을 둔다. 완전한 request-level guard는 Part 4 후반 검증 checkpoint로 둔다. | 단일 outstanding polled I/O에서 sleep/update counter가 request 수보다 과도하게 증가하지 않는지 확인 |
| R6 | UNDER/OVER 분류가 논문 또는 old DPAS 의미와 반대로 구현될 수 있음 | High | Medium | Step 5에서는 정의를 문서화하고, old `sr_last`/`update_req` 갱신 위치와 대조한 뒤 구현한다. | 고정 duration을 매우 작게/크게 설정했을 때 `UNDER`/`OVER`가 예상 방향으로 바뀌는지 확인 |
| R7 | `ret > 0`, `ret == 0`, `ret < 0`, signal pending 반환을 같은 결과로 섞음 | Medium | Medium | `result` enum을 `UNDER`, `OVER`, `SKIP`, `ERROR`로 분리한다. signal pending은 정상 completion으로 세지 않는다. | signal/interruption test에서 `pas_error_count` 또는 skip counter가 증가하는지 확인 |
| R8 | `q->queue_hw_ctx[cookie]` 접근 전 cookie 검증이 부족함 | High | Low | 기존 `bio_poll()`의 `BLK_QC_T_NONE` check를 신뢰하되, DPAS helper에서는 cookie를 log/counter용으로만 쓰고 hctx 접근은 기존 blk-mq 흐름에 맡긴다. | invalid cookie를 만들지 않는 정상 workload에서 crash가 없는지 확인 |
| R9 | sysfs show/store와 poll hot path가 같은 state를 lock 없이 읽고 씀 | Medium | Medium | enable/debug 같은 scalar는 `READ_ONCE()`/`WRITE_ONCE()`를 사용한다. duration/counter reset은 race를 허용할 수 있는 통계로 취급하거나 `q->sysfs_lock` 범위에서 처리한다. | `pas_stats_reset` 중 fio를 돌려도 crash 없이 counter가 다시 증가하는지 확인 |
| R10 | non-NVMe 또는 poll 미지원 device에서 sysfs knob이 노출되거나 동작함 | Medium | Medium | `!q->mq_ops || !q->mq_ops->poll || !blk_mq_can_poll(q)`이면 store에서 `-EINVAL`을 반환한다. | SATA/loop/dm device에서 `pas_enabled` store가 실패하거나 sleep counter가 증가하지 않는지 확인 |
| R11 | PAS sleep이 fio 결과를 바꿨지만 경로가 실제로 실행됐는지 증명하지 못함 | High | Medium | 성능 수치보다 counter를 1차 증거로 둔다. `pas_sleep_attempt_count`, `under`, `over`를 fio 결과와 함께 기록한다. | fio 결과 보고서에 counter snapshot before/after를 같이 첨부 |
| R12 | queue freeze/refcount path와 poller 진입이 충돌함 | High | Low | `bio_poll()`의 `percpu_ref_tryget(&q->q_usage_counter)` 이후 들어오는 정상 경로를 우선 대상으로 한다. `blk_rq_poll()` 경로는 별도 확인한다. | queue freeze/unfreeze 또는 device reset 중 polled I/O에서 hang 여부 확인 |
| R13 | `hrtimer_sleeper` 또는 `io_schedule()` 사용이 최신 kernel API와 맞지 않음 | Medium | Medium | old DPAS의 sleep 코드를 그대로 복사하지 않고 최신 kernel의 timer/scheduler API를 확인한 뒤 wrapper로 감싼다. | `W=1` 빌드와 runtime smoke에서 warning/crash가 없는지 확인 |
| R14 | `CONFIG_DPAS=n`에서 include나 static inline 참조가 빌드를 깨뜨림 | High | Medium | public header에는 forward declaration과 guarded pointer만 둔다. helper 호출은 `#ifdef CONFIG_DPAS` 또는 no-op inline으로 감싼다. | `CONFIG_DPAS=n`과 `CONFIG_DPAS=y` 두 빌드 설정으로 compile 확인 |
| R15 | Part 4가 full DPAS까지 번져서 실패 원인을 분리하지 못함 | High | High | `switch_enabled`, `switch_param*`, NVMe remapping, interrupt mode counter는 문서에만 예약하고 코드에는 넣지 않는다. | diff review에서 `switch_`, `N_INT`, `N_PAS`, `nvme_pci_map_queues()` 변경이 없는지 확인 |

## 가장 먼저 닫아야 할 위험

Part 4 시작 전에 가장 먼저 닫아야 할 위험은 R1, R3, R4다.

```text
R1:
  blk_mq_poll()에서 sleep 가능한 조건을 먼저 확정한다.

R3:
  q->dpas allocation/free 위치를 먼저 확정한다.

R4:
  request pointer 없이도 PAS-only의 1차 counter/update를 구현할 수 있는지 확인한다.
```

이 세 가지가 닫히지 않으면 sysfs나 duration tuning을 먼저 구현해도 검증하기 어렵다.

## Decision Checkpoints

Part 4 중간에 아래 조건을 만나면 hook 후보를 재평가한다.

| Checkpoint | 조건 | 대응 |
|---|---|---|
| C1 | `blk_mq_poll()`에서 sleep context가 안전하지 않음 | `bio_poll()` 앞쪽 hook을 재평가 |
| C2 | request-level generation guard가 필수임 | `struct request` 최소 field 추가 또는 `blk_rq_poll()` 중심 hook 검토 |
| C3 | NVMe-only 실험을 먼저 끝내야 함 | `nvme_poll()` 주변 실험 hook을 별도 branch로 분리 |
| C4 | completion-only interrupt mode가 불충분함 | Part 5/6에서 submission path와 `REQ_POLLED` 제어를 다룸 |

## 검증 산출물

Part 4 구현이 끝났다고 말하려면 다음 자료가 필요하다.

```text
1. CONFIG_DPAS=n build 결과
2. CONFIG_DPAS=y build 결과
3. pas_enabled=0 fio + counter snapshot
4. pas_enabled=1 fio + counter snapshot
5. pas_stats before/after
6. dmesg에 warning/oops/hang 없음
7. diff review에서 Part 4 제외 범위가 실제로 수정되지 않았음
```

## 근거

- 최신 `blk_mq_poll()`은 `q`, `cookie`, `iob`, `flags`만 받고 request pointer를 직접 받지 않는다.
- 최신 `blk_hctx_poll()`은 `q->mq_ops->poll()`을 반복 호출하며 기본 loop에는 sleep이 없다.
- old DPAS는 `request_queue` 직접 field, per-CPU PAS bucket, mode switching state, verbose logging을 한 흐름에 섞었다.
- Part 4의 목적은 old artifact 전체 복사가 아니라 PAS-only policy layer를 최신 poll path 위에 최소로 얹는 것이다.
