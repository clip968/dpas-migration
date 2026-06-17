# Active Task: DPAS current code-change learning tree sync

## 상태

`/Volumes/CodeCS/dpas-migration/learning-tree`를 2026-06-17 기준 `history/`와 `dpas-kernel` 코드 변경에 맞춰 갱신 중입니다.

## 이번 sync의 중심

- 이미 구현된 코드를 설명합니다. 계획/후보 카드만 늘리지 않습니다.
- 기존 Step 1의 `bio`, `request`, `hctx`, `REQ_POLLED`, `bi_cookie` 설명은 유지합니다.
- 새 내용은 현재 코드 변경 중심입니다.
  - `blk_dpas_prepare_bio()` submit helper
  - `request_queue` direct DPAS fields
  - `switch_enabled` reset window
  - `blk_dpas_maybe_switch_mode()` transition table
  - `full_mode_switching_static.py`
  - Optane mode knob reset
  - Colima/Docker `bzImage` build loop

## 현재 카드 축

- Kernel object cards: 기존 foundation 유지.
- Polling path cards: 기존 Step 1 유지.
- Current code-change cards: 7.1 submit helper, direct-field mode switching.
- Step 4 cards: stale state-placement 계획을 현재 구현 설명으로 교체.
- Validation cards: static test, knob reset, Colima build loop.

## 다음 후보

- 새 `bzImage` VM boot 검증 카드화.
- runtime `switch_enabled`/sysfs read-write 검증 카드화.
- HIPRI raw block과 filesystem DIO에서 submit helper/mode counter가 실제로 타는지 trace 또는 counter 근거 추가.
- `npm install && npm test && npm run build`로 learning-tree app 검증.
