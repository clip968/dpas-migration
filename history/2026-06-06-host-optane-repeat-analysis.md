# 2026-06-06 host Optane 반복 테스트 raw data 및 분석

## 요약

DPAS host 커널로 bare-metal 부팅한 뒤, 물리 Optane SSD에서 `INT`, `CP`, `LHP`, `PAS` 4개 모드를 5회 반복 측정했다.

이번 결과의 핵심:

- 20개 fio run 모두 `err=0`.
- IOPS/latency 순위: `CP > PAS > LHP > INT`.
- CPU 사용률 순위: `CP > PAS > LHP > INT`.
- `CP`는 최고 IOPS/최저 latency를 보였지만 CPU total이 거의 100%였다.
- `PAS`는 `CP` 대비 IOPS 90.2%를 유지하면서 CPU total은 68.5%로 줄었다.
- `LHP`는 `PAS`보다 CPU는 낮지만 IOPS도 낮았다.
- `INT`는 CPU 사용률은 가장 낮지만 IOPS/latency가 가장 약했다.
- `DPAS`/`DPAS1`은 이번 실험에서 제외했다.

## 실험 환경

```text
log directory:
/tmp/dpas-host-postboot/host-repeat-20260606-190447

latest symlink:
/tmp/dpas-host-postboot/host-repeat-latest

date:
2026-06-06 19:04:47 KST +0900

kernel:
Linux kesl-40c1 7.1.0-rc4-dpas-host-g4be3fefb1311 #1 SMP PREEMPT_DYNAMIC Sat Jun 6 17:01:26 KST 2026 x86_64 GNU/Linux

cmdline:
BOOT_IMAGE=/boot/vmlinuz-7.1.0-rc4-dpas-host-g4be3fefb1311 root=PARTUUID=b1db2aa1-2042-4f43-b6f9-b8d916802e8e ro rootwait console=tty0 loglevel=7 nvme.poll_queues=20 panic=30

nvme.poll_queues:
20

target:
/dev/nvme1n1p1 -> /mnt/dpas-optane
ext4 rw,relatime
```

대상 장치는 host에서 직접 인식된 물리 Optane SSD다. VM/QEMU 내부 장치가 아니다.

## fio 설정

prefill:

```text
rw=write
bs=1m
size=100m
numjobs=20
direct=1
end_fsync=1
group_reporting
```

측정 workload:

```text
rw=randread
bs=4k
ioengine=pvsync2
iodepth=1
numjobs=1
direct=1
readonly
time_based=1
runtime=27s
ramp_time=3s
group_reporting=1
output-format=json
```

반복 구조:

```text
modes=INT CP LHP PAS
jobs=1
repeats=5
```

mode별 설정:

| Mode | fio `--hipri` | `io_poll_delay` | `pas_enabled` | `pas_adaptive_enabled` | 의미 |
|---|---:|---:|---:|---:|---|
| INT | no | -1 | 0 | 0 | interrupt baseline |
| CP | yes | -1 | 0 | 0 | classic polling |
| LHP | yes | 0 | 0 | 0 | low-power hybrid polling |
| PAS | yes | 0 | 1 | 1 | PAS adaptive polling |

## 변인 통제

고정한 조건:

- 같은 host boot session에서 모든 모드를 측정했다.
- 같은 kernel release와 같은 boot cmdline을 사용했다.
- `nvme.poll_queues=20`을 고정했다.
- 같은 물리 SSD, 같은 partition, 같은 ext4 filesystem, 같은 test directory를 사용했다.
- fio workload는 mode와 `--hipri`/queue knob를 제외하고 동일하게 유지했다.
- 각 mode 실행 전 `drop_caches`를 수행했다.
- 각 mode 실행 전 queue knob를 reset한 뒤 해당 mode 설정만 적용했다.
- 테스트 파일은 사전에 실제 write prefill로 생성했다.
- `DPAS`/`DPAS1`은 실행하지 않았다.
- raw block device가 아니라 ext4 위 파일에 `direct=1`로 접근했다.

통제하지 못했거나 아직 별도 고정하지 않은 조건:

