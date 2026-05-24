# DPAS 5.18 Polling Path Hook 추출 노트

대상 커널 트리: `kernel`

커널 버전: `5.18.0-rc6-dpas-fast26`

이 문서는 Part 3 Step 3의 두 번째 산출물이다. 목적은 DPAS artifact가 Linux 5.18 기반 kernel의 어디에 PAS/DPAS 코드를 끼워 넣었는지 분리하는 것이다.

이 문서는 아직 최신 kernel과의 구조 diff를 최종 판단하지 않는다. Step 4에서 diff와 hook 후보를 평가하기 전에, 먼저 DPAS artifact의 hook inventory를 만드는 단계다.

## Step 3에서 답해야 하는 질문

```text
DPAS 5.18 artifact는 기존 blk-mq/NVMe polling path의 어디에
PAS state, sleep-before-poll, UNDER/OVER update, mode switching을 넣었는가?
```

이 질문을 더 작게 나누면 다음과 같다.

```text
1. PAS sleep duration state는 어디에 저장되는가?
2. PAS/DPAS enable knob은 어디에 연결되는가?
3. per-CPU mode switching state는 어디에 있는가?
4. sleep-before-poll은 어느 함수에서 수행되는가?
5. sleep 후 poll 결과는 어느 함수에서 UNDER/OVER로 반영되는가?
6. NVMe driver 쪽에도 DPAS queue mapping hook이 있는가?
```

## 한 줄 결론

DPAS 5.18 artifact는 단순히 `sleep()` 하나를 poll path에 추가한 것이 아니다. 다음 네 가지를 서로 연결해서 넣었다.

```text
1. struct request_queue에 PAS/DPAS knob과 state field 추가
2. q->pas_stat으로 per-CPU PAS bucket state 추가
3. irq_poll_switch로 per-CPU DPAS mode switching state 추가
4. blk_mq_poll_hybrid_sleep() / blk_mq_poll_classic()에
   sleep-before-poll과 sleep-result update 추가
```

즉 Part 4에서 최신 kernel에 바로 옮길 수 있는 단일 hook은 없다. 먼저 PAS-only 최소 범위와 full DPAS mode switching 범위를 분리해야 한다.

## 전체 구조

DPAS 5.18 artifact의 주요 흐름은 다음처럼 읽을 수 있다.

```text
sysfs knob
  |
  +-- pas_enabled
  +-- pas_adaptive_enabled
  +-- ehp_enabled
  +-- switch_enabled
  +-- switch_param*
  |
  v
struct request_queue
  |
  +-- q->pas_stat              per-CPU PAS bucket state
  +-- q->pas_enabled           PAS enable
  +-- q->switch_enabled        DPAS mode switching enable
  +-- q->poll_nsec             fixed/classic hybrid polling control
  |
  v
blk_mq_poll_hybrid_sleep()
  |
  +-- blk_mq_poll_pas_nsecs()
  |     |
  |     +-- duration 계산
  |     +-- sr_pnlt / sr_last 기반 update
  |     +-- irq_poll_switch 기반 mode transition
  |
  +-- hrtimer_sleeper
  +-- io_schedule()
  |
  v
blk_mq_poll_classic()
  |
  +-- q->mq_ops->poll(hctx, iob)
  +-- completion 결과로 sr_last/update_req 갱신
```

## Hook 1: PAS bucket state

파일: `kernel/include/linux/blk_types.h`

확인 위치: 536-548행

구조체:

```c
struct blk_rq_pas_stat {
	u64 dur;
	long long adj;
	long long up;
	long long dn;

	u8 sr_pnlt;
	u8 sr_last;
	u8 update_req;
	u8 dur_cnt;
	u8 dur_cnt_checked;
};
```

역할:

```text
PAS가 bucket별 sleep duration을 관리하기 위한 상태다.
각 CPU마다 이 구조체 배열을 가지고, request bucket별로 dur/up/dn/history를 관리한다.
```

필드 의미:

| field | 의미 | DPAS/PAS에서의 역할 |
|---|---|---|
| `dur` | 현재 sleep duration | 다음 sleep-before-poll에서 사용할 시간 |
| `adj` | duration 조정 비율 | UNDER/OVER 결과에 따라 duration을 얼마나 바꿀지 결정 |
| `up` | duration 증가량 계수 | undersleep 쪽으로 판단될 때 duration 증가에 사용 |
| `dn` | duration 감소량 계수 | oversleep 쪽으로 판단될 때 duration 감소에 사용 |
| `sr_pnlt` | 이전 이전 sleep result | 최근 history 2개 중 penultimate result |
| `sr_last` | 직전 sleep result | 가장 최근 sleep result |
| `update_req` | 다음 duration update 필요 여부 | poll 결과가 반영되었음을 표시 |
| `dur_cnt` | duration generation counter | request가 어떤 generation의 dur로 잤는지 추적 |
| `dur_cnt_checked` | 이미 반영한 generation | 중복 update 방지 |

