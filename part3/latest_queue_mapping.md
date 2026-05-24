# 최신 커널 Queue Mapping 코드 리딩 노트

대상 커널 트리: `src/linux-upstream`

커널 버전: `7.1.0-rc4`

확인한 git revision: `79bd2dded`

이 문서는 Part 3 Step 3의 첫 번째 산출물이다. 목적은 최신 Linux kernel에서 polled I/O가 어떤 queue mapping을 타는지 확인하는 것이다. 아직 DPAS 코드를 넣을 위치를 최종 결정하는 문서가 아니라, Step 4에서 hook 후보를 평가하기 위한 사실 정리 문서다.

## Step 3에서 답해야 하는 질문

```text
REQ_POLLED가 붙은 I/O는 최신 kernel에서 어떤 hctx mapping을 타고,
NVMe poll queue로 어떻게 연결되는가?
```

이 질문을 더 작게 나누면 다음과 같다.

```text
1. 최신 kernel에 HCTX_TYPE_POLL이라는 queue type이 존재하는가?
2. REQ_POLLED가 있으면 정말 HCTX_TYPE_POLL이 선택되는가?
3. request allocation 시점에 어느 hctx가 선택되는가?
4. NVMe PCI driver는 poll queue 수를 어떻게 정하는가?
5. poll queue는 interrupt vector / IRQ affinity를 가지는가?
6. CPU는 poll queue에 어떤 방식으로 매핑되는가?
```

## 한 줄 결론

최신 kernel에서 `REQ_POLLED`가 붙은 I/O는 submission path에서 이미 `HCTX_TYPE_POLL`로 분류된다. 이후 blk-mq request allocation은 `ctx->hctxs[HCTX_TYPE_POLL]`을 통해 poll용 `blk_mq_hw_ctx`를 선택한다. NVMe PCI driver는 poll queue에 IRQ affinity를 붙이지 않고, generic `blk_mq_map_queues()`로 CPU를 poll queue에 고르게 배분한다.

즉 흐름은 다음과 같다.

```text
REQ_POLLED
  -> blk_mq_get_hctx_type()
  -> HCTX_TYPE_POLL
  -> blk_mq_map_queue()
  -> ctx->hctxs[HCTX_TYPE_POLL]
  -> NVMe poll queue map
```

## 전체 그림

최신 kernel의 polled I/O queue 선택은 completion path가 아니라 submission path에서 결정된다.

```text
User / io_uring / direct I/O
  |
  v
bio->bi_opf에 REQ_POLLED 포함
  |
  v
blk-mq request allocation
  |
  v
blk_mq_get_hctx_type(opf)
  |
  +-- REQ_POLLED 있음 -> HCTX_TYPE_POLL
  +-- READ only       -> HCTX_TYPE_READ
  +-- 그 외           -> HCTX_TYPE_DEFAULT
  |
  v
blk_mq_map_queue()
  |
  v
ctx->hctxs[HCTX_TYPE_POLL]
  |
  v
NVMe poll queue
```

이 점이 DPAS에서 중요하다. DPAS의 full interrupt mode가 진짜 interrupt queue를 사용해야 한다면, 나중에 poll loop에서 `bio_poll()`만 안 부르는 방식으로는 충분하지 않을 수 있다. 이미 request가 poll hctx로 들어갔기 때문이다.

## 확인 1: `HCTX_TYPE_POLL`은 최신 kernel에 존재한다

파일: `src/linux-upstream/include/linux/blk-mq.h`

확인 위치: 481-493행

```c
/**
 * enum hctx_type - Type of hardware queue
 * @HCTX_TYPE_DEFAULT:	All I/O not otherwise accounted for.
 * @HCTX_TYPE_READ:	Just for READ I/O.
 * @HCTX_TYPE_POLL:	Polled I/O of any kind.
 * @HCTX_MAX_TYPES:	Number of types of hctx.
 */
enum hctx_type {
	HCTX_TYPE_DEFAULT,
	HCTX_TYPE_READ,
	HCTX_TYPE_POLL,

	HCTX_MAX_TYPES,
};
```

해석:

```text
HCTX_TYPE_DEFAULT = 일반 I/O
HCTX_TYPE_READ    = read 전용 queue map이 있을 때 read I/O
HCTX_TYPE_POLL    = polling I/O
```

