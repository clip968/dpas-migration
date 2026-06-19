# Handoff

## 현재 진행 중인 사항

- 지금은 `dpas-kernel`의 DPAS 변경 흐름을 다시 잡는 단계다.
- 빌드 환경 준비는 이미 끝났고, Colima/Docker 기반 Ubuntu 24.04 환경에서 `x86_64_defconfig`와 `bzImage` 빌드까지 확인된 상태다.
- 어제는 DPAS 관련 C/header 파일만 대상으로 clangd용 `compile_commands.json`을 만들었다.
- 현재 바로 이어서 볼 핵심 파일은 다음이다.
  - `dpas-kernel/block/blk-sysfs.c`
  - `dpas-kernel/include/linux/blkdev.h`
  - `dpas-kernel/include/linux/blk_types.h`
  - `dpas-kernel/block/blk-core.c`
  - `dpas-kernel/block/blk-mq.c`
  - `dpas-kernel/fs/iomap/direct-io.c`

## 지금 알아야 하는 사항

- 먼저 `blk-sysfs.c`에서 DPAS 설정값이 사용자 공간에 어떻게 노출되는지 보는 것이 좋다.
- 그 다음 `blkdev.h`와 `blk_types.h`에서 DPAS 상태가 어떤 구조체 필드로 붙었는지 확인한다.
- 이후 `blk-core.c`, `blk-mq.c`, `direct-io.c`에서 실제 I/O 경로가 그 값을 어떻게 쓰는지 따라가면 된다.
- host full-DPAS micro_4krr 결과는 이미 남아 있다.
  - `scripts/micro_4krr/fio_data/nvme1n1/RR/<jobs>T/<mode>/fio_report_<repeat>.log`
  - `scripts/micro_4krr/parsed_data/nvme1n1-RR-repeat_5.txt`
  - `scripts/micro_4krr/result_data/nvme1n1-RR-repeat_5.txt`
- 단, `result_data/nvme1n1-RR-repeat_5.txt`는 `20,16,8,4,2,1` 내림차순 jobs를 `mean_std.py`에 `ascend=1`로 넘긴 탓에 IOPS와 CPU 행이 섞여 있다. 결과 해석은 `parsed_data`나 `fio_data` 원본에서 다시 계산해야 한다.
- `dpas-kernel` 내부 git 상태는 깨끗하다.
- 바깥 repo에는 `.kilo/`, 일부 `history/`, `README.md`, `scripts/micro_4krr/run_host_dpas_optane.sh` 쪽 변경/미추적 상태가 남아 있다.
- 생성된 `bzImage`를 실제 VM 부팅 흐름에 연결하는 검증은 아직 남아 있다.
