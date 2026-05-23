# Figure 9 - per-device PAS vs per-core PAS

원본 그림:

![Figure 9](../fast26-seo/_page_7_Figure_0.jpeg)

Figure 9는 PAS state를 어디에 둘 것인지 설명한다. 결론부터 말하면 per-device PAS는 concurrent I/O에서 위험하고, DPAS는 per-core PAS 방향을 사용한다.

## 1. per-device PAS란?

per-device PAS는 SSD 하나에 PAS state 하나를 두는 방식이다.

```text
SSD device
  |
  +-- shared PAS state
        sr_pnlt
        sr_last
        duration
        adjust
        UP
        DN
```

모든 CPU가 이 state를 같이 쓴다.

```text
CPU0 ----\
CPU1 -----+---- shared PAS state ---- SSD
CPU2 -----+
CPU3 ----/
```

단일 I/O만 생각하면 단순하고 좋아 보인다. 하지만 SSD는 여러 I/O를 동시에 처리하고, 여러 CPU가 동시에 I/O를 낼 수 있다. 이때 문제가 생긴다.

## 2. 문제 1: stale sleep result

첫 번째 문제는 오래된 sleep result를 보고 duration을 갱신하는 것이다.

예를 들어 I/O #2와 #3이 아직 끝나지 않았는데 I/O #4가 submit된다고 하자. 원래라면 I/O #4는 #2, #3의 결과를 보고 싶다. 하지만 아직 결과가 없으므로 더 오래된 값을 보게 된다.

```text
time --->

I/O #1: submit ---- complete -> result available
I/O #2:   submit ---------------- still running
I/O #3:     submit -------------- still running
I/O #4:       submit -> uses old result

문제:
  I/O #4는 최신 상황을 모르고 duration을 계산한다.
```

이렇게 되면 PAS는 oversleeping이나 undersleeping이 이미 발생했는데도 그 변화를 늦게 알아차린다.

## 3. 문제 2: sleep result overwrite

두 번째 문제는 중요한 전환 신호가 덮어써지는 것이다.

PAS에서 중요한 순간은 이런 전환이다.

```text
UNDER -> OVER
OVER  -> UNDER
```

이 전환은 sleep duration이 실제 latency 경계를 지났다는 뜻이다. 그래서 PAS는 `adjust`를 reset하고 방향을 바꾼다.

그런데 concurrent completion이 연속으로 들어오면 다음처럼 된다.

```text
expected:
  I/O #2 result = UNDER
  I/O #3 result = OVER
  => pair = (UNDER, OVER)
  => adjust = 1 - DN

actual with overwrite:
  I/O #4 result = OVER
  I/O #5 result = OVER
  => latest pair = (OVER, OVER)
  => important (UNDER, OVER) transition disappears
```

결과적으로 PAS가 방향 전환을 놓치고, 잘못된 방향으로 계속 duration을 움직일 수 있다.

## 4. 문제 3: lock serialization

per-device state는 여러 CPU가 공유하므로 lock이 필요하다.

```text
CPU0 wants to update duration
CPU1 wants to update duration
CPU2 wants to update sr_last
CPU3 wants to update adjust

all must acquire same lock
```

I/O hot path에서 lock contention이 생기면 polling의 장점이 줄어든다. 빠르게 끝내려고 만든 경로가 lock 때문에 직렬화될 수 있다.

## 5. per-core PAS

per-core PAS는 CPU마다 PAS state를 따로 둔다.

```text
CPU0 -- PAS state 0 --\
CPU1 -- PAS state 1 ---+-- SSD
CPU2 -- PAS state 2 ---+
CPU3 -- PAS state 3 --/
```

각 CPU는 자신이 낸 I/O의 result만 자기 state에 반영한다.

```text
CPU0 state:
  sr_pnlt
  sr_last
  duration
  adjust

CPU1 state:
  sr_pnlt
  sr_last
  duration
  adjust
```

장점은 명확하다.

- stale result 사용 가능성이 줄어든다.
- result overwrite 문제가 줄어든다.
- shared lock이 줄어든다.
- CPU별 latency tracking이 가능하다.

## 6. 그래도 문제가 완전히 사라지지는 않는다

per-core PAS도 완전한 해결책은 아니다. 한 CPU에 여러 thread가 붙어서 동시에 I/O를 낼 수 있기 때문이다.

```text
CPU0:
  thread A -> I/O #1
  thread B -> I/O #2
  thread C -> I/O #3

all share CPU0 PAS state
```

그래서 Figure 9는 Figure 7의 concurrent I/O guard와 함께 이해해야 한다.

```text
per-core PAS:
  CPU 간 공유 문제를 줄임

Figure 7 guard:
  같은 CPU 안의 concurrent I/O 문제를 줄임
```

## 7. state ownership 표

```text
+--------------------------+------------------+---------+----------------+
| state item               | owner            | shared? | lock 필요성    |
+--------------------------+------------------+---------+----------------+
| sr_pnlt                  | per-core         | no      | 낮음           |
| sr_last                  | per-core         | no      | 낮음           |
| duration                 | per-core/bucket  | no      | 낮음           |
| adjust                   | per-core/bucket  | no      | 낮음           |
| UP/DN                    | per-core/bucket  | no      | 낮음           |
| mode                     | per-core         | mostly  | 중간           |
| global device parameter  | per-device       | yes     | sysfs write 시 |
+--------------------------+------------------+---------+----------------+
```

## 8. Linux kernel hook 관점

Figure 9를 최신 커널로 옮길 때 가장 중요한 질문은 "per-core state를 어떤 기준으로 잡을 것인가"다.

확인해야 할 질문:

```text
submit CPU와 poll CPU가 항상 같은가?
completion CPU는 submit CPU와 같은가?
preemption이나 CPU migration이 PAS state를 깨뜨릴 수 있는가?
this_cpu_ptr()만으로 충분한가?
request에 submit CPU를 기록해야 하는가?
```

후보 구조체:

```text
struct request:
  request별 submit CPU, duration generation, mode 정보를 둘 수 있는지 확인

struct request_queue:
  device-level parameter와 sysfs knob 후보

struct blk_mq_hw_ctx:
  hardware queue와 CPU mapping 확인
```

Figure 9의 핵심은 단순하다.

> PAS state를 device 하나에 몰아두면 concurrent I/O에서 결과가 섞인다. CPU별로 나누고, 그래도 남는 동시성은 Figure 7의 guard로 막아야 한다.