논문 개념과의 연결:

```text
PAS duration adjustment
UNDER/OVER history
adaptive sleep time update
```

최신 kernel 대응:

```text
직접 대응되는 구조체는 없다.
최신 kernel port에서는 DPAS 전용 구조체로 분리하는 것이 낫다.
```

Part 4 영향:

```text
PAS-only 구현에도 필요한 핵심 state다.
다만 최신 kernel의 공용 blk_types.h에 그대로 넣을지,
별도 dpas 전용 header/struct로 분리할지는 Step 4에서 결정해야 한다.
```

## Hook 2: `struct request_queue`에 직접 들어간 PAS/DPAS field

파일: `kernel/include/linux/blkdev.h`

확인 위치: 418-437행

추가 field:

```c
int poll_nsec;

struct blk_stat_callback	*poll_cb;
struct blk_rq_stat		*poll_stat;

struct blk_rq_pas_stat __percpu *pas_stat;
int last_poll_count;

int pas_enabled;
int pas_adaptive_enabled;
int ehp_enabled;
int max_no_lock;
int poll_threshold;
int logging_enabled;
int switch_enabled;
int switch_param1;
int switch_param2;
int switch_param3;
int switch_param4;
int switch_param5;
```

역할:

```text
PAS/DPAS 실험에 필요한 대부분의 queue-level state와 knob이 request_queue에 직접 들어가 있다.
```

분류:

| field | 분류 | 설명 |
|---|---|---|
| `poll_nsec` | 기존 hybrid polling 계열 | fixed sleep duration 또는 classic mode 제어 |
| `poll_cb`, `poll_stat` | polling statistics | 기존 hybrid polling 통계 기반 sleep 계산과 연결 |
| `pas_stat` | PAS state | per-CPU PAS bucket state pointer |
| `pas_enabled` | PAS knob | PAS sleep-before-poll 사용 여부 |
| `pas_adaptive_enabled` | adaptive PAS knob | `up/dn` adaptive update 사용 여부 |
| `ehp_enabled` | EHP knob | enhanced hybrid polling 계열 실험 |
| `switch_enabled` | DPAS knob | mode switching 사용 여부 |
| `switch_param*` | DPAS parameter | mode transition threshold/period 등 |

논문 개념과의 연결:

```text
PAS enable
PAS adaptive duration
DPAS mode switching
experiment parameter control
```

최신 kernel 대응:

```text
최신 kernel의 struct request_queue에 이 field들은 없다.
그대로 복사하면 공용 hot structure를 크게 오염시킨다.
```

Part 4 영향:

```text
PAS-only 최소 포팅에서는 request_queue에 많은 field를 직접 추가하지 말고,
request_queue -> dpas_queue pointer 방식이 더 안전하다.
```

권장 방향:

```c
struct request_queue {
	...
#ifdef CONFIG_DPAS
	struct dpas_queue *dpas;
#endif
};
```

그리고 `struct dpas_queue` 안에 다음을 둔다.

```text
pas_enabled
pas_stat
minimal counters
minimal sysfs-visible parameters
```

## Hook 3: per-CPU DPAS mode switching state

파일: `kernel/include/linux/blk-mq.h`

확인 위치: 686-719행

구조체:

```c
struct blk_switch {
	int enabled;
	int mode; // 0: int, 1: poll, 2: pas, 3: overloaded.
	int ehpmode[17];
	int cp_cnt;
	int pas_cnt;
	int ol_cnt;
	int int_cnt;
	int N_POLL;
	int N_INT;
	int N_PAS;
	int param1;
	...
	int qd;
	int qd_sum;
	int tf;

	spinlock_t qd_lock;
	atomic_t lock;

	u64 cp_tot;
	u64 pas_tot;
	u64 ol_tot;
	u64 int_tot;
};

extern struct blk_switch __percpu *irq_poll_switch;
```

역할:

```text
CPU별 DPAS mode와 mode transition counter를 저장한다.
```

mode 의미:

