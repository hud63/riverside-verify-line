# Riverside Verify Line

A voice assistant that verifies a pediatric patient's insurance eligibility over the phone. It is built on Telnyx Voice AI (a conversation workflow plus a hand-off to a second assistant), a custom MCP server and a StatefulActor running on a Telnyx Edge Function, with KV feature flags. All code was written through OpenCode with Telnyx-hosted Kimi-K2.6.

| | |
|---|---|
| **Phone** | +1 786 892 9548 |
| **Edge Function** | `https://verify-line-9f348eb3-0.telnyxcompute.com` |
| **Routes** | `POST /dv` (dynamic-variables webhook) · `POST /mcp` (MCP server) · `POST /admin/reset` (support) · `GET /health` |
| **Main assistant** | `assistant-57e256d2-93ac-49e0-ae12-9e8ff11c1da7`, "Riverside Verify Line" (config: `workflow.json`) |
| **Specialist** | `assistant-6a391369-bd94-4446-a17a-8ad896efe50e`, "Riverside Benefits Specialist" (config: `specialist.json`) |
| **How to test** | [`DEMO.md`](DEMO.md): what the demo shows and what to say on each path |

---

## Architecture

```
 Caller ──► Telnyx number ──► Main assistant (conversation workflow)
                                 │  call start
                                 ├──────────────► POST /dv ──► KV FLAGS  (human_transfer_enabled, after_hours_mode)
                                 │                         └─► CallerSession actor [hash(phone)]
                                 │                              attempts · lockout · returning caller · pending callback
                                 │  tools (MCP, _meta.telnyx_conversation_id on every call)
                                 ├──────────────► POST /mcp
                                 │                 verify_eligibility ─► actor[hash(phone)].recordAttempt
                                 │                                    └► actor[conv id].rememberMember
                                 │                 schedule_callback ─► actor[hash(phone)].scheduleCallback ─► alarm() in 2 min
                                 │                 get_plan_benefits ─► actor[conv id].getMemberId
                                 │
                                 └─ hand-off (distinct voice) ──► Specialist assistant
                                                                   get_plan_benefits {} → member_source: "conversation"
```

### Choosing the right primitive

| Need | Primitive | Why |
|---|---|---|
| Ops switches that change behaviour with no deploy | **KV** (`flags/human_transfer_enabled`, `flags/after_hours_mode`) | Read once per call in `/dv`, exposed as dynamic variables, enforced by **expression edges** |
| Per-caller state that must be consistent (attempt counter, 30-min lockout) | **StatefulActor** keyed by `hash(phone)` | Single-threaded per caller, durable storage, no race between concurrent calls |
| Deferred work (callback due in 2 min) | **Actor alarm** | Survives restarts, wakes a sleeping instance, at-least-once delivery |
| Passing the verified member to the specialist **in code, not the prompt** | **StatefulActor** keyed by Telnyx's `conversation_id` | The conversation id is the same across the assistant hand-off; the specialist calls `get_plan_benefits` with no arguments |
| Verbatim compliance lines (recording disclosure, transfer notice) | **Speak nodes** | Exact wording, not left to the model |
| Policy (transfers allowed? caller locked out?) | **Expression edges** on dynamic variables | Evaluated by Telnyx before the model turn; the model can't override them |
| Intent (does the caller want a specialist / a callback?) | **LLM edges** | Natural-language judgement |

### Workflow (main assistant)

`disclosure` (speak) → `locked_out`? → `lockout_notice` · STIR/SHAKEN not "A"? → `caller_id_check` · else → `collect` → `verify` (MCP `verify_eligibility`) → active: plan + copay → `goodbye` (hang-up tool node) · inactive / not found twice / caller asks → `resolve` → callback (`schedule_callback`, spoken reference, hang up) or specialist → `transfer_gate` → **`human_transfer_enabled == "true"`** → `transfer_notice` → specialist; otherwise → `no_transfer` → back to `resolve`.

10 nodes, 16 edges. Both routes to the specialist (normal and lockout) pass the same expression gate.

### Data handling

- Phone numbers: actor instance names are a SHA-256 of the digits, because instance names appear in platform invocation logs. Function logs carry `***` plus the last 4 digits only.
- Member IDs and dates of birth are never logged.
- The admin reset token lives in KV (`admin/reset_token`) and in the local `.env`, never in code.

---

## Setup

Prerequisites: Node 20+, the `telnyx-edge` CLI, a Telnyx API key in `../.env` (`TELNYX_API_KEY=…`), and OpenCode with the `@telnyx/opencode` plugin (`opencode.jsonc` in this folder).

