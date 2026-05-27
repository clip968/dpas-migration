# DPAS_FAST26 Agent Instructions

## Decision Authority

- Codex must not make implementation, architecture, migration-order, scope, or tradeoff decisions on its own.
- The user is the decision maker for all non-mechanical choices.
- Before changing code behavior, kernel structure, migration direction, public interfaces, build configuration, or test strategy, Codex must present the relevant options and wait for explicit user approval.
- Codex may still inspect files, summarize current state, run read-only searches, and run user-approved verification commands without treating those as design decisions.
- If a task has an obvious mechanical edit requested by the user, keep the edit limited to that exact request and do not expand scope.
- If prior plans, Notion pages, memory, local code, or earlier assistant statements conflict with the user's latest direction, follow the user's latest direction and call out the conflict.

## Post-Edit Reporting

After any code modification, Codex must clearly report:
- What was changed.
- How it was changed, including the important files/functions touched.
- Why the change was made.
- The expected effect, benefit, or improvement from the change.
- What verification was run and what the result was.
- A recap of the next work that should be done after this change.

<!-- serena -->
Use Serena MCP for semantic code navigation and symbol-level code edits when it improves accuracy or context efficiency. Do not use Serena automatically for every task.

If Serena MCP is unavailable, disabled, or not initialized for the current project, continue with normal Codex tools instead of blocking the task.

Use Serena when the task involves: finding an unknown implementation location, understanding cross-file feature flow, inspecting symbol references/call sites, refactoring classes/functions/types, renaming symbols, or debugging behavior where the relevant files are unclear.

Do not use for: exact-path small edits, simple markdown/docs/config changes, dependency installation, running tests, reading logs, writing scripts from scratch, or general programming explanations.

## Steps

1. Decide whether the task is local or semantic.
   - If the user gives an exact file path and the change is small, use normal file read/edit tools first.
   - If the location, symbol, or cross-file impact is unclear, use Serena early.

2. Locate code semantically.
   - Use Serena symbol search or file symbol overview before reading large files.
   - Prefer symbol-level lookup over broad grep when searching for classes, functions, methods, types, handlers, services, or commands.

3. Check impact before editing.
   - For refactors, public APIs, renamed symbols, or behavior changes, inspect references/call sites first.
   - Do not perform broad renames or symbol-body replacements without checking usages.

4. Edit precisely.
   - Prefer symbol-level edits when changing a known function/class body.
   - Use normal text edits when the target is simple, local, or not a code symbol.

5. Fall back when needed.
   - If Serena results look incomplete, language-server support appears degraded, or the target is not symbol-based, use normal search/read tools.
   - If two normal searches fail to find the relevant code, switch to Serena.

Serena memory should only store stable project facts that will remain useful across sessions. Do not store short-lived task details.
<!-- serena -->

<!-- exa -->
Use Exa MCP for web search when current, external, or source-backed information is needed.
Prefer Exa over generic browsing for targeted research, documentation lookup, and recent facts.
Do not use Exa for purely local repo questions, exact-path code edits, or information already available in provided context.
If Exa is unavailable, continue with other available search or local tools instead of blocking the task.
<!-- exa -->

<!-- CODEGRAPH_START -->
## CodeGraph

Do not use CodeGraph for this project.

The Linux kernel tree is too large for routine CodeGraph indexing in this workspace. Do not initialize `.codegraph/`, do not ask to run `codegraph init`, and do not call `codegraph_*` tools for this repository unless the user explicitly reverses this instruction.

For DPAS kernel migration work, prefer targeted local tools:
- `rg` for symbol/text lookup
- focused file reads around known DPAS migration files
- direct comparison between `kernel/` 5.18 DPAS files and `dpas-kernel/` target files
- compiler/build checks for verification
<!-- CODEGRAPH_END -->