| mode | 주석상 의미 | 논문 개념 |
|---|---|---|
| `0` | interrupt | DPAS interrupt mode |
| `1` | poll | classic polling |
| `2` | pas | PAS normal |
| `3` | overloaded | PAS overloaded |

중요 counter:

| field | 의미 |
|---|---|
| `cp_cnt` | classic polling mode에서의 sample count |
| `pas_cnt` | PAS mode에서의 sample count |
| `ol_cnt` | overloaded mode에서의 sample count |
| `int_cnt` | interrupt mode에서의 sample count |
| `qd` | 현재 queue depth처럼 쓰이는 값 |
| `qd_sum` | mode 판단을 위한 queue depth 누적값 |
| `tf` | timer failure 또는 duration 하한 도달 관련 counter로 사용 |
| `param*` | mode transition threshold |

최신 kernel 대응:

```text
직접 대응되는 구조체는 없다.
full DPAS mode switching은 별도 policy layer로 설계해야 한다.
```

Part 4 영향:

```text
PAS-only 포팅에서는 이 구조체 전체를 가져오면 범위가 너무 커진다.
Step 4에서 "PAS-only에 필요한 최소 상태"와 "Part 5 이후 full DPAS 상태"를 분리해야 한다.
```

## Hook 4: PAS enable sysfs knob

파일: `kernel/block/blk-sysfs.c`

확인 위치: 61-92행

함수:

```c
queue_pas_enabled_store()
queue_pas_enabled_show()
```

핵심 코드:

```c
if (!q->mq_ops || !q->mq_ops->poll)
	return -EINVAL;

if (val == 1 && q->poll_stat) {
	if (q->poll_stat)
		blk_stat_remove_callback(q, q->poll_cb);
	blk_stat_free_callback(q->poll_cb);
}

if (val == 0 || val == 1)
	q->pas_enabled = val;
else
	return -EINVAL;
```

역할:

```text
/sys/block/<dev>/queue/pas_enabled를 통해 PAS를 켜고 끈다.
poll callback이 없는 queue에서는 PAS를 허용하지 않는다.
PAS를 켤 때 기존 poll_stat callback을 제거한다.
```

읽는 포인트:

```text
PAS는 polling-capable queue에서만 의미가 있다.
artifact는 PAS와 기존 hybrid polling statistics path를 동시에 쓰지 않도록 처리한다.
```

Part 4 영향:

```text
PAS-only 최소 포팅에 필요한 가장 중요한 sysfs knob 후보다.
다만 최신 kernel에서는 기존 queue sysfs 구조가 일부 달라졌을 수 있으므로
Step 4에서 최신 blk-sysfs.c 위치를 다시 확인해야 한다.
```

## Hook 5: EHP / adaptive PAS / DPAS switch sysfs knobs

파일: `kernel/block/blk-sysfs.c`

확인 위치:

```text
327-418행: store/show 함수
1376-1473행: QUEUE_*_ENTRY 등록
```

관련 함수/entry:

```text
queue_switch_enabled_store()
queue_pas_adaptive_enabled_store()
queue_ehp_enabled_store()

QUEUE_RW_ENTRY(queue_pas_enabled, "pas_enabled")
QUEUE_RW_ENTRY(queue_pas_adaptive_enabled, "pas_adaptive_enabled")
QUEUE_RW_ENTRY(queue_ehp_enabled, "ehp_enabled")
QUEUE_RW_ENTRY(queue_switch_enabled, "switch_enabled")
QUEUE_RW_ENTRY(queue_switch_param*, "switch_param*")
```

역할:

```text
PAS만이 아니라 EHP, adaptive PAS, full DPAS mode switching까지 sysfs로 제어한다.
```

특히 `queue_switch_enabled_store()`는 `irq_poll_switch`의 per-CPU state도 함께 건드린다.

```c
for_each_possible_cpu(i) {
	sc = per_cpu_ptr(irq_poll_switch, i);
	sc->enabled = val;
}
q->switch_enabled = val;
```

읽는 포인트:

```text
switch_enabled는 단순히 request_queue field 하나만 바꾸는 knob이 아니다.
per-CPU irq_poll_switch state와 연결된다.
```

Part 4 영향:

```text
full DPAS switch knob은 Part 4 범위 밖으로 두는 것이 안전하다.
Part 4는 pas_enabled와 최소 counter 정도만 가져가고,
switch_enabled / switch_param*는 Part 5 이후로 미루는 편이 낫다.
```

## Hook 6: PAS duration 계산과 DPAS mode transition

파일: `kernel/block/blk-mq.c`

