# 재-poll guard 검증 테스트 결과 보고서 (VM 실행)

> 작성일: 2026-06-06
> 주제: 06-04 harness를 올바르게 복원하여 adaptive LHP guard와 PAS guard를 VM에서 실측 검증
> 대상 커널: `7.1.0-rc4-dpas-vm-g4be3fefb1311` (`dpas-kernel/`)
> 관련 분석: `history/2026-06-06-repoll-guard-test-failure-report.md` (06-05 실패 원인 분석)

---

## 0. 결론 (TL;DR)

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ adaptive LHP guard 검증 성공 (원래 목표).                              │
 │ PAS guard도 같은 harness로 06-04 결과 재현 성공 (harness 검증).        │
 │ signal이 polling worker에 닿았음을 tracepoint로 "실측 증명".           │
 │ 06-05 실패 원인(signal이 worker에 안 닿음)이 역으로 확정됨.            │
 └──────────────────────────────────────────────────────────────────────┘
```

| 검증 항목 | 결과 |
|---|---|
| 재-poll 유도 (06-05 실패했던 부분) | ✅ PAS 163회, adaptive LHP 402회 발생 |
| signal이 worker에 도달 | ✅ tracepoint로 증명 (PAS worker 136회, LHP worker 141회 deliver) |
| guard가 중복 sleep 차단 | ✅ 재-poll 전부 sleep 0회 (PAS/LHP 모두) |
| 06-04 PAS 결과 재현 (현재 커널) | ✅ 재현됨 |
| 커널 안정성 | ✅ 오늘 run에서 새 dmesg 0줄 (BUG/Oops/panic/WARNING 없음) |

---

## 1. 무엇을 왜 테스트했나

- **목표**: adaptive LHP(`pas_enabled=0`, `io_poll_delay=0`) 경로에서 같은 bio 재-poll 시
  `BIO_LHP_POLL_SLEPT` guard가 두 번째 sleep을 막는지 실측.
- **전제**: 06-05는 signal을 polling worker에 보내지 못해 재-poll 자체가 0회였다(실패).
  → 06-04 방식(`pkill -USR1 -x fio`, worker까지 타격)으로 harness를 복원하고,
  signal tracepoint로 "worker 도달"을 추정이 아니라 데이터로 확인해야 한다.
- **순서**: 도구가 맞는지 먼저 검증(PAS 재현) → 대상 측정(adaptive LHP).

---

## 2. 사용한 harness (06-04 충실 복원)

```
 fio (4k randread, pvsync2, direct=1, hipri=1, iodepth=1, numjobs=1, cpus_allowed=1)
   │   cpu1에 pin, /mnt/nvme-test/dpas-fio-testfile (1GB)
   │   warmup 2s (trace off) → stats 채워 nsecs>0 보장 → 본 run 3s (trace on)
   │
 storm: taskset -c 2  pkill -USR1 -x fio   (3ms 간격, fio 시작 0.5초 후 시작)
   │   └─ -x fio = frontend + worker 전부 타격 (06-04 핵심)
   │
 shim: 사용 안 함
   └─ 사전 probe에서 이 커널의 fio가 pkill -x SIGUSR1에 죽지 않고 rc=0 확인
      (06-05 segfault는 shim+3ms 조합이 원인이었음 → shim 제외가 더 안정적)
