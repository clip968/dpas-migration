# Handoff

## 현재 진행 중인 사항

- 지금은 DPAS window-level switch stats 수정 직후 검증 단계다.
- `dpas-kernel/block/blk-sysfs.c`에서 `dpas_switch_stats` sysfs 출력이 실제 누적 stats 필드를 읽도록 고쳤고, debug stats reset을 `dpas_lock` 보호 범위 안으로 옮겼다.
- VM 빌드테스트는 시작했지만 최종 `bzImage` 완료 전 사용자가 나중에 하자고 해서 중단했다. Colima VM은 `./vm stop`으로 종료했고, `./vm status`에서 `colima is not running`을 확인했다.
- VM 빌드 로그상 `block/blk-core.o`, `block/blk-sysfs.o`, `block/blk-mq.o`, `block/built-in.a`까지는 생성됐다. 최종 `arch/x86/boot/bzImage` 성공은 아직 확인하지 않았다.
- 어제는 DPAS 관련 C/header 파일만 대상으로 clangd용 `compile_commands.json`을 만들었다.
- 현재 바로 이어서 볼 핵심 파일은 다음이다.
  - `dpas-kernel/block/blk-sysfs.c`
  - `dpas-kernel/block/blk-core.c`
  - `dpas-kernel/block/blk-mq.c`
  - `dpas-kernel/include/linux/blkdev.h`
  - `dpas-kernel/fs/iomap/direct-io.c`

## 지금 알아야 하는 사항

- 다음 작업은 VM을 다시 켜서 `make -C dpas-kernel O=../build/dpas-kernel-vm ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- -j4 bzImage`를 끝까지 확인하는 것이다.
- 빌드가 끝나면 실제 부팅 후 `logging_enabled=2`, `switch_enabled` 토글, fio run 단위로 `/sys/block/<dev>/queue/dpas_switch_stats` 증가/reset을 확인해야 한다.
- host full-DPAS micro_4krr 결과는 이미 남아 있다.
  - `scripts/micro_4krr/fio_data/nvme1n1/RR/<jobs>T/<mode>/fio_report_<repeat>.log`
  - `scripts/micro_4krr/parsed_data/nvme1n1-RR-repeat_5.txt`
  - `scripts/micro_4krr/result_data/nvme1n1-RR-repeat_5.txt`
- `scripts/micro_4krr/parse.py`의 내림차순 jobs grouping 문제는 수정 및 `/tmp` 복사본 재파싱으로 확인된 상태다.
- 현재 `dpas-kernel` 내부에는 `block/blk-core.c`, `block/blk-mq.c`, `block/blk-sysfs.c`, `include/linux/blkdev.h` 변경이 남아 있다. 이 중 이번 세션에서 직접 수정한 파일은 `block/blk-sysfs.c`다.