확인 위치: 5064-5332행

함수:

```c
blk_mq_poll_pas_nsecs()
```

역할:

```text
현재 request의 bucket과 CPU를 기준으로 PAS sleep duration을 계산한다.
동시에 irq_poll_switch를 이용해 DPAS mode transition도 수행한다.
```

큰 흐름:

```text
request -> bucket 계산
  |
  v
q->pas_stat에서 현재 CPU의 PAS state 획득
  |
  v
irq_poll_switch에서 현재 CPU의 mode state 획득
  |
  +-- mode/counter/qdepth/timer failure 업데이트
  |
  v
sr_pnlt / sr_last 기반으로 duration 조정
  |
  v
다음 sleep duration 반환
```

PAS duration update 핵심:

```c
cur_case = stat[bucket].sr_pnlt * 2 + stat[bucket].sr_last;
switch(cur_case) {
	case 0: /* overslept, overslept */
		stat[bucket].adj -= stat[bucket].dn;
		break;
	case 1: /* overslept, underslept */
		stat[bucket].adj = 1 * q->div + stat[bucket].up;
		break;
	case 2: /* underslept, overslept */
		stat[bucket].adj = 1 * q->div - stat[bucket].dn;
		break;
	case 3: /* underslept, underslept */
		stat[bucket].adj += stat[bucket].up;
		break;
}
stat[bucket].dur = stat[bucket].dur * stat[bucket].adj / q->div;
```

읽는 포인트:

```text
sr_pnlt와 sr_last는 최근 sleep 결과 2개를 표현한다.
두 결과 조합에 따라 adj를 조정하고, adj로 dur를 업데이트한다.
```

주의할 점:

```text
이 함수 안에는 PAS duration 계산과 DPAS mode switching이 섞여 있다.
최신 kernel로 포팅할 때는 이 둘을 분리해서 보는 것이 좋다.
```

Part 4 영향:

```text
PAS-only에는 duration 계산 부분만 필요하다.
CP/PAS/OL/INT mode transition은 Part 4에서 제외하는 것이 안전하다.
```

## Hook 7: sleep-before-poll 삽입 지점

파일: `kernel/block/blk-mq.c`

확인 위치: 5378-5594행

함수:

```c
blk_mq_poll_hybrid_sleep()
```

역할:

```text
실제 poll loop에 들어가기 전에 잠깐 sleep한다.
PAS가 켜져 있으면 blk_mq_poll_pas_nsecs()로 sleep duration을 계산한다.
그 duration만큼 hrtimer_sleeper + io_schedule()로 sleep한다.
```

핵심 흐름:

```text
blk_qc_to_hctx(q, qc)
blk_qc_to_rq(hctx, qc)
  |
  v
if q->pas_enabled:
  nsecs = blk_mq_poll_pas_nsecs(q, rq, cpu_num)
else if q->ehp_enabled:
  nsecs = blk_mq_poll_ehp_nsecs(q, rq)
else:
  nsecs = blk_mq_poll_nsecs(q, rq)
  |
  v
if nsecs == 0:
  return false
  |
  v
rq->rq_flags |= RQF_MQ_POLL_SLEPT
  |
  v
hrtimer_sleeper_start_expires()
io_schedule()
```

중요 코드:

```c
} else if(q->pas_enabled){ /* PAS */
	cpu_num = blk_mq_rq_cpu(rq);
	nsecs = blk_mq_poll_pas_nsecs(q, rq, cpu_num);
}
```

그리고 실제 sleep:

```c
set_current_state(TASK_UNINTERRUPTIBLE);
hrtimer_sleeper_start_expires(&hs, mode);
if (hs.task)
	io_schedule();
hrtimer_cancel(&hs.timer);
```

중복 sleep 방지:

```c
if (!rq || (rq->rq_flags & RQF_MQ_POLL_SLEPT))
	return false;

rq->rq_flags |= RQF_MQ_POLL_SLEPT;
```

읽는 포인트:

```text
PAS의 핵심 hook은 "driver poll 직전"이 아니라
"poll loop에 들어가기 전에 request 기준으로 sleep할 수 있는 지점"이다.
```

Part 4 영향:

```text
최신 kernel에 같은 함수가 같은 형태로 없을 수 있다.
따라서 Step 4에서 bio_poll() 또는 blk_mq_poll() 근처에
이 역할을 재구성할 수 있는지 평가해야 한다.
```

## Hook 8: sleep 결과 update 지점

파일: `kernel/block/blk-mq.c`

확인 위치: 5659-5852행

