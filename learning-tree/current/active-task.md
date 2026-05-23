# Active Task: DPAS kernel-first learning tree v0

## 상태

`/home/clip968/DPAS_FAST26/learning-tree`에 DPAS migration 학습 지도 local copy를 세팅했습니다.

## 이번 v0의 중심

- Part 순서가 아니라 kernel 용어와 경로를 기본 축으로 둡니다.
- Step 1의 핵심 오해를 먼저 제거합니다.
- `bi_cookie != tag`
- `bi_cookie = hctx->queue_num`
- `BLK_QC_T_NONE(-1)`이면 poll 불가
- submit 시점과 poll 시점을 분리합니다.

## 현재 카드 축

- Kernel object cards: `bio`, `request`, `hctx`, `REQ_POLLED`, `bi_cookie/tag`
- Polling path cards: `bio_poll`, `blk_mq_poll`, `blk_hctx_poll`, `nvme_poll`
- Migration cards: PAS hook, DPAS mode, interrupt-mode risk
- Validation cards: FIO validation

## 다음 후보

- Linux 5.18 원본 artifact에서 PAS hook 위치 추출
- Part 8/9 안정화 내용 카드화
- Step 1 ASCII visual model 강화
- local `npm install && npm run build` 검증
