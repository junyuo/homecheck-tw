# AGENTS.md

## Operating Mode

Use low-token, minimal-diff mode by default.

## General Rules

- Do not scan the entire repository unless explicitly requested.
- Read only files directly related to the task.
- Before editing, briefly state the intended files and changes.
- Prefer minimal changes over broad refactoring.
- Do not rename files, restructure folders, or change architecture unless explicitly requested.
- Do not add new dependencies unless there is no reasonable built-in alternative.
- Do not modify formatting-only unrelated files.
- Do not run full test suites unless explicitly requested.
- Prefer targeted checks, type checks, lint checks, or single-script validation.
- Stop after completing the requested task.

## Response Format

After each task, respond with:

1. Files changed
2. Summary of changes
3. Validation performed
4. Remaining risks or next steps

## Project Style

- Keep data files under `public/data`.
- Keep scripts under `scripts`.
- Use Taiwan timezone where relevant.
- For numeric dashboard values, align numbers to the right and format with thousands separators.
- Data update scripts must include bounded retry logic, max 3 attempts.
- Never implement infinite loops.