함수:

```c
blk_mq_poll_classic()
```

역할:

```text
driver poll callback을 실제로 호출한다.
poll 성공 시, PAS가 켜져 있으면 이번 sleep 결과를 sr_last/update_req에 반영한다.
```

핵심 흐름:

```text
do {
  ret = q->mq_ops->poll(hctx, iob);
  if (ret > 0) {
    if (q->pas_enabled && rq) {
      bucket = blk_mq_poll_stats_bkt(rq);
      stat = per_cpu_ptr(q->pas_stat, rq->cpu_num);

      if (같은 CPU && 같은 dur generation && 아직 반영 안 함) {
        stat[bucket].dur_cnt_checked = stat[bucket].dur_cnt;
        stat[bucket].sr_pnlt = stat[bucket].sr_last;
        if (!poll_count)
          stat[bucket].sr_last = 0;
        else
          stat[bucket].sr_last = 1;
        stat[bucket].update_req = 1;
      }
    }
    return ret;
  }

  poll_count++;
  cpu_relax();
} while (!need_resched());
```

`poll_count` 해석:

```text
poll_count == 0:
  sleep 후 첫 poll에서 바로 completion을 찾았다.
  artifact에서는 sr_last = 0으로 기록한다.

poll_count > 0:
  sleep 후에도 poll loop를 더 돌고 나서 completion을 찾았다.
  artifact에서는 sr_last = 1로 기록한다.
```

주의:

```text
sr_last가 0/1 중 무엇을 UNDER/OVER로 부르는지는 코드 주석과 논문 용어를
Step 4에서 다시 정합시켜야 한다.
현재 artifact 주석에서는 cur_case 주석에 overslept/underslept 표현이 붙어 있다.
```

Part 4 영향:

```text
PAS-only를 구현하려면 sleep-before-poll만 넣으면 부족하다.
sleep 후 첫 poll 결과를 보고 다음 duration update에 반영하는 경로도 필요하다.
```

## Hook 9: request 단위 tracking field

파일: `kernel/block/blk-mq.c`

확인 위치:

```text
blk_mq_poll_pas_nsecs(): rq->cpu_num, rq->dur_cnt 설정
blk_mq_poll_hybrid_sleep(): rq->dur, rq->log_real_sleep_time 설정
blk_mq_poll_classic(): rq->cpu_num, rq->dur_cnt로 update 중복 방지
```

역할:

```text
어떤 CPU의 어떤 PAS duration generation으로 sleep했는지 request에 묶어 둔다.
poll 완료 시점에 같은 CPU/generation인지 확인해서 중복 update를 막는다.
```

읽는 포인트:

```text
PAS state는 per-CPU인데 request completion 시점의 CPU가 바뀔 수 있다.
그래서 request에 cpu_num/dur_cnt를 저장하고, 완료 시점에 다시 확인한다.
```

Part 4 영향:

```text
최신 kernel에 request field를 직접 추가할지,
별도 side table / request private area를 사용할지 검토해야 한다.
단순 PAS-only라도 "한 I/O에 대해 sleep 결과를 한 번만 반영"하는 장치가 필요하다.
```

## Hook 10: NVMe driver 쪽 queue mapping

파일: `kernel/drivers/nvme/host/pci.c`

확인 위치:

```text
nvme_pci_map_queues()
nvme_setup_io_queues()
poll_queues / nr_poll_queues
```

현재 확인한 사실:

```text
DPAS 5.18 artifact도 기본적으로 HCTX_TYPE_POLL과 NVMe poll queue 구조를 사용한다.
poll queue 수는 poll_queues / nr_poll_queues 계열로 관리된다.
```

아직 미확정:

```text
DPAS artifact가 NVMe queue mapping을 논문 Figure 9/10 수준으로 얼마나 직접 수정했는지는
추가 확인이 필요하다.
```

Part 4 영향:

```text
PAS-only 초기 포팅에서는 NVMe queue remapping을 하지 않는 편이 안전하다.
NVMe queue mapping 수정은 Part 5 또는 Part 6에서 full DPAS와 함께 보는 것이 맞다.
```

중요한 이식 판단:

```text
DPAS 5.18의 NVMe poll queue 구조는 최신 kernel에도 이미 존재한다.
따라서 HCTX_TYPE_POLL / poll_queues / nvme_pci_map_queues()의 기본 구조는
Part 4에서 이식할 대상이 아니다.
```

Part 4에서 그대로 전제로 둘 구조:

