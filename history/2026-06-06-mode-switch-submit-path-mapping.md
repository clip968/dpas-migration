# DPAS mode switching 이식 선행조사: syscall→block layer 제출 경로 5.18 → 7.1 매핑

> 작성일: 2026-06-06
> 목적: full mode switching 이식 전, "I/O가 어디서 polled로 제출되는가(REQ_POLLED 세팅 지점)"를 5.18(`kernel/`)과 7.1(`dpas-kernel/`)에서 전수 비교.
> 배경(사용자/동료 제보): 5.18 기준 syscall→block layer 경로가 두 군데. fio는 통과하는데 RocksDB에서 "퍼지는" 현상 발생 → 누락 경로 탐지 식으로 개발됨. 7.x에서 해당 경로가 바뀌었을 것으로 추정되어, 이식 전 변경 위치 파악이 필요.

---

## 0. 결론 (TL;DR)

- 5.18은 mode switching을 **"제출 시점"에 REQ_POLLED를 set/clear**하는 방식으로 구현했고, 훅이 **2~3곳에 분산**되어 있었다(iomap + raw blockdev + zonefs). 한 곳을 놓치면 그 경로 I/O가 모드 제어 밖으로 새고 per-CPU switch 회계가 어긋난다 → "누락 경로" 문제.
- 7.1에서는 **제출-측 DPAS 훅이 양쪽 다 사라졌고(upstream 복귀)**, polled 제출이 **iomap으로 통합**되었다. 단, **두 경로가 서로 다른 방식으로 REQ_POLLED를 세팅**한다:
  - iomap = `bio_set_polled()` 헬퍼
  - raw blockdev async = 인라인 `bio->bi_opf |= REQ_POLLED` (헬퍼 안 씀)
  - (+ NVMe passthrough = rq 레벨 `cmd_flags |= REQ_POLLED`)
- 따라서 `bio_set_polled`만 후킹하면 **fops 라우 경로를 놓친다 = 7.1판 누락 경로.** 이식 전 이 매핑을 반드시 깔고 가야 한다.

---

## 1. 5.18의 "두 군데" — 제출-측 mode 훅

syscall→DIO가 `submit_bio` 직전에 per-CPU `irq_poll_switch`(`sc`)의 `sc->mode`를 보고 REQ_POLLED를 set/clear한다. 훅이 박힌 위치:

| 경로 | 파일/위치 | 담당 워크로드 |
|------|-----------|---------------|
| ① 파일시스템 DIO | `kernel/fs/iomap/direct-io.c:91-150` (`iomap_dio_submit_bio`) | ext4/xfs O_DIRECT (fio가 ext4/xfs에서 도는 경로) |
| ② raw blockdev DIO | `kernel/block/fops.c:107-160` (`__blkdev_direct_IO_simple`) | `/dev/nvme0n1` 직접 O_DIRECT |

훅 로직 (양쪽 거의 동일):

```c
if (IOCB_HIPRI && irq_poll_switch) {
    sc->ioctr++;
    if (sc->mode) {                       /* CP=1 / PAS=2 / OL=3 / EHP=4 → polled */
        bio_set_polled(bio, iocb);
        /* per-mode 카운트(cp/pas/ol_tot). EHP는 bucket별 ehpmode[]로 poll/INT 결정 */
    } else {                              /* mode==0 = INT */
        iocb->ki_flags &= ~IOCB_HIPRI;    /* ★ 제출 시점에 polling 강제 해제 */
        bio->bi_opf   &= ~REQ_POLLED;
        sc->int_cnt++; sc->int_tot++;
        if (sc->int_cnt >= sc->param7)    /* INT → OL 전이 */
            sc->mode = 3;
    }
}
submit_bio(bio);
```

핵심: **INT 모드조차 여기서 REQ_POLLED를 지워 인터럽트로 강제**한다. 즉 5.18 mode switching의 절반은 "제출 시점 REQ_POLLED 제어"다. 이 훅이 없는 제출 경로가 있으면 그 경로는 모드 밖으로 샌다.

## 2. "fio는 되는데 RocksDB에서 퍼진" 이유 — 누락 경로

5.18에서 bio를 polled로 표시하는 지점(`bio_set_polled`) 전수:

- `kernel/fs/iomap/direct-io.c` (fs DIO)
- `kernel/block/fops.c` (raw blockdev)
- **`kernel/fs/zonefs/super.c:721` (zonefs)** ← 제3의, 빠뜨리기 쉬운 경로

워크로드마다 타는 제출 경로가 달라서(fio가 쓰는 경로만 훅 → 통과, RocksDB가 다른 제출 경로를 두드림 → 그 경로엔 훅이 없어 `sc`(qd/카운터) 회계가 어긋나며 "퍼짐") 누락 경로가 드러난 것으로 보인다. 제보된 개발 흐름과 정확히 일치.

> 주의: RocksDB가 친 **정확히 그 경로**는 코드만으로 단정 불가(당시 커밋/이슈 필요). 위는 "여러 제출 경로가 분산돼 있어 한 곳을 놓쳤다"는 구조적 정황 기반 추론. 분산 자체는 코드로 확인됨.

## 3. 7.1 비교 — 무엇이 바뀌었나 (결정적)

### (a) 제출-측 DPAS 훅이 양쪽 다 사라짐 (upstream 복귀)

