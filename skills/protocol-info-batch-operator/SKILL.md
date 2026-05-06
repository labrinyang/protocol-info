---
name: protocol-info-batch-operator
description: Focused sub-skill selected by protocol-info-router for long protocol-info batches, manual queues, background crawls, ScheduleWakeup/task-notification issues, stuck crawls, killed batches, and throughput diagnosis. Use after the router chooses the batch-operations path. Do not use for one-off crawls or record-field edits.
user-invocable: false
---

# Protocol-info batch operator

This is a focused sub-skill. If you arrived here directly and the request is a
normal one-off crawl or existing-record edit, switch to the `protocol-info-router`
router skill first.

Use this skill when the user is coordinating many protocol-info crawls and the
problem is orchestration, queueing, background tasks, or throughput. The normal
tool surface is still `/protocol-info:protocol-info`; this skill decides how to
pace and observe the work.

## Preferred execution

Prefer one slash-command invocation with built-in batching when the user gives a
known protocol list:

```
/protocol-info:protocol-info --parallel 4 --i18n none \
  --batch --display-name "Pendle" \
  --batch --display-name "Morpho"
```

Use `--parallel min(N_providers, 4)` unless the user gives a different
parallelism. Avoid hand-rolling per-protocol shell loops when the built-in batch
mode is enough.

## Manual background queue

If you are manually feeding one protocol at a time in background commands, rely
on the background task completion notification to start the next protocol
immediately. Do not pace the queue with fixed `ScheduleWakeup` delays such as
40 minutes; that can add large idle gaps after runs that already finished.

Scheduled wakeups are only a coarse fallback watchdog for missing task
notifications. They should not be the normal queue driver.

## Diagnosing slow throughput

Before changing timeouts or blaming crawl quality, separate actual crawl runtime
from orchestration idle time:

- compare adjacent `out/.runs/<run-id>/` directory timestamps to estimate actual
  per-protocol runtime;
- check whether a protocol-info process is still alive before waiting longer;
- inspect `out/<slug>/_debug/r1/r1-status.json` only when a current process is
  still running or the run failed;
- remember that stale `*.envelope.json` files are not a reliable "current run
  completed" signal unless their mtime belongs to the active run.

## Stuck runs

R1 writes live subtask telemetry to
`out/<slug>/_debug/r1/r1-status.json`: state, pid, elapsed time, timeout, and
error kind. Claude calls have a default wall-clock watchdog
(`CLAUDE_TIMEOUT_MS`, 15 minutes; `R1_CLAUDE_TIMEOUT_MS` overrides R1), so a
stalled subtask should end as `error_kind=timeout` and allow partial R1
continuation.

If the user asks to kill a current run, first verify the active protocol-info
processes. Kill only the relevant process group and report the exit status.