- mode 순서는 randomized가 아니라 `INT -> CP -> LHP -> PAS`로 고정했다.
- CPU governor, IRQ affinity, background daemon은 별도로 고정하지 않았다.
- job 수는 1개만 측정했다.
- workload는 4KiB random read만 측정했다.
- 반복 수는 5회이므로 경향 확인용이며, 최종 논문용 통계로는 더 긴 runtime과 더 많은 반복이 필요하다.

## Aggregate 결과

원본 aggregate CSV:

```csv
mode,jobs,n,err_sum,iops_mean,iops_stdev,bw_mib_mean,lat_avg_us_mean,cpu_total_mean,ctx_mean
INT,1,5,0,70297.12,497.86,274.60,13.671,35.70,1898097
CP,1,5,0,97939.57,86.40,382.58,9.906,99.96,189
LHP,1,5,0,75356.50,1737.39,294.36,12.597,56.79,2034734
PAS,1,5,0,88369.60,314.89,345.19,10.770,68.50,2385957
```

분석 표:

| Mode | n | err_sum | IOPS mean | IOPS stdev | IOPS CV | BW mean | Avg Lat | CPU total | ctx mean | CP 대비 IOPS | CP 대비 CPU | IOPS/CPU |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| INT | 5 | 0 | 70.3k | 498 | 0.71% | 274.6 MiB/s | 13.671 us | 35.70% | 1,898,097 | 71.8% | 35.7% | 1969.3 |
| CP | 5 | 0 | 97.9k | 86 | 0.09% | 382.6 MiB/s | 9.906 us | 99.96% | 189 | 100.0% | 100.0% | 979.8 |
| LHP | 5 | 0 | 75.4k | 1,737 | 2.31% | 294.4 MiB/s | 12.597 us | 56.79% | 2,034,734 | 76.9% | 56.8% | 1327.0 |
| PAS | 5 | 0 | 88.4k | 315 | 0.36% | 345.2 MiB/s | 10.770 us | 68.50% | 2,385,957 | 90.2% | 68.5% | 1290.1 |

## Raw data

원본 `summary.csv`:

```csv
repeat,mode,jobs,err,iops,bw_mib,lat_avg_us,lat_stdev_us,lat_min_us,lat_max_us,cpu_usr,cpu_sys,cpu_total,ctx,json
1,INT,1,0,70950.56,277.15,13.671,7.038,10.848,176.759,7.84,26.77,34.62,1915743,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-1/1T/INT/fio.json
1,CP,1,0,97988.44,382.77,9.923,6.869,7.991,1413.101,5.10,94.86,99.95,203,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-1/1T/CP/fio.json
1,LHP,1,0,72253.25,282.24,13.147,6.980,10.142,191.604,10.10,46.53,56.63,1950938,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-1/1T/LHP/fio.json
1,PAS,1,0,88533.09,345.83,10.765,7.068,8.404,199.594,10.13,58.24,68.37,2390463,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-1/1T/PAS/fio.json
2,INT,1,0,69738.57,272.42,13.718,6.593,11.011,728.584,10.79,25.34,36.14,1883018,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-2/1T/INT/fio.json
2,CP,1,0,98001.89,382.82,9.912,6.813,7.993,747.102,5.39,94.57,99.96,200,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-2/1T/CP/fio.json
2,LHP,1,0,76212.40,297.70,12.440,5.898,9.871,90.120,11.16,45.61,56.77,2057844,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-2/1T/LHP/fio.json
2,PAS,1,0,88387.80,345.26,10.780,7.119,8.392,726.407,10.08,58.44,68.51,2386447,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-2/1T/PAS/fio.json
3,INT,1,0,69871.12,272.93,13.637,6.594,11.031,723.063,11.46,25.09,36.54,1886592,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-3/1T/INT/fio.json
3,CP,1,0,97954.00,382.63,9.909,6.647,8.036,725.064,5.30,94.67,99.97,169,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-3/1T/CP/fio.json
3,LHP,1,0,76150.62,297.46,12.465,5.997,9.533,726.335,10.98,45.79,56.77,2056174,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-3/1T/LHP/fio.json
3,PAS,1,0,88753.45,346.69,10.721,7.007,8.293,197.197,10.38,57.97,68.34,2396320,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-3/1T/PAS/fio.json
4,INT,1,0,70552.72,275.60,13.698,6.816,9.969,171.236,9.11,26.01,35.11,1904997,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-4/1T/INT/fio.json
4,CP,1,0,97964.78,382.67,9.911,6.784,7.995,732.733,5.21,94.74,99.95,210,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-4/1T/CP/fio.json
4,LHP,1,0,76194.55,297.63,12.451,5.944,9.981,187.422,10.94,45.93,56.87,2057364,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-4/1T/LHP/fio.json
4,PAS,1,0,87910.34,343.40,10.796,7.226,8.397,722.906,10.24,58.57,68.81,2373600,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-4/1T/PAS/fio.json
5,INT,1,0,70372.62,274.89,13.630,6.507,10.485,723.435,10.62,25.45,36.07,1900137,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-5/1T/INT/fio.json
5,CP,1,0,97788.75,381.99,9.874,6.431,8.030,716.258,5.86,94.11,99.97,162,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-5/1T/CP/fio.json
5,LHP,1,0,75971.67,296.76,12.482,5.853,10.068,186.239,11.06,45.84,56.90,2051348,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-5/1T/LHP/fio.json
5,PAS,1,0,88263.32,344.78,10.786,7.147,8.442,750.193,10.21,58.24,68.45,2382955,/tmp/dpas-host-postboot/host-repeat-20260606-190447/repeat-5/1T/PAS/fio.json
```