- `dpas-kernel/fs/iomap/direct-io.c:63-86` (`iomap_dio_submit_bio`):
  ```c
  if (iocb->ki_flags & IOCB_HIPRI) {
      bio_set_polled(bio, iocb);
      dio->submit.poll_bio = bio;
  }
  /* irq_poll_switch / sc->mode 없음 — 순수 upstream */
  ```
- `dpas-kernel/block/fops.c`: 모드 훅 없음.
- 그래서 7.1에서 PAS/LHP가 동작하는 것은 **제출이 아니라 poll 루프**(`blk_mq_poll_bio` + per-queue knob: `pas_enabled`/`io_poll_delay` 등)에서만 DPAS가 개입하기 때문. → **수동 모드선택은 되지만 자동 switching·제출측 INT 강제는 없음.**

### (b) REQ_POLLED 세팅 지점이 통합되되 방식이 갈라짐 ← 이식 시 최대 위험

7.1에서 `REQ_POLLED`를 거는 모든 지점:

| # | 위치 | 방식 | 담당 |
|---|------|------|------|
| ① | `dpas-kernel/fs/iomap/direct-io.c:76` | **`bio_set_polled()` 헬퍼** | ext4/xfs **+ zonefs/btrfs (이제 iomap으로 통합)** |
| ② | `dpas-kernel/block/fops.c:382` (`__blkdev_direct_IO_async`) | **인라인 `bio->bi_opf \|= REQ_POLLED`** (헬퍼 미사용) | raw `/dev/nvme0n1` 비동기 DIO |
| ③ | `dpas-kernel/drivers/nvme/host/ioctl.c:503`, `core.c:746` | **rq 레벨 `cmd_flags \|= REQ_POLLED`** | io_uring NVMe passthrough |

재편 요약:
- 5.18 "iomap + fops + zonefs(3곳 분산)" → 7.1 "**iomap(zonefs/btrfs 흡수) + fops(인라인) + passthrough**".
- fs 쪽은 iomap으로 통합돼 단순해짐. 그러나 **①은 헬퍼, ②는 인라인**이라 방식이 다름.
- 함정: "`bio_set_polled`만 후킹" 하면 **②(raw blockdev) 누락** = 7.1판 누락 경로. ③ passthrough까지 있어 누락 표면이 더 넓다.

### (c) upstream의 polling 포기(fallback) 지점

INT 강제/fallback 정합성에 영향:
- IOCB_HIPRI clear: `dpas-kernel/fs/iomap/direct-io.c:396, 531, 817`
- REQ_POLLED clear: `dpas-kernel/block/blk-mq.c:3516`

## 4. 이식 권고 (설계 옵션, 미확정)

5.18처럼 경로별로 훅을 박으면 7.1에선 최소 ①②(+③)를 모두 손봐야 하고 하나만 빠져도 또 "퍼진다".

- **(A) 경로별 훅 재삽입** — 5.18 방식. iomap·fops·(passthrough) 각각에 모드 훅.
  - 장점: 5.18과 1:1 대응, 동작 이해 쉬움.
  - 단점: 누락 위험, 중복 로직, ①/② 방식 차이를 각각 처리.
- **(B) 단일 funnel에서 처리 (권장 검토)** — 모든 bio가 지나는 `blk_mq_submit_bio()`(또는 `submit_bio_noacct`)에서 `REQ_POLLED`를 검사해 모드 적용(INT면 clear, QD 회계 등).
  - 장점: 산재 경로 문제 원천 차단.
  - **검증 필요**: 그 지점엔 `iocb`/`IOCB_HIPRI` 컨텍스트가 없음(대신 bio의 REQ_POLLED만 봄 — 모드 enforce엔 충분할 수 있음). 거기서 REQ_POLLED를 지웠을 때 upstream fallback(인터럽트 완료)과 깨끗하게 맞물리는지 확인 필요.

> A/B는 인터페이스·정합성 영향이 커서 **사용자 결정 사항**. 본 문서는 매핑/근거 제공까지.

## 5. 다음 작업

1. A/B 방향 결정.
2. 결정 후, 5.18의 switch 상태머신(`irq_poll_switch`: mode 전이, qd 회계, switch_param1~7, EHP bucket 판정)을 7.1 제출 구조 위에 어떻게 얹을지 매핑.
3. INT 강제(REQ_POLLED clear)와 7.1 upstream fallback(3-c) 정합성 검증.
4. 회귀 검증: fio(iomap+raw 양쪽) + RocksDB로 누락 경로 재현 테스트.

## 6. 근거 위치 (파일:라인)

- 5.18: `kernel/fs/iomap/direct-io.c:80-150`, `kernel/block/fops.c:104-160`, `kernel/fs/zonefs/super.c:721`, `kernel/block/blk-mq.c:53,61-64` (`irq_poll_switch`, `_INT/_CP/_PAS/_OL`)
- 7.1: `dpas-kernel/fs/iomap/direct-io.c:63-86,396,531,817`, `dpas-kernel/block/fops.c:355-385`, `dpas-kernel/block/blk-mq.c:3516`, `dpas-kernel/drivers/nvme/host/ioctl.c:503`, `dpas-kernel/drivers/nvme/host/core.c:746`
- 관련: `history/2026-06-04.md`(498-499 full mode switching 설계 메모), mode 상수/상태머신 부재 분석(본 세션)