```sh
npm install
npx tsc --noEmit                      # typecheck
telnyx-edge ship                      # deploy the function + CallerSession actor

# KV flags (namespace in telnyx.toml)
telnyx-edge storage kv key put <ns> flags/human_transfer_enabled true
telnyx-edge storage kv key put <ns> flags/after_hours_mode false
telnyx-edge storage kv key put <ns> admin/reset_token <random-secret>

# Apply assistant configs
curl -X POST https://api.telnyx.com/v2/ai/assistants/<main-id> \
  -H "Authorization: Bearer $TELNYX_API_KEY" -H "Content-Type: application/json" \
  --data-binary @workflow.json
curl -X POST https://api.telnyx.com/v2/ai/assistants/<specialist-id> \
  -H "Authorization: Bearer $TELNYX_API_KEY" -H "Content-Type: application/json" \
  --data-binary @specialist.json
```

**Clear a caller's lockout** (support or demo):
```sh
curl -X POST https://verify-line-9f348eb3-0.telnyxcompute.com/admin/reset \
  -H "x-admin-token: $ADMIN_RESET_TOKEN" -H "Content-Type: application/json" \
  -d '{"phone":"+1XXXXXXXXXX"}'
```

**Test members** (mock data in `src/mcp.ts`): `RVP100234` / 2016-04-12 (active, PPO) · `RVP200871` / 2019-09-03 (inactive, HMO) · eight more.

---

## Observability

Details and real numbers: [`docs/observability.md`](docs/observability.md).

- **Structured logs:** one JSON line per request: `requestId`, `route`, `action`, `outcome`, `level`, masked `callerId`, `callControlId`, `conversationId`, plus timing split into `kvMs`, `actorMs` and `totalMs`. Requests slower than 500 ms are raised to `warn`, and failures to `error`.
- **Signals beyond logs:**
  - **Per-request latency split** across Function → KV → Actor. It showed that the function's p99 of about 1 s is the KV flag read at call start, not the actor (actor p95 is 213 ms).
  - **Platform metrics:** `telnyx-edge metrics verify-line` and `telnyx-edge actors metrics CallerSession`.
  - **Actor invocation records:** one per method call, including `__alarm__`.
  - **State read-backs:** `alarmInMs` when a callback is booked, `pendingCallback` at call start.
- **Proof in the transcript:** `member_source: "conversation"` shows the specialist got the member from server state; `coverage_status` and `spoken_reference` are generated by the server.

### How I'd know within a minute that it's broken, and what I'd look at first

1. **First look:**
   ```sh
   telnyx-edge logs verify-line --since 5m | grep -E '"level":"(error|warn)"'
   ```
   - `/dv` errors mean every call starts on default values.
   - `/mcp` errors mean tools are failing.
   - `kvError` means the flag store is degraded. Calls still work, with transfers defaulting to on.
2. **Is it everyone, or one caller?** Run `telnyx-edge metrics verify-line` and compare the error rate and p99 against the baseline (100% 2xx, p95 134 ms).
3. **Did the conversation do the right thing?** Pull the transcript (`GET /v2/ai/conversations/{id}/messages`) and join it to the logs on `conversationId`. Tool calls and their outputs show which node misrouted.
4. **Alerting** (not yet wired up): `telnyx-edge log-export` pushes these logs to a sink such as Datadog or S3, where an alert on `level=error` or on `/dv` p99 > 1.5 s gives the one-minute signal without anyone watching a terminal.

---

## Debugging story

[`docs/debugging-narrative.md`](docs/debugging-narrative.md): **"The kill switch that didn't kill."** With transfers turned off in KV, a caller who asked for a specialist was transferred anyway.
- **The clue:** the transcript proved the flag had reached the model.
- **The cause:** the transfer was an LLM edge, so the model overruled the policy.
- **The fix:** an expression edge evaluated by Telnyx.
- **The timing:** found in about 1 minute, live in about 2.

Bonus: an alarm that "never fired". It did; its logs go to the actor log stream, not the function's.

---

## Verified on real calls (2026-11-14)

| Path | Result |
|---|---|
| Active member → plan and copay → hang-up | ✅ |
| Inactive → specialist hand-off; specialist reads back the member ID, gives benefits, hangs up | ✅ `member_source: "conversation"` |
| Inactive → callback → reference read one character at a time → alarm fires at +2 min | ✅ `__alarm__ ok` on time |
| Transfers off (KV) → caller asks for a specialist → refused, callback offered | ✅ expression gate |
| 3 wrong DOBs across calls → `locked_out` → call back → lockout notice → specialist, no ID requested | ✅ |

## Built with Telnyx Inference

Every source change went through OpenCode with `telnyx/moonshotai/Kimi-K2.6`, using concrete edit specs, run in the background with a startup watchdog. I reviewed each diff, typechecked, deployed, and verified on a call or with a direct endpoint test.