## 안정성 확인

검증 결과:

- 모든 fio run의 `err=0`.
- `dmesg-important.txt`와 mode별 `dmesg-after.txt`에서 반복 fio 중 새 NVMe timeout/reset/panic/oops로 판단되는 항목은 확인되지 않았다.
- final knob reset 후:

```text
io_poll                  1
io_poll_delay            -1
nomerges                 0
pas_enabled              0
pas_adaptive_enabled     0
ehp_enabled              0
pas_poll_threshold       0
pas_d_init               100
pas_up_init              10000
pas_dn_init              100000
```

부팅 시점의 기존 warning:

- 일부 PCI BAR/ROM assignment warning이 남아 있다.
- `simple-framebuffer`와 `ast` 로그에 `[drm] Registered ... drm panic` 문자열이 잡히지만, 이는 drm panic support 등록 문구로 보이며 fio 중 panic 발생으로 해석하지 않는다.

## 해석

`CP`는 가장 높은 IOPS와 가장 낮은 평균 latency를 보였다. 그러나 CPU total이 99.96%로 사실상 한 CPU를 busy polling에 소모한다. context switch가 평균 189로 매우 낮은 것도 busy spin 특성과 일치한다.

`INT`는 CPU total이 35.70%로 가장 낮지만 IOPS가 `CP` 대비 71.8%이고 평균 latency도 가장 높다. context switch가 약 190만으로 높아 interrupt/sleep wakeup 경로의 특성이 드러난다.

`LHP`는 `INT`보다 IOPS가 높고 latency가 낮지만, `PAS`보다는 낮은 IOPS와 높은 latency를 보였다. CPU total은 56.79%로 `PAS`보다 낮다.

`PAS`는 이번 조건에서 가장 균형적인 결과를 보였다. `CP` 대비 IOPS를 90.2% 유지하면서 CPU total은 68.5%로 줄였다. latency도 `CP` 다음으로 낮았다. 단, `PAS`의 context switch 수는 가장 높으므로, CPU 절감의 질과 scheduler 영향은 추가 분석이 필요하다.

## 결론

이번 5회 반복 테스트에서는 `PAS`가 `CP` 대비 성능 손실을 약 10% 수준으로 제한하면서 CPU 사용률을 약 31.5%p 줄이는 결과를 보였다.

다만 이 결과는 `numjobs=1`, 4KiB random read, ext4 file direct I/O 조건의 반복 측정이다. 논문용 최종 결론을 위해서는 다음 확장이 필요하다.

- `jobs=1,2,4,8,16,20` 확장.
- mode 순서 randomization 또는 Latin square 순서 적용.
- repeat 수 증가.
- runtime 증가.
- CPU governor, IRQ affinity, background load 통제.
- raw block device 또는 clean filesystem 조건 비교.
