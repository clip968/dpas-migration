# DPAS Migration Learning Tree 미해결 질문 목록

작성일: 2026-06-17

## Gap 1: learning-tree app verification

상태: 검증 필요

```text
history sync 이후 graph data와 App.tsx가 실제 Vite test/build를 통과하는가?
```

현재 확인:

- `learning-tree/node_modules`가 없어 `npm test`는 `vitest: command not found`로 실패했다.

필요한 확인:

```bash
npm install
npm test
npm run build
```

## Gap 2: VM boot validation

상태: 미해결

```text
Docker/Colima에서 만든 dpas-kernel bzImage가 실제 VM에서 부팅되는가?
```

현재 확인:

- `build/dpas-kernel-vm/arch/x86/boot/bzImage` 생성은 통과했다.
- compile/link와 boot/runtime 동작은 같은 검증이 아니다.

## Gap 3: runtime sysfs validation

상태: 미해결

```text
새 kernel에서 switch_enabled, switch_param*, PAS knobs가 runtime에서 read/write 되고 reset window가 의도대로 동작하는가?
```

확인할 것:

- `switch_enabled` write 시 mode가 PAS로 reset되는지.
- mode/counter/QD/tf가 새 window로 초기화되는지.
- poll-capable queue가 아닌 경우 실패 경로가 안전한지.

## Gap 4: HIPRI runtime mode evidence

상태: 미해결

```text
raw block과 filesystem direct I/O에서 blk_dpas_prepare_bio()와 blk_dpas_maybe_switch_mode()가 실제로 타는가?
```

확인할 것:

- INT mode에서 submit helper가 `IOCB_HIPRI`/`REQ_POLLED`를 제거하는지.
- CP/PAS/OL mode에서 polled submit과 counter 증가가 보이는지.
- PAS sleep 경로에서 QD/tf 표본이 쌓이는지.
- completion 후 CP/PAS/OL/INT 전이 근거가 counter나 trace로 보이는지.

## Gap 5: measurement design

상태: 미해결

Optane 4-mode 결과를 해석하려면 mode별 sysfs knob reset, warmup/preconditioning, jobs/repeats/order를 함께 고정해야 한다.

다음 후보:

- CP/LHP/PAS/INT 실행 전 sysfs 상태표를 카드화.
- repeat/order randomization 또는 Latin square 여부 결정.
- mode counter/trace를 FIO 결과와 함께 저장하는 방식 결정.
