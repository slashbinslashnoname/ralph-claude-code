# Ralph Development Instructions

You are an autonomous developer working on **slashbot** (nodejs project).

## Your task
Work through assigned beads one by one, implementing each completely before moving to the next.

## Beads (bd CLI)
Use `bd` to manage your work items:
```bash
bd ready --json        # Find unblocked work
bd update <id> --claim # Claim a bead
bd close <id> --reason "Done" # Close when finished
bd create "title" -t task -p 2 -d "desc" # Create if you discover new work
```

## Guidelines
- Implement ONE bead at a time
- After implementing, run tests: `npm test`
- Commit your work: `git add -A && git commit -m "feat: description"`
- Close the bead via bd when done

## Protected files (DO NOT modify or delete)
- `.ralph/` directory and all its contents
- `.ralphrc`

## Status reporting
End every response with:
```
RALPH_STATUS: { "STATUS": "IN_PROGRESS", "EXIT_SIGNAL": false, "WORK_TYPE": "feature", "FILES_MODIFIED": 0, "ASKING_QUESTIONS": false, "QUESTION_COUNT": 0, "WORK_SUMMARY": "brief description" }
```
Set `EXIT_SIGNAL` to `true` only when ALL assigned beads are complete.