여기서 중요한 점은 poll이 단순 flag가 아니라 blk-mq의 hardware context type 중 하나로 모델링된다는 것이다. 따라서 polled I/O는 일반 queue와 별도 mapping table을 탈 수 있다.

## 확인 2: `REQ_POLLED`가 있으면 `HCTX_TYPE_POLL`이 선택된다

파일: `src/linux-upstream/block/blk-mq.h`

확인 위치: 90-101행

```c
static inline enum hctx_type blk_mq_get_hctx_type(blk_opf_t opf)
{
	enum hctx_type type = HCTX_TYPE_DEFAULT;

	/*
	 * The caller ensure that if REQ_POLLED, poll must be enabled.
	 */
	if (opf & REQ_POLLED)
		type = HCTX_TYPE_POLL;
	else if ((opf & REQ_OP_MASK) == REQ_OP_READ)
		type = HCTX_TYPE_READ;
	return type;
}
```

읽는 포인트:

```text
1. 기본값은 HCTX_TYPE_DEFAULT다.
2. opf에 REQ_POLLED가 있으면 HCTX_TYPE_POLL로 바뀐다.
3. READ 여부보다 REQ_POLLED 여부가 먼저 검사된다.
```

즉 `READ | REQ_POLLED`인 경우에도 read queue가 아니라 poll queue가 우선이다.

DPAS 관점:

```text
REQ_POLLED를 붙인 순간 poll queue로 들어갈 가능성이 높다.
따라서 full DPAS interrupt mode를 만들 때는
"poll completion을 안 한다"와 "처음부터 interrupt queue로 보낸다"를 구분해야 한다.
```

## 확인 3: `blk_mq_map_queue()`는 선택된 hctx type의 hctx를 돌려준다

파일: `src/linux-upstream/block/blk-mq.h`

확인 위치: 109-113행

```c
static inline struct blk_mq_hw_ctx *blk_mq_map_queue(blk_opf_t opf,
						     struct blk_mq_ctx *ctx)
{
	return ctx->hctxs[blk_mq_get_hctx_type(opf)];
}
```

읽는 포인트:

```text
ctx는 CPU별 software context다.
ctx->hctxs[]는 hctx type별 hardware context pointer 배열이다.
blk_mq_get_hctx_type(opf)가 HCTX_TYPE_POLL을 반환하면
ctx->hctxs[HCTX_TYPE_POLL]이 선택된다.
```

쉽게 말하면:

```text
현재 CPU의 ctx
  |
  +-- DEFAULT hctx
  +-- READ hctx
  +-- POLL hctx  <- REQ_POLLED면 여기
```

## 확인 4: request allocation 시점에 hctx가 정해진다

파일: `src/linux-upstream/block/blk-mq.c`

확인 위치: 551-553행

```c
data->ctx = blk_mq_get_ctx(q);
data->hctx = blk_mq_map_queue(data->cmd_flags, data->ctx);
```

읽는 포인트:

```text
1. blk_mq_get_ctx(q)로 현재 CPU의 software context를 얻는다.
2. data->cmd_flags를 기준으로 blk_mq_map_queue()를 호출한다.
3. 그 결과가 data->hctx에 저장된다.
```

여기서 `data->cmd_flags`에 `REQ_POLLED`가 포함되어 있으면 `data->hctx`는 poll hctx가 된다.

DPAS 관점:

```text
request가 만들어지는 시점에 이미 poll hctx가 정해진다.
따라서 completion path hook만으로는 queue type을 바꾸기 어렵다.
```

## 확인 5: NVMe PCI driver는 poll queue 수를 따로 관리한다

파일: `src/linux-upstream/drivers/nvme/host/pci.c`

확인 위치: 2898-2903행

```c
/*
 * Poll queues don't need interrupts, but we need at least one I/O queue
 * left over for non-polled I/O.
 */
poll_queues = min(dev->nr_poll_queues, nr_io_queues - 1);
dev->io_queues[HCTX_TYPE_POLL] = poll_queues;
```

읽는 포인트:

```text
poll queue는 interrupt가 필요 없다.
하지만 모든 I/O queue를 poll queue로 만들 수는 없다.
non-polled I/O를 위한 queue를 최소 하나 남긴다.
```

