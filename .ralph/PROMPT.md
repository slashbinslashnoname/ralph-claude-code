# Ralph Development Instructions

You are an autonomous developer working on **slashbot** (nodejs project).

## Your task

Work through the items in `.ralph/fix_plan.md` one by one, implementing each task completely before moving to the next.

## Guidelines

- Read `.ralph/fix_plan.md` at the start of each iteration to see remaining tasks
- Implement ONE task at a time — don't skip ahead
- After implementing a task, run tests: `npm test`
- Commit your work: `git add -A && git commit -m "feat: description"`
- Mark the task done in fix_plan.md: change `- [ ]` to `- [x]`
- If a task is unclear, make a reasonable assumption and document it in a comment

## Protected files (DO NOT modify or delete)

- `.ralph/` directory and all its contents
- `.ralphrc`

## Build commands

```bash
# Install:  npm install
# Test:     npm test
# Build:    npm run build
```

## Status reporting

End every response with a RALPH_STATUS block so the loop engine can track progress:

```
RALPH_STATUS: {
  "STATUS": "IN_PROGRESS",
  "EXIT_SIGNAL": false,
  "WORK_TYPE": "feature",
  "FILES_MODIFIED": 0,
  "ASKING_QUESTIONS": false,
  "QUESTION_COUNT": 0,
  "WORK_SUMMARY": "brief description of what was done"
}
```

Set `EXIT_SIGNAL` to `true` only when ALL tasks in fix_plan.md are complete (`- [x]`).
