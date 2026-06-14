---
name: schedule
description: Use the conversation background-process tools to implement scheduling-like behavior. Use when the user asks for reminders, timers, delayed actions, scheduled work, run-later tasks, periodic/repeating checks, countdowns, or "do X at/after/in <time>".
---

# Scheduling with background processes

Implement scheduling-like behavior with `start_background`. Do not claim there is
a separate system scheduler, calendar service, cron service, or durable reminder
system. The available mechanism is a long-running background shell command in
this conversation's sandbox.

## Core pattern

1. Convert the requested time into a delay in seconds using the current time from
   the hidden `[now: ...]` note on the latest user message.
2. If the target time is ambiguous, ask one concise clarification before starting
   anything.
3. Start a background command that waits, then prints a clear completion message.
4. Tell the user the background job was started and include its `bg_...` id.

One-time task:

```bash
sleep <seconds>
echo "Reminder: <what the user asked for>"
```

Periodic task:

```bash
while true; do
  <check-or-action>
  sleep <interval_seconds>
done
```

Use `timeout_seconds` to cap the job lifetime. The maximum is 604800 seconds
(7 days).

## Tool usage

- Use `start_background` to create the scheduled wait/check.
- Use `read_background_log` to inspect a job.
- Use `list_background` to show existing jobs in this conversation.
- Use `kill_background` to stop a running scheduled job.
- Use `run_code` only for quick time calculations or preparing a small helper
  script. The actual waiting/repeating work should be started with
  `start_background`.

## Limits to state when relevant

- The job belongs to this conversation.
- It runs only while the app/server process remains alive.
- If the server restarts, running background jobs are terminated.
- The hard maximum runtime is 7 days.
- The wake-up happens when the background process exits or is killed/times out.

## Examples

Remind in 10 minutes:

```text
start_background({
  "command": "sleep 600; echo \"Reminder: drink water\"",
  "timeout_seconds": 660
})
```

Run a check every 5 minutes for 1 hour:

```text
start_background({
  "command": "for i in {1..12}; do date; <check-command>; sleep 300; done",
  "timeout_seconds": 3900
})
```

For exact clock times, calculate the delay first. If the target time has already
passed today, ask whether the user means the next occurrence unless the wording
clearly implies tomorrow or another date.