```

### kprobe / tracepoint (한 trace에 동시 부착)

| probe | 대상 | 의미 |
|---|---|---|
| `dpas_poll_entry` | `blk_mq_poll_bio` 진입 | `bio=%si`, `lhp=+0x15(%si):u8`(guard bit 0x20), `sector=+0x28(%si)` |
| `dpas_sleep_in` | `blk_mq_poll_sleep_nsec` 진입 | `nsecs=%si` |
| `dpas_sleep_ret` | `blk_mq_poll_sleep_nsec` 리턴 | `ret=$retval` (1=실제 sleep, 0=guard로 건너뜀) |
| `signal:signal_generate` | signal 큐잉 | `sig==10` 필터, 대상 pid 기록 (보낸 곳) |
| `signal:signal_deliver` | signal delivery | `sig==10` 필터, 받은 task(prefix pid) 기록 |

> 인자 레지스터 기반 probe라 빌드 offset에 무관. mawk 1.3.4로 집계(비트 테스트는 `int(lhp/32)%2`).
> harness 스크립트: host `/tmp/dpas_guard_run.sh`, guest `/tmp/dpas_guard_run.sh`.

---

## 3. PAS guard 재현 결과 (harness 검증)

조건: `pas_enabled=1`, `io_poll_delay=-1`, warmup 2s + run 3s.

```
 fio: rc=0, 12.8k IOPS, lat avg 76.88us   |   trace 124711줄, LOST 0
 ─────────────────────────────────────────────────────────────────
 poll_entry = 41492
    ├─ fresh (guard bit 없음)        41329
    └─ re-poll (guard bit 0x20 set)    163   ◄── 재-poll 발생!
 ─────────────────────────────────────────────────────────────────
 sleep_in   = 41329   (= fresh)            ◄── re-poll은 sleep helper 진입조차 안 함
 sleep_ret  = 41329   ret1(slept)=41329  ret0=0
 nsecs      = 전부 nonzero
 ─────────────────────────────────────────────────────────────────
 signal_generate=275  signal_deliver=274
 polling worker pid = 3747  (poll_entry 41492회)
 signal_deliver: 3747→136회, 3744(frontend)→138회
 ★ PROOF: worker 3747 이 signal_deliver 136회 수신 → REACHED
```

판정: 재-poll 163회가 발생했고, 그 163회는 `blk_mq_poll_sleep_nsec`에 **진입조차 못 했다**
(`sleep_in=fresh`). PAS는 `blk_mq_poll_pas_sleep()` 입구에서 재-poll을 차단한다(06-04 기록과 일치).
**06-04 PAS guard 결과가 현재 커널에서 재현되었고, harness가 옳다는 것이 확인됨.**

---

## 4. adaptive LHP guard 결과 (원래 목표)

조건: `pas_enabled=0`, `io_poll_delay=0`, warmup 2s + run 3s.

```
 fio: rc=0, 13.5k IOPS, lat avg 72.87us   |   trace 128135줄, LOST 0
 ─────────────────────────────────────────────────────────────────
 poll_entry = 42519
    ├─ fresh (guard bit 없음)        42117
    └─ re-poll (guard bit 0x20 set)    402   ◄── 재-poll 발생!
 ─────────────────────────────────────────────────────────────────
 sleep_in   = 42519   (= poll_entry)       ◄── 모든 진입이 sleep helper에 들어감
 sleep_ret  = 42519
    ├─ ret1 (실제 sleep) = 42117  (= fresh)
    └─ ret0 (sleep 건너뜀) = 402   (= re-poll)  ◄★ guard가 402회 전부 차단
 nsecs      = 전부 nonzero (warm, mean/2 sleep)
 ─────────────────────────────────────────────────────────────────
 signal_generate=283  signal_deliver=283
 polling worker pid = 5149  (poll_entry 42519회)
 signal_deliver: 5149→141회, 5146(frontend)→142회
 ★ PROOF: worker 5149 가 signal_deliver 141회 수신 → REACHED