따라서 poll queue 수는 다음처럼 제한된다.

```text
poll_queues = min(사용자가 요청한 poll queue 수, 전체 I/O queue 수 - 1)
```

DPAS 관점:

```text
NVMe driver는 poll queue와 non-polled queue를 분리할 수 있는 구조를 이미 가진다.
하지만 full DPAS interrupt mode가 poll queue와 interrupt queue 사이를 동적으로 오가려면
submission-side queue selection까지 설계해야 한다.
```

## 확인 6: NVMe poll queue는 IRQ affinity mapping을 쓰지 않는다

파일: `src/linux-upstream/drivers/nvme/host/pci.c`

확인 위치: 681-708행

```c
static void nvme_pci_map_queues(struct blk_mq_tag_set *set)
{
	struct nvme_dev *dev = to_nvme_dev(set->driver_data);
	int i, qoff, offset;

	offset = queue_irq_offset(dev);
	for (i = 0, qoff = 0; i < set->nr_maps; i++) {
		struct blk_mq_queue_map *map = &set->map[i];

		map->nr_queues = dev->io_queues[i];
		if (!map->nr_queues) {
			BUG_ON(i == HCTX_TYPE_DEFAULT);
			continue;
		}

		/*
		 * The poll queue(s) doesn't have an IRQ (and hence IRQ
		 * affinity), so use the regular blk-mq cpu mapping
		 */
		map->queue_offset = qoff;
		if (i != HCTX_TYPE_POLL && offset)
			blk_mq_map_hw_queues(map, dev->dev, offset);
		else
			blk_mq_map_queues(map);
		qoff += map->nr_queues;
		offset += map->nr_queues;
	}
}
```

읽는 포인트:

```text
DEFAULT/READ queue:
  interrupt vector가 있으면 blk_mq_map_hw_queues() 사용
  즉 IRQ affinity를 반영할 수 있다.

POLL queue:
  interrupt가 없으므로 IRQ affinity도 없다.
  그래서 generic blk_mq_map_queues() 사용
```

DPAS 관점:

```text
poll queue는 "어느 interrupt vector가 어느 CPU에 붙는가"보다
"CPU를 poll queue에 어떻게 고르게 나눌 것인가"가 핵심이다.
```

## 확인 7: generic CPU-to-queue mapping은 CPU를 queue에 고르게 배분한다

파일: `src/linux-upstream/block/blk-mq-cpumap.c`

확인 위치: 59-77행

```c
void blk_mq_map_queues(struct blk_mq_queue_map *qmap)
{
	const struct cpumask *masks;
	unsigned int queue, cpu, nr_masks;

	masks = group_cpus_evenly(qmap->nr_queues, &nr_masks);
	if (!masks) {
		for_each_possible_cpu(cpu)
			qmap->mq_map[cpu] = qmap->queue_offset;
		return;
	}

	for (queue = 0; queue < qmap->nr_queues; queue++) {
		for_each_cpu(cpu, &masks[queue % nr_masks])
			qmap->mq_map[cpu] = qmap->queue_offset + queue;
	}
	kfree(masks);
}
```

읽는 포인트:

```text
qmap->nr_queues개 queue를 기준으로 CPU들을 group_cpus_evenly()로 나눈다.
각 CPU의 mq_map[cpu]에는 queue_offset + queue가 저장된다.
grouping에 실패하면 모든 CPU가 queue_offset으로 간다.
```

poll queue에서는 이 함수가 중요하다. NVMe PCI driver가 poll queue에 대해 이 generic mapping을 사용하기 때문이다.

## Queue type 정리표

| queue type | 사용 조건 | NVMe queue 연결 방식 | DPAS 관점 |
|---|---|---|---|
| `HCTX_TYPE_DEFAULT` | 기본 I/O, 또는 별도 type이 선택되지 않은 I/O | non-polled I/O queue. interrupt vector / IRQ affinity mapping 가능 | classic interrupt path와 비교할 기준 |
| `HCTX_TYPE_READ` | read 전용 queue map이 있고 `REQ_POLLED`가 없는 read I/O | default와 유사하게 IRQ affinity mapping 가능 | DPAS PAS-only 초기 포팅에서는 핵심 대상 아님 |
| `HCTX_TYPE_POLL` | `REQ_POLLED`가 붙은 I/O | `dev->io_queues[HCTX_TYPE_POLL]` 기반. IRQ affinity 없이 `blk_mq_map_queues()` 사용 | PAS sleep-before-poll과 DPAS poll-mode state의 주 대상 |

