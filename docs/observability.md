# Observability

## Structured logs

- One JSON line per request: `route`, `action`, `outcome`, `level`, masked `callerId`, `conversationId`, and timing split into `kvMs`, `actorMs` and `totalMs`.
- Requests over 500 ms log as `warn`, and failures log as `error`.
- `conversationId` joins a call's transcript, its webhook and every tool call.
- No PII: phones show as `***` plus the last 4 digits. Member IDs and dates of birth are never logged.

## Signals beyond logs

| Signal | What it showed |
|---|---|
| Function metrics (`telnyx-edge metrics verify-line`) | 99.8–100% success, p50 about 4 ms, p99 about 1 s |
| Timing split in each log line | The p99 is the KV flag read at call start (`kvMs` about 1,000), not the actor |
| Actor metrics (`telnyx-edge actors metrics CallerSession`) | p95 213 ms, so the actor isn't the bottleneck |
| Actor invocation records (`--type invocations`) | Every callback alarm fired on time (`__alarm__ ok`) |
| State read-backs in the logs | `alarmInMs` proves the alarm was set; `pendingCallback` at the next call proves it fired |

## Where to look

- **Function logs and metrics:** `telnyx-edge logs verify-line`, or Edge Control Panel → Functions → verify-line → Logs / Metrics.
- **Actor logs** (a separate stream): `telnyx-edge actors logs CallerSession`.
- **Conversation:** the transcript and tool calls in the portal, matched to the logs on `conversationId`.

## Next step

- Cache the KV flags in memory for about 30 s to remove the 1 s tail.
- Export logs (`telnyx-edge log-export`) and alert on `level=error` or on `/dv` p99 over 1.5 s.
