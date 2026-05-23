# DPAS Migration Learning Tree 진행 상황

작성일: 2026-05-23

## 한 줄 요약

기존 `learning-tree` 구조를 바탕으로 DPAS migration을 이해하기 위한 kernel-first 학습지도를 `/home/clip968/DPAS_FAST26/learning-tree`에 배치했습니다.

## 현재 목표

```text
DPAS 논문과 Notion migration notes를 바로 구현 단계로 외우지 않고,
먼저 kernel 객체와 경로를 이해한 뒤 PAS/DPAS hook 위치와 검증 계획으로 넘어가는 학습 지도 만들기.
```

현재 v0는 Step 1에서 계속 헷갈렸던 blk-mq polling path를 중심으로 잡았습니다.

핵심 기준:

- kernel 용어 먼저: `bio`, `request`, `hctx`, `REQ_POLLED`, `bi_cookie`, `tag`
- 코드 흐름 다음: submit 시점에서 cookie가 생기고, poll 시점에서 cookie로 hctx를 다시 찾는 구조
- migration은 그 다음: PAS sleep-before-poll hook, DPAS mode switching, interrupt-mode risk
- 검증은 마지막: FIO로 mode별 latency/CPU/IOPS 차이를 확인

## 반영된 파일

- `src/knowledge-graph/cards.ts`: DPAS/blk-mq/NVMe polling 중심 카드 v0
- `src/knowledge-graph/edges.ts`: kernel 객체, 코드 경로, 논문 대응, migration risk 관계
- `src/knowledge-graph/types.ts`: DPAS용 edge kind 확장
- `src/knowledge-graph/labels.ts`: 관계 필터 label/설명 확장
- `src/knowledge-graph/paths.ts`: kernel-first 학습 경로 재구성
- `src/knowledge-graph/updates.ts`: DPAS용 update candidate reset
- `src/App.tsx`: 앱 제목/검색 placeholder/관계 class 매핑 DPAS 기준으로 정리
- `README.md`: repo 목적을 DPAS Migration Learning Tree로 재작성
- `current/active-task.md`: 현재 작업 상태를 DPAS 기준으로 갱신
- `raw-index/source-map.md`: Notion Part 1-9와 local kernel source 후보 맵 정리

## 아직 검증하지 못한 것

`npm install`과 `npm run build`는 아직 실행하지 않았습니다. 의존성 설치에는 네트워크가 필요할 수 있습니다.