```

판정: 재-poll 402회가 발생했고, 그 402회 전부 `blk_mq_poll_sleep_nsec`에 진입했지만
`BIO_LHP_POLL_SLEPT` 플래그 때문에 `false`를 리턴(`ret0=402`)하며 **두 번째 sleep을 건너뛰었다.**
**adaptive LHP guard가 중복 sleep을 정확히 막는 것이 실측 확인됨 (원래 목표 달성).**

---

## 5. PAS vs adaptive LHP 구조적 차이 (이번에 관측)

두 guard 모두 "bio당 sleep 정확히 1회"를 달성하지만, **차단 지점이 다르다.**

```
 PAS (pas_enabled=1)
   blk_mq_poll_bio → blk_mq_poll_pas_sleep ──[guard]──► (재-poll이면 여기서 return)
                                                  │
                                                  └─(fresh만)─► blk_mq_poll_sleep_nsec → sleep
   관측: sleep_in = fresh        (재-poll은 sleep_nsec 진입 자체가 0)

 adaptive LHP (pas_enabled=0, io_poll_delay=0)
   blk_mq_poll_bio → blk_mq_poll_lhp_sleep ─────► blk_mq_poll_sleep_nsec
                                                     │
                                                     └─[guard: BIO_LHP_POLL_SLEPT]
                                                        재-poll이면 false 리턴(sleep X)
   관측: sleep_in = poll_entry,  ret0 = re-poll   (진입은 하되 안에서 차단)
```

| 항목 | PAS | adaptive LHP |
|---|---|---|
| 차단 지점 | `pas_sleep` 입구 (상류) | `sleep_nsec` 내부 |
| `sleep_in` | = fresh (41329) | = poll_entry (42519) |
| 재-poll의 sleep | 진입 0 | 진입은 하되 `ret0`(402) |
| 결과 | 중복 sleep 0 | 중복 sleep 0 |

---

## 6. 06-05 미스터리의 역방향 확정

- 06-05는 "signal 164발에 재-poll 정확히 0회"였고, 원인을 "signal이 worker에 안 닿음"으로 **추정**했다.
- 이번에 같은 커널/guest/fio에서 `pkill -USR1 -x fio`(worker 타격)로 바꾸자
  signal_deliver tracepoint가 **worker pid에 직접 delivery됨을 기록**(PAS 136회, LHP 141회)했고,
  그 즉시 재-poll이 발생(163 / 402)했다.
- 즉 "signal이 worker에 닿으면 재-poll이 반드시 생긴다"가 데이터로 확인되었고,
  06-05의 0회는 guard 결함이 아니라 **signal targeting 실패**였음이 역으로 확정되었다.

---

## 7. 사후 상태 / 안정성

- guest knob 원복: `pas_enabled=0`, `io_poll_delay=-1`, `io_poll=1`.
- `kprobe_events` 0줄, `dynamic_events` 0줄, signal tracepoint 2종 disable, filter 해제.
- dmesg strict scan(`BUG:|Oops|Kernel panic|panic:|WARNING:|RIP:|general protection|segfault`):
  - **유일하게 잡힌 segfault는 timestamp 996s** 항목이다.
  - 현재 uptime은 **37040s**(~10시간)이고 오늘 run은 37040s 부근에서 수행됐다.
  - dmesg 최신 3줄이 전부 996s → **오늘 run은 새 커널 메시지를 0줄 남김.**
  - 996s segfault는 06-05의 shim+3ms 세션(exit 139)에서 남은 stale 항목이며 오늘 테스트와 무관하다.
- 오늘 두 fio run 모두 `rc=0`(segfault/사망 없음).

---

## 8. 이번 테스트로 닫힌 것 / 다음

닫힌 것:
- adaptive LHP `BIO_LHP_POLL_SLEPT` guard 런타임 검증 (재-poll 402회 → 중복 sleep 0회).
- 06-04 PAS guard 결과의 현재 커널 재현.
- "signal이 worker에 닿았는가"를 tracepoint로 데이터화(추정 제거).
- 06-05 실패가 harness(signal targeting) 문제였음을 양방향으로 확정.

다음:
- adaptive LHP를 기준선으로 두고 full DPAS mode switching 설계로 진행할지 사용자 결정.
- 성능 평가는 아직 아님(이번 IOPS/latency는 경로/guard 검증 context).
```
PAS:          12.8k IOPS / 76.88us   (warm, signal storm 중)
adaptive LHP: 13.5k IOPS / 72.87us   (warm, signal storm 중)
※ storm·trace 부착 상태의 수치라 성능 결론으로 쓰지 않는다.
```
