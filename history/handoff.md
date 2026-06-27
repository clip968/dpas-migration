# Handoff

## 현재 진행 중인 사항

- 현재 위치는 host DPAS runner 실행 중 발생한 `PAS 4T RR` 커널 divide error에 대해 duration clamp 테스트 변경을 적용한 뒤, host 검증으로 넘어가기 전 단계다.
- 이전 host DPAS 커널 `7.1.0-rc4-dpas-host-g63a80d0b9d99`로 부팅했고, `/sys/block/nvme1n1/queue/dpas_switch_stats` 존재와 초기값 0은 확인했다.
- 현재 `dpas-kernel` checkout은 `465aff726 이전의 u64 div overflow 문제를 dur 상한선 제한으로 테스트`이고, `dpas-kernel` 내부 작업트리는 clean이다.
- `scripts/micro_4krr/run_host_dpas_optane.sh`는 DPAS run 직후 `dpas_switch_stats`를 저장하도록 수정돼 있다.
- `scripts/micro_4krr/parse_dpas_switch_stats.py`도 추가돼 stats 표를 raw/summary 결과로 파싱한다.
- 단일 CPU host DPAS 실험 중 `nvme1n1 repeat1 PAS 4T RR`에서 fio가 중단됐고, 사용자 shell `dmesg` 기준 커널 `divide error`가 발생했다.
- 이후 사용자는 CPU0 고정으로 `DPAS_JOB_LIST=1,2,4,8` runner를 다시 돌렸고, 2T에서 매우 느리다고 보고했다. 현재 확인된 2T 병목은 PAS가 아니라 pure CP 구간이다.

## 지금 알아야 하는 사항

- Oops 위치는 `blk_mq_poll_bio+0x1b8/0x800`이다.
- objdump 매핑상 원래 fault 코드는 `dpas-kernel/block/blk-mq.c`의 `stat->dur = mul_u64_u64_div_u64(stat->dur, (u64)stat->adj, q->div);`였다.
- 현재 checkout에서는 이 직접 호출이 `blk_mq_poll_pas_scale_duration()` helper로 대체되어 있고, `BLK_MQ_PAS_MAX_DUR_NS 100000ULL` 상한을 둔 테스트 변경이 들어가 있다.
- fault 명령은 `divq 0x120(%r9)`이고, `request_queue.div` offset `0x120`과 맞아 분모는 `q->div`로 보인다.
- x86 `divide error`는 분모 0뿐 아니라 quotient overflow에서도 발생하므로, 현재 가설은 PAS adaptive duration 계산에서 `stat->dur` 또는 `stat->adj`가 커져 overflow가 난 경우다.
- 실패 모드는 `PAS`이고 `switch_enabled=0` 경로라서, DPAS mode switch보다 PAS adaptive duration 계산을 먼저 봐야 한다.
- 새 2T slowdown 관찰에서는 `2T/CP/fio_report_1.log`가 `Starting 2 processes`에서 멈췄고, fio 명령은 `--numjobs=2 --cpus_allowed=0 --cpus_allowed_policy=split --hipri`였다. queue knob는 `io_poll=1`, `io_poll_delay=-1`, `pas_enabled=0`, `pas_adaptive_enabled=0`, `switch_enabled=0`이었다.
- 따라서 2T slowdown은 우선 classic polling job 2개를 CPU 0 하나에 올린 CPU oversubscription으로 해석한다. CP는 sleep 없이 busy-poll하므로 단일 CPU 확장성 테스트의 기준선으로 부적합할 수 있다.
- 바로 이어서 볼 핵심 파일은 다음이다.
  - `dpas-kernel/block/blk-mq.c`
  - `dpas-kernel/block/blk-core.c`
  - `dpas-kernel/include/linux/blkdev.h`
  - 원본 비교용 5.18 DPAS 파일

## 다음 판단 지점

- duration clamp 테스트 변경은 적용됐지만, 최종 채택 여부는 host 검증 결과를 보고 사용자 결정이 필요하다.
- 현재 host가 `465aff726` 기반 커널로 빌드/설치/부팅된 상태인지 확인해야 한다.
- 먼저 host PAS 4T RR smoke test를 재실행하고, 통과하면 DPAS stats 저장 실험으로 돌아간다.
- 단일 CPU에서 job scaling을 계속 보려면 먼저 `DPAS_IO_MODE=INT,PAS,DPAS`처럼 CP를 제외하거나, CP 포함 비교는 `taskset -c 0-1` 이상으로 CPU 수와 job 수를 맞춰 다시 확인한다.
