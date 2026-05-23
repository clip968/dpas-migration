# DPAS Migration Learning Tree 미해결 질문 목록

작성일: 2026-05-23

## Gap 1: local build verification

상태: 검증 필요

```text
현재 local copy의 graph data와 App.tsx가 실제 Vite build를 통과하는가?
```

필요한 확인:

```bash
npm install
npm run build
```

## Gap 2: Linux 5.18 hook extraction

상태: 미해결

```text
DPAS migration 대상 kernel 5.18 코드에서 PAS sleep-before-poll hook을 정확히 어느 함수/라인에 넣을 것인가?
```

다음에 카드화할 후보:

- 5.18 `bio_poll()`
- 5.18 `blk_mq_poll()`
- 5.18 `blk_hctx_poll()`
- 5.18 NVMe poll queue path
- PAS patch가 실제로 들어갈 최소 diff

## Gap 3: true interrupt mode risk

상태: 검증 필요

```text
DPAS의 true interrupt mode는 completion path에서 poll을 skip하는 것만으로 충분한가,
아니면 submit side에서 REQ_POLLED / queue selection 자체를 바꿔야 하는가?
```

현재 판단:

- `bi_cookie`는 submit 시점에 `hctx->queue_num`으로 정해집니다.
- poll path는 그 cookie로 `q->queue_hw_ctx[cookie]`를 다시 찾습니다.
- 따라서 interrupt mode를 제대로 구현하려면 completion path만 볼 수 없습니다.

## Gap 4: Part 8/9 stabilization cards

상태: 미해결

Part 8/9의 안정화/보고 내용을 현재 kernel-first tree에 붙여야 합니다.

## Gap 5: Step 1 visual model 강화

상태: 미해결

submit path와 poll path를 한 화면에서 더 직관적으로 보여주는 ASCII/flow visual을 강화해야 합니다.
