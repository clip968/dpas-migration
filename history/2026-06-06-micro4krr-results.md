# micro_4krr 결과표 — INT/CP/LHP/PAS/DPAS1 (VM, prefill 후)

> 작성일: 2026-06-06
> 상세 분석/원인은 `history/2026-06-06-micro4krr-vm-perf.md` 참고. 이 문서는 결과표 정리본.

## 측정 조건

- 커널: `7.1.0-rc4-dpas-vm-g4be3fefb1311` (`dpas-kernel/`), VM 192.168.122.57
- 디바이스: 에뮬 NVMe `nvme0n1` (ext4, 실제 write **prefill** 완료)
- 워크로드: 4KB 랜덤리드 · `iodepth=1` · `numjobs=1` · `runtime=10s`
- 반복: 동일 조건 2회 (run1 / run2)
- nvme 빌트인(`NVME_RELOADABLE=0`, `poll_queues=1` 고정)

## 모드 정의

| 모드 | knob 설정 | 의미 |
|------|-----------|------|
| INT | hipri 없음 | 인터럽트 기준선 |
| CP | hipri, `io_poll_delay=-1` | classic busy polling |
| LHP | hipri, `io_poll_delay=0` | hybrid poll (자다가 막판 poll) |
| PAS | `pas_enabled=1`, `pas_adaptive_enabled=0` | PAS, 적응 off |
| DPAS1 | `pas_enabled=1`, `pas_adaptive_enabled=1` | PAS + 적응 on |

## IOPS (단위: k IOPS)

| 모드 | run1 | run2 | 평균 |
|------|-----:|-----:|-----:|
| INT | 12.3 | 14.9 | 13.6 |
| CP | 14.3 | 14.2 | 14.3 |
| LHP | 14.0 | 13.8 | 13.9 |
| PAS | 14.1 | 13.9 | 14.0 |
| DPAS1 | 13.8 | 14.2 | 14.0 |

## CPU 점유율 (단위: %, usr+sys)

| 모드 | run1 | run2 | 평균 |
|------|-----:|-----:|-----:|
| INT | 26.82 | 31.21 | 29.0 |
| CP | 99.98 | 99.98 | 100.0 |
| LHP | 58.41 | 58.25 | 58.3 |
| PAS | 51.13 | 50.77 | 51.0 |
| DPAS1 | 49.22 | 50.13 | 49.7 |

## 평균 지연 / 컨텍스트 스위치

ctx = fio 프로세스의 컨텍스트 스위치 횟수(스케줄러). 잠들면 ↑, busy poll이면 ≈0.

| 모드 | 평균 지연 (µs) | ctx run1 | ctx run2 | I/O당 ctx |
|------|--------------:|---------:|---------:|----------:|
| INT | 80.0 | 123,342 | 149,232 | ≈ 1 |
| CP | 68.7 | 43 | 43 | ≈ 0 |
| LHP | 70.1 | 140,389 | 138,704 | ≈ 1 |
| PAS | 69.8 | 141,294 | 139,387 | ≈ 1 |
| DPAS1 | 71.2 | 138,502 | 141,542 | ≈ 1 |

## CPU 효율 요약 (CP 대비)

| 모드 | IOPS 평균 (k) | CPU 평균 (%) | CP 대비 CPU 절약 | 비고 |
|------|-------------:|------------:|----------------:|------|
| CP | 14.3 | 100.0 | — | busy spin, 안 잠 (ctx≈43) |
| LHP | 13.9 | 58.3 | -41.7%p | 같은 IOPS, CPU 절반 |
| PAS | 14.0 | 51.0 | -49.0%p | LHP보다 조금 더 절약 |
| DPAS1 | 14.0 | 49.7 | -50.3%p | PAS와 거의 동일 (정적 부하라 적응 효과 미미) |
| INT | 13.6 | 29.0 | (폴링 아님) | 인터럽트로 sleep, ctx 매우 높음 |

## 해석 요약

- **CP > INT** (지연 68.7µs < 80µs): polling 경로 정상 동작 확인.
- polling 계열(LHP/PAS/DPAS1)은 CP와 같은 ~14k IOPS를 유지하면서 **CPU를 100% → 50~58%로 절반 절약**. hybrid/adaptive polling의 존재 이유가 매크로 지표로 확인됨.
- ctx로 본 동작 차이: CP만 ≈43(spin), 나머지는 I/O당 ≈1회 sleep.
- **LHP ≈ PAS ≈ DPAS1**: 정적·저편차·단일스레드 부하라 적응(DPAS1)이 할 일이 적어 차이가 작음(예상된 결과). 차이를 키우려면 변동성 있는 부하 또는 베어메탈 실 NVMe 필요.
- 절대값(~14k IOPS, ~70µs)은 QEMU 에뮬 NVMe라 **경향/CPU 계층 검증용**이며 논문급 절대수치는 아님.