```text
REQ_POLLED -> HCTX_TYPE_POLL
poll queue와 non-polled queue 분리
poll queue 여러 개 가능
poll queue는 interrupt vector 없이 blk_mq_map_queues() 사용
```

Part 4에서 이식할 대상:

```text
poll queue로 들어온 request에 대해 sleep-before-poll을 넣는 PAS policy
PAS duration/history state
sleep 결과 update
minimal pas_enabled control path
```

따라서 이 hook은 “복사할 코드”가 아니라 “건드리지 않아도 되는 기반 구조 확인”에 가깝다.

## Hook inventory 요약표

| Hook | 위치 | 역할 | Part 4 포함 여부 |
|---|---|---|---|
| PAS bucket state | `include/linux/blk_types.h` | duration/history 저장 | 포함 필요 |
| request_queue field | `include/linux/blkdev.h` | queue-level PAS/DPAS state | 최소화해서 포함 |
| `blk_switch` | `include/linux/blk-mq.h` | per-CPU mode switching | Part 4 제외 권장 |
| `pas_enabled` sysfs | `block/blk-sysfs.c` | PAS enable knob | 포함 필요 |
| `switch_enabled` sysfs | `block/blk-sysfs.c` | full DPAS switch | Part 4 제외 권장 |
| `blk_mq_poll_pas_nsecs()` | `block/blk-mq.c` | PAS duration 계산 | PAS-only 부분만 포함 |
| `blk_mq_poll_hybrid_sleep()` | `block/blk-mq.c` | sleep-before-poll | 핵심 포함 |
| `blk_mq_poll_classic()` | `block/blk-mq.c` | sleep result update | 핵심 포함 |
| request tracking fields | `request` 관련 field | 중복 update 방지 | 방식 검토 필요 |
| NVMe queue mapping | `drivers/nvme/host/pci.c` | poll queue 구성 | 이미 최신 kernel에 있으므로 이식 대상 아님 |

## Step 3에서 현재까지 확정한 사실

```text
1. DPAS 5.18은 PAS state를 request_queue와 per-CPU pas_stat에 둔다.
2. DPAS mode switching state는 per-CPU irq_poll_switch에 둔다.
3. PAS sleep-before-poll은 blk_mq_poll_hybrid_sleep()에 들어가 있다.
4. sleep duration 계산은 blk_mq_poll_pas_nsecs()가 담당한다.
5. sleep 결과 update는 poll loop 성공 시 blk_mq_poll_classic()에서 수행된다.
6. sysfs knob은 blk-sysfs.c에 다수 추가되어 있다.
7. PAS-only와 full DPAS mode switching은 코드상 강하게 섞여 있지만,
   포팅 계획에서는 반드시 분리해야 한다.
```

## Step 4로 넘길 쟁점

Step 4에서 반드시 판단해야 할 항목:

```text
1. 최신 kernel에서 sleep-before-poll을 bio_poll()에 넣을지 blk_mq_poll()에 넣을지
2. request_queue에 직접 field를 추가할지 dpas_queue pointer로 분리할지
3. per-CPU PAS state를 어떤 구조로 둘지
4. sleep 결과 update를 어떤 return path에서 처리할지
5. request에 cpu/dur generation tracking field를 추가할지
6. full DPAS mode switching과 NVMe queue remapping을 Part 4에서 제외할지
```

현재 Step 3 기준 권장안:

```text
Part 4는 PAS-only로 제한한다.
full DPAS mode switching은 제외한다.
NVMe queue remapping은 제외한다.
HCTX_TYPE_POLL / poll_queues infrastructure는 최신 kernel 것을 그대로 쓴다.
sysfs는 pas_enabled와 최소 debug/counter만 둔다.
state는 request_queue 직접 field 폭증 대신 dpas_queue wrapper를 검토한다.
```

## 다음에 더 읽을 위치

DPAS 5.18 hook inventory를 더 확정하려면 다음을 추가로 읽는다.

```text
kernel/block/blk-mq.c
  - blk_mq_poll()
  - bio_poll()에서 blk_mq_poll_hybrid_sleep() / blk_mq_poll_classic() 호출 흐름
  - request field 추가 위치

kernel/include/linux/blkdev.h
  - switch_param6 이후 나머지 DPAS field

kernel/block/blk-sysfs.c
  - pas_d_init / pas_up_init / pas_dn_init / heat_up / cool_dn store 함수

kernel/drivers/nvme/host/pci.c
  - DPAS artifact가 queue mapping을 실제로 바꾼 부분이 있는지 확인
```