## Step 3에서 현재까지 확정한 사실

```text
1. 최신 kernel에는 HCTX_TYPE_POLL이 명시적으로 존재한다.
2. REQ_POLLED가 있으면 HCTX_TYPE_POLL이 선택된다.
3. request allocation 시 data->hctx가 poll hctx로 정해진다.
4. NVMe PCI driver는 poll queue 수를 별도로 관리한다.
5. poll queue는 interrupt가 필요 없고 IRQ affinity mapping도 쓰지 않는다.
6. poll queue의 CPU mapping은 generic blk_mq_map_queues()를 사용한다.
```

## Step 4로 넘길 쟁점

Step 4에서 hook 후보를 평가할 때 반드시 이 점을 반영해야 한다.

```text
PAS-only:
  이미 poll queue로 들어온 I/O에 대해 sleep-before-poll을 넣으면 되므로
  bio_poll() 또는 blk_mq_poll() 근처 hook이 현실적이다.

Full DPAS interrupt mode:
  "poll completion을 하지 않는다"만으로는 진짜 interrupt queue 사용이 아니다.
  REQ_POLLED 설정 또는 HCTX_TYPE_POLL 선택을 submission side에서 제어해야 할 수 있다.

NVMe queue remapping:
  최신 NVMe driver는 poll queue와 non-polled queue를 분리한다.
  다만 poll queue는 IRQ affinity가 없으므로, DPAS가 논문처럼 interrupt/poll queue를
  적극적으로 오가려면 queue mapping 정책을 별도로 설계해야 한다.
```

## 이식 범위 판단

중요한 결론:

```text
HCTX_TYPE_POLL 기반 queue mapping 자체는 이식 대상이 아니다.
이미 최신 kernel에 같은 구조가 있다.
```

5.18 DPAS artifact와 최신 kernel 모두 다음 구조를 공유한다.

```text
REQ_POLLED -> HCTX_TYPE_POLL
HCTX_TYPE_POLL용 blk-mq map 존재
NVMe poll_queues 별도 관리
poll queue는 IRQ affinity 없이 blk_mq_map_queues() 사용
```

따라서 Part 4 PAS-only 포팅에서 하지 말아야 할 일:

```text
1. HCTX_TYPE_POLL infrastructure를 다시 만들기
2. NVMe poll_queues 계산 로직을 복사해서 덮어쓰기
3. nvme_pci_map_queues()의 poll queue branch를 불필요하게 수정하기
4. poll queue와 default queue의 기본 분리 구조를 새로 설계하기
```

Part 4에서 실제로 이식해야 할 것은 queue mapping이 아니라 그 위의 policy다.

```text
이식하지 않을 것:
  - HCTX_TYPE_POLL queue type
  - NVMe poll queue allocation/mapping
  - poll queue의 IRQ affinity 제외 처리

이식할 것:
  - PAS sleep-before-poll
  - PAS duration update state
  - sleep 후 poll 결과 update
  - 최소 pas_enabled sysfs/control path
```

즉 Step 3에서 queue mapping을 확인하는 이유는 “이 코드를 옮기기 위해서”가 아니다. 최신 kernel에 이미 있는 기반 구조를 확인하고, Part 4 범위를 PAS-only policy layer로 좁히기 위해서다.

## 다음에 읽을 위치

Step 3의 최신 kernel queue mapping 쪽은 1차로 충분하다. 더 깊게 볼 경우 다음 위치를 확인한다.

```text
src/linux-upstream/block/blk-mq.c
  - blk_mq_alloc_map_and_rqs()
  - hctx allocation / ctx->hctxs[] 초기화 흐름

src/linux-upstream/drivers/nvme/host/pci.c
  - nvme_setup_io_queues()
  - nvme_setup_irqs()
  - nvme_create_io_queues()

src/linux-upstream/drivers/nvme/host/core.c
  - HCTX_TYPE_POLL request 처리 차이
```
