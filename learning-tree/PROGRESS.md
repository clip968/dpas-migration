# DPAS Migration Learning Tree 진행 상황

작성일: 2026-06-17

## 한 줄 요약

`history/`의 최신 코드 변경 흐름에 맞춰 learning tree를 kernel-first v0에서 **current code-change map**으로 보강했습니다.

## 현재 목표

```text
이미 구현된 dpas-kernel 변경을 직관적으로 복구할 수 있게 만든다.
어려운 state machine 설명보다 "어느 파일이 어떤 책임을 맡는가"를 먼저 보여 준다.
```

이번 sync의 중심:

- `request_queue` direct DPAS fields
- `blk_dpas_prepare_bio()` submit-time gate
- `switch_enabled` sysfs reset window
- `blk_dpas_maybe_switch_mode()` poll-time transition
- `full_mode_switching_static.py` 구조 검증
- Optane mode별 sysfs knob reset 보정
- Colima/Docker 기반 `bzImage` 빌드 루프

## 반영된 파일

- `src/knowledge-graph/cards/drafts/dpas-policy.ts`: 실제 7.1 submit helper와 direct-field mode switching 카드 추가.
- `src/knowledge-graph/cards/drafts/step4-diff-decision.ts`: stale state-placement 계획을 현재 direct-field 구현 설명으로 교체.
- `src/knowledge-graph/cards/drafts/validation.ts`: static test, Optane knob reset, Colima build loop 카드 추가.
- `src/knowledge-graph/cards/visuals/dpas.ts`: 최신 코드 변경을 ASCII 흐름도로 설명하는 visual 추가.
- `src/knowledge-graph/cards/visuals/step4.ts`: Step 4 visual을 현재 코드 상태 기준으로 갱신.
- `src/knowledge-graph/cards/evidence.ts`: 2026-06-12/13/15/17 history source 추가.
- `src/knowledge-graph/edges.ts`: 새 카드들을 direct-field, submit helper, validation, runtime gap 흐름에 연결.
- `src/knowledge-graph/paths.ts`: `현재 코드 변경 따라가기` learning path 추가.
- `src/knowledge-graph/updates.ts`: 다음 후보를 VM boot/runtime sysfs/HIPRI evidence 중심으로 갱신.
- `src/knowledge-graph/graph-data.test.ts`: 최신 카드 존재와 stale Step 4 설명 제거를 검증하는 테스트 추가.

## 아직 검증하지 못한 것

현재 `learning-tree/node_modules`가 없어 `npm test`는 `vitest: command not found`에서 멈췄습니다.

필요한 확인:

```bash
cd learning-tree
npm install
npm test
npm run build
```
