# Handoff

## 현재 진행 중인 사항

- 현재 문제는 LHP가 계속 멈추거나 끝나지 않는 현상 때문에, 이전에 덜 위험했던 커널로 롤백할지 현재 커널에서 계속 디버깅할지 판단하는 단계다.
- root repo 기준 `dpas-kernel` submodule pointer는 `9193bdd03`에서 `ee97b44cf`로 이동해 있고, `dpas-kernel` 내부 작업트리는 clean이다.
- 최근 CP/LHP/PAS poll-path 변경은 `dpas-kernel/block/blk-mq.c`에 집중돼 있다.
- 오늘 판단 내용은 `history/2026-07-02.md`에 정리했다.

## 지금 알아야 하는 사항

- 2026-06-06 host Optane smoke에서 덜 위험했던 기준선은 `7.1.0-rc4-dpas-host-g4be3fefb1311`이다. 당시 `INT/CP/LHP/PAS` 20개 fio run이 모두 `err=0`이었고 새 NVMe timeout/reset/panic/oops는 없었다.
- 이 기준선으로 완전 롤백하면 안정 기준은 강하지만, 이후의 full DPAS/PAS duration/bio ctx/livelock 관련 작업을 크게 잃는다.
- 최근 회귀 격리 범위는 `9193bdd03..ee97b44cf`이고, 차이는 `block/blk-mq.c` 약 40줄이다. cookie guard, pre-oneshot poll, standalone CP guard, LHP/PAS sleep 호출 순서가 핵심이다.
- 현재 코드에서 LHP는 `pas_enabled=0`, `io_poll_delay=0`이라 `standalone_cp`가 아니며, pre-oneshot poll 뒤 completion을 못 잡으면 `blk_mq_poll_lhp_sleep()`으로 들어간다.
- LHP sleep duration은 `q->poll_stat[bucket].mean / 2`이고 별도 상한이 없다. 큰 latency sample이나 queue 전역 `poll_stat` 오염이 있으면 단일 CPU에서 completion reaping이 늦어질 수 있다.

## 다음 판단 지점

- 막힌 fio task의 `wchan`/stack을 확인해 `blk_mq_poll_sleep_nsec()`/`io_schedule()`에서 자는지, `__blk_hctx_poll()`/`nvme_poll()` busy-poll에서 못 빠지는지 먼저 분리한다.
- 우선순위는 완전 롤백보다 `ee97b44cf`, `932425da8`, `bd3df84d9`, `9193bdd03` 커밋 단위 테스트로 최근 회귀 지점을 좁히는 것이다.
- 시간이 급해 데이터 확보가 더 중요하면 `4be3fefb` host 커널은 known-less-risk 기준선으로 부팅할 수 있다. 다만 그 결과만으로 현재 코드의 root cause가 해결된 것은 아니다.
