# DPAS Source Map

## Notion sources

- Part 1: migration overview
- Part 2: DPAS paper model
- Part 3: latest Linux blk-mq/NVMe polling path reading
- Step 1: Polled I/O path reading note
- Part 4: Minimal PAS-only port
- Part 5: DPAS mode switching
- Part 6: Full interrupt mode and NVMe queue mapping
- Part 7: FIO microbenchmark and validation
- Part 8/9: stabilization and final report candidates

## Local kernel sources

- `/home/clip968/DPAS_FAST26/src/linux-upstream`
- `/home/clip968/DPAS_FAST26/kernel`

## Card coverage

- Step 1 coverage: `concept-bi-cookie-tag`, `path-submit-polled`, `path-poll-completion`, `function-bio-poll`, `function-blk-mq-poll`, `function-blk-hctx-poll`, `function-nvme-poll`
- Migration coverage: `concept-pas-sleep-before-poll`, `concept-dpas-mode`, `risk-interrupt-submission`
- Validation coverage: `part7-validation`
