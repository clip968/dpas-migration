# micro_4krr 성능 측정 결과 (VM) — INT/CP/LHP/PAS/DPAS1

> 작성일: 2026-06-06 (정정본)
> 대상 커널: `7.1.0-rc4-dpas-vm-g4be3fefb1311` (`dpas-kernel/`)
> 러너: `scripts/micro_4krr/run_vm.sh` (A안 + ext4 재사용 + 실제 write prefill)

---

## 0. 결론 (TL;DR) — 정정됨

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ 실제 write prefill 후 polling 성능 신호가 VM에서도 정상 관측됨.            │
 │ CP는 100% CPU로 busy-poll, LHP/PAS/DPAS1은 ~50-58% CPU로 같은 IOPS 유지.   │
 │ INT는 ~30% CPU(인터럽트로 sleep). = hybrid/adaptive의 CPU 절약 확인.       │
 │                                                                            │
 │ 초기 "신호 없음/측정 불가" 판단은 정정. 원인은 VM이 아니라 prefill 누락.   │
 └──────────────────────────────────────────────────────────────────────────┘
```

## 1. 무엇이 문제였고 어떻게 고쳤나 (핵심)

초기 측정에서 5모드가 전부 IOPS ~800k / CPU ~100% / 지연 ~950ns / ctx≈0 으로 수렴했다.
원인은 **read 타깃 블록에 실제 데이터가 없었던 것**:

- `run_vm.sh` prerun이 `fio --create_only`로 파일을 "레이아웃"만 했는데, fio 기본 `fallocate=native`는 블록을 예약(unwritten extent)만 하고 실데이터를 안 쓴다.
- ext4는 unwritten extent 읽기에 **백엔드 I/O 없이 0을 반환** → 디바이스 대기 0 → 지연 ~950ns, INT조차 안 잠(ctx≈0), 모든 모드 수렴.
- (사용자 제보) `qemu-img create`로 만든 sparse raw도 동일: 안 쓴 블록은 QEMU가 실제 I/O 없이 0 반환.

**고침**: prerun을 `--create_only`(fallocate) 대신 **실제 write prefill**로 변경.
```
fio ... --rw=write --bs=1m --size=100m --direct=1 --end_fsync=1   # 실데이터 기록
```
파일 생성 후 한 번만 실데이터를 채우면 read가 실제 블록을 친다. (어제 (b)안에서 "워밍업 무의미"라며 write 패스를 뺀 것이 이 증상의 직접 원인이었음 — 정정.)

## 2. 환경

- VM 192.168.122.57, 커널 `7.1.0-rc4-dpas-vm-g4be3fefb1311`, vCPU4/RAM4G
- 에뮬 NVMe `/dev/nvme0n1`, ext4 재사용, nvme 빌트인(`NVME_RELOADABLE=0`, `poll_queues=1` 고정)
- fio-3.39 pvsync2, job=1, runtime=10s, bs=4k, iodepth=1, randread

## 3. 결과 (prefill 후, 2회 실행)

단위: IOPS=k IOPS, CPU=usr+sys %

```
            INT     CP     LHP    PAS    DPAS1
IOPS run1   12.3   14.3   14.0   14.1   13.8
IOPS run2   14.9   14.2   13.8   13.9   14.2
CPU  run1   26.82  99.98  58.41  51.13  49.22
CPU  run2   31.21  99.98  58.25  50.77  50.13
```

라벨: INT=인터럽트 기준선, CP=hipri busy poll, LHP=adaptive LHP(`io_poll_delay=0`),
PAS=`pas_enabled=1`+`pas_adaptive_enabled=0`, DPAS1=`pas_enabled=1`+`pas_adaptive_enabled=1`.

## 4. 원시 증거 (prefill 전 → 후)

```
              clat avg        ctx (/10s)      비고
prefill 전     ~950 ns        50~597          미할당 블록, 실제 I/O 없음
prefill 후     ~70~80 µs      INT/LHP/PAS/DPAS1 ~12만~15만, CP ~43

mode   IOPS    clat avg   ctx       cpu usr/sys
INT    12-15k  80.0 µs    ~123-149k 3 / 24-28   ← 인터럽트로 sleep (저CPU)
CP     14k     68.7 µs    43        1-3 / 97-99 ← busy poll (100%, 안 잠)
LHP    14k     70.1 µs    ~139k     1-3 / 55-58 ← hybrid: 자다가 poll
PAS    14k     69.8 µs    ~140k     1-3 / 48-50
DPAS1  14k     71.2 µs    ~140k     2-3 / 47-48
```

- 지연이 ns→µs로 바뀜 = 실제 디바이스 I/O 발생.
- `ctx`: CP만 ≈43(절대 안 잠 = busy spin), 나머지는 ~14만(매 I/O sleep/wake).

## 5. 해석 (성능 신호)

- **CP > INT**: CP latency 69µs < INT 80µs, IOPS도 동등 이상. polling 경로 정상 동작 확인.
- **핵심 — CPU 계층**: `CP(100%) > LHP(58%) > PAS(51%) ≈ DPAS1(50%) > INT(30%)`.
  CP는 IOPS를 위해 CPU를 100% 태우는데, **LHP/PAS/DPAS1은 같은 ~14k IOPS를 유지하면서 CPU를 절반 수준으로 절약**한다 = hybrid/adaptive polling의 존재 이유가 매크로 지표로 확인됨.
- PAS/DPAS1이 LHP보다 CPU를 조금 더 아낌(~51/50 vs 58). PAS와 DPAS1 차이는 이 부하(job=1)에선 작음.
- iodepth=1 단일 스레드라 IOPS는 latency-bound로 모드 간 비슷(12-15k, 노이즈). **이 부하의 차별점은 throughput이 아니라 CPU 비용**이다.

## 6. 무엇이 검증됐나

- 어제 trace로 본 guard 동작이 **성능 지표(IOPS/CPU)로도** 일관됨: 재-poll 시 중복 sleep을 막는 hybrid/adaptive가 CP 대비 CPU를 절약하면서 throughput을 유지.
- `run_vm.sh`(빌트인 nvme 자동감지 + reset_knobs + ext4 + 실 prefill)가 VM에서 신뢰성 있게 동작.
- migration된 7.1 커널의 INT/CP/LHP/PAS/DPAS1 인터페이스 정상.

## 7. 남은 한계 / 다음

- 절대 수치(IOPS ~14k, latency ~70µs)는 QEMU 에뮬 NVMe 성능이라 **논문급 절대값은 아님**. 경향/CPU 계층 검증용으로 타당.
- 멀티잡 sweep은 VM `poll_queues=1`로 제한 → job=1 권장. 멀티잡·논문 절대수치는 베어메탈 실 NVMe 단계.
- PAS vs DPAS1 차이를 키우려면 부하 변화(job 수, adaptive up/dn이 작동할 조건)가 필요 — 별도 설계.
