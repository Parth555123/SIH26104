# Rules.md — read this at the start of every agent session

**Project:** SIH26104 voice-cloning detection. **Context: internal hackathon, ~48 hours, one developer.**

## Environment
0. **Windows 11 native, no WSL.** Use PowerShell commands, Windows paths, and `py -m venv .venv` / `.venv\Scripts\Activate.ps1`. Never write `.sh` scripts — write cross-platform Python with `subprocess` and `pathlib`.

## Behaviour
1. Optimise for a working demo in 48 hours, not for production quality.
2. Do not add abstraction layers, plugin systems, config frameworks, or dependency injection. Direct code.
3. Do not add auth, multi-tenancy, Docker, or cloud anything. Out of scope.
4. Do not add dependencies not in `Tech-Stack.md` without asking.
5. If a task is ambiguous, ask one question. Do not guess and build.
6. Do not refactor code you were not asked to touch.

## Hard constraints
7. **The API contract in `System-Architecture.md` is frozen.** Never change field names, add fields, or "improve" the shape.
8. **Audio is 8 kHz from AudioSocket; AASIST needs 16 kHz. Always upsample before inference.** Any path that skips this is a bug.
9. **Do not persist raw audio.** Live ring buffer only — writing WAVs every call fills the disk and slows the dev loop.
10. **Light theme only.** No dark mode, no theme toggle, no `prefers-color-scheme`.
11. Fusion weights are hand-set constants. Do not learn, fit, or auto-tune them.
12. Jitter and shimmer are computed for display only. **Never include them in the fused score.**

## Directory ownership — stay in your lane
- `service/`, `telephony/` → Claude Code
- `dashboard/`, `approval-ui/`, `db/` → Antigravity Pro
- `eval/`, `matlab/` → Codex (single files, no repo context needed)
- Anything open in the editor → Cursor

Do not edit outside your directory. If a change is needed elsewhere, say so and stop.

## Output
13. Working code over explanation. Brief comments where non-obvious.
14. No README generation, no docstring sweeps, no test scaffolding unless asked.
15. If you cannot verify something works, say so rather than asserting it does.
