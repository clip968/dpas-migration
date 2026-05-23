# Part 2 - DPAS Paper Structure Notes

이 폴더는 DPAS 논문의 핵심 Figure를 최신 Linux kernel 마이그레이션 관점으로 다시 정리한 작업 노트다.

Part 2의 목표는 논문을 처음부터 끝까지 요약하는 것이 아니다. 목표는 Figure 1, 3, 7, 9, 10을 이해해서 나중에 커널 코드에서 어떤 state, flag, counter, hook으로 옮겨야 하는지 설명할 수 있게 만드는 것이다.

## 읽는 순서

1. [Figure 1 - I/O completion method 비교](figure-01-completion-methods.md)
2. [Figure 2 - 기존 sleep estimation 방식의 한계](figure-02-sleep-estimation.md)
3. [Figure 3 - PAS 기본 workflow](figure-03-pas-workflow.md)
4. [Figure 4 - PAS sleep duration 조정 예시](figure-04-pas-adjustment-example.md)
5. [Figure 5 - PAS와 기존 방식의 sleep duration 비교](figure-05-sleep-duration-comparison.md)
6. [Figure 6 - DN/UP ratio 민감도](figure-06-dn-up-ratio.md)
7. [Figure 7 - Extended PAS](figure-07-extended-pas.md)
8. [Figure 8 - HEATUP 민감도 실험](figure-08-heatup-sensitivity.md)
9. [Figure 9 - per-device vs per-core PAS](figure-09-per-core-pas.md)
10. [Figure 10 - DPAS mode transition](figure-10-mode-transition.md)

## 핵심 Figure와 보조 Figure

Notion Part 2의 핵심 범위는 Figure 1, 3, 7, 9, 10이다. 이 다섯 개는 나중에 커널 코드로 옮겨야 할 구조와 직접 연결된다.

Figure 2, 4, 5, 6, 8은 보조 Figure다. 이들은 주로 다음을 설명한다.

- 기존 Linux Hybrid Polling이 왜 부족한가
- PAS가 duration을 실제로 어떻게 움직이는가
- `UP`, `DN`, `HEATUP`, `COOLDN` 같은 파라미터가 왜 그렇게 선택됐는가

따라서 Part 2를 제대로 이해하려면 핵심 Figure를 먼저 보고, 보조 Figure로 직관과 파라미터 선택 이유를 보강하는 순서가 좋다.

## Part 2 완료 기준

- Figure 1을 보고 interrupt, classic polling, hybrid polling의 trade-off를 설명할 수 있다.
- Figure 2를 보고 epoch 기반 sleep estimation이 abrupt latency change에 약한 이유를 설명할 수 있다.
- Figure 3을 보고 PAS가 `UNDER`와 `OVER`만으로 sleep duration을 조정하는 방식을 설명할 수 있다.
- Figure 4, 5, 6, 8을 보고 PAS 파라미터 선택과 동작 직관을 설명할 수 있다.
- Figure 7을 보고 dynamic sensitivity와 concurrent I/O guard가 왜 필요한지 설명할 수 있다.
- Figure 9를 보고 per-device PAS가 concurrent I/O에서 왜 위험한지 설명할 수 있다.
- Figure 10을 보고 DPAS가 언제 classic polling, PAS normal, PAS overloaded, interrupt mode로 이동하는지 설명할 수 있다.
- 각 Figure를 Linux kernel hook 후보와 연결할 수 있다.

## 주요 kernel hook 후보

```text
block layer:
  bio_poll()
  blk_mq_poll()
  blk_mq_submit_bio()

NVMe:
  nvme_poll()
  nvme_pci_map_queues()

state / flags:
  struct bio
  struct request
  struct request_queue
  struct blk_mq_hw_ctx
  REQ_POLLED
  HCTX_TYPE_POLL
```
