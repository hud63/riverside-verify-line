# Debugging Narrative: "The kill switch that didn't kill"

> A real bug from the Phase 4 build (2026-11-14), found on a live phone call. It looked like the KV flag was broken. The flag was fine; the routing layer was letting the model overrule it.

---

## The Bug

### What Broke

Operations turned live transfers **off** (`flags/human_transfer_enabled = "false"` in KV). A caller with inactive coverage asked "Can I talk to one now?" and the assistant **transferred them to the specialist anyway**.

### How I Found It

It came up on test call 4, whose whole purpose was to prove the flag works on a real call. I pulled the conversation transcript (`GET /v2/ai/conversations/{id}/messages`) about 15 seconds after hangup:

```
22:05:52 tool       verify_eligibility -> {"status": "inactive", ...}
22:05:53 assistant  "I'm showing that coverage is currently inactive. Would you like me to
                     schedule a callback from a benefits specialist?"       <- callback ONLY
22:06:14 user       "Can I talk to one now?"
22:06:15 assistant  "I'm transferring you to our benefits specialist now, one moment."
22:06:15 tool       get_plan_benefits {} -> member_source: "conversation"   <- specialist is live
```

The first assistant line is the key clue. It offered **only** a callback, which it does only when `{{human_transfer_enabled}}` is `false`. So the flag had been read from KV by the `/dv` webhook, returned as a dynamic variable, and injected into the prompt. The data path was fine. Something downstream had ignored it.

The `/dv` log line for that call confirmed the webhook succeeded (`"outcome":"ok"`, `"kvMs":1041`), with no `kvError`.

### Root Cause

The transfer route was an **LLM-condition edge**:

```json
{ "id": "specialist_now", "start_node_id": "resolve",
  "target": { "node_id": "transfer_notice" },
  "condition": { "type": "llm",
    "prompt": "The caller wants to speak with a specialist now, and specialist transfer is available." } }
```

On voice calls, Telnyx exposes each LLM edge to the model as a tool named `transition__<edge_id>`, with the edge prompt as its description (per the Telnyx workflows docs, "LLM conditions"). The model chose to call `transition__specialist_now` because the caller clearly wanted a specialist. It treated "and specialist transfer is available" as soft context, not a hard gate.

In other words, **a business rule (a kill switch) was enforced by a natural-language suggestion to the model.** The flag reached the model. The model still decided.

### The Fix

Telnyx edges also support **variable-comparison conditions**, which the platform evaluates against dynamic variables, not the model. Per the docs, on calls these are evaluated *before* the model turn and take precedence over LLM edges.

I added a speak-node gate in front of every route to the specialist:

```diff
  { "id": "specialist_now", "start_node_id": "resolve",
-   "target": { "type": "node", "node_id": "transfer_notice" }, ... }
+   "target": { "type": "node", "node_id": "transfer_gate" }, ... }

+ { "id": "transfer_gate", "type": "speak", "message": "One moment." }
+ { "id": "no_transfer",   "type": "speak",
+   "message": "Live transfers aren't available right now, so I can set up a callback for you instead." }

+ { "id": "gate_transfer", "start_node_id": "transfer_gate", "target": { "node_id": "transfer_notice" },
+   "condition": { "type": "expression", "expression": { "type": "comparison", "op": "==",
+     "left": { "type": "variable", "name": "human_transfer_enabled" },
+     "right": { "type": "string_literal", "value": "true" } } } }
+ { "id": "gate_no_transfer", "start_node_id": "transfer_gate", "target": { "node_id": "no_transfer" },
+   "condition": { "type": "default" } }
+ { "id": "no_transfer_back", "start_node_id": "no_transfer", "target": { "node_id": "resolve" },
+   "condition": { "type": "default" } }
```

The same gate now covers the **lockout route**: `lockout_notice` → `transfer_notice` only when the flag is `"true"`, otherwise → `no_transfer`. Before, a locked-out caller was handed to the specialist unconditionally, even with transfers off.

The model can still *ask* to transfer. It can no longer *cause* one when the switch is off.

### Evidence Trail

```
Before (22:06, flag = false)
  22:06:14 user       "Can I talk to one now?"
  22:06:15 assistant  "I'm transferring you to our benefits specialist now, one moment."   <- WRONG

After (22:35, flag = false, same caller, same member)
  22:35:37 user       "Can I talk to a specialist now?"
  22:35:37 assistant  "One moment.
                       Live transfers aren't available right now, so I can set up a callback for you instead."
  22:35:53 tool       schedule_callback -> cb_c169d215
  22:35:57 tool       hangup -> ok
```

Timeline:
- **22:06:15** symptom (wrong transfer)
- **22:06:29** transcript pulled; the callback-only offer pins the flag as delivered
- **22:07:14** root cause confirmed in the docs (LLM edges are model tool choices; expression edges are evaluated by the platform), fix specified
- **22:08:23** fix live (10 nodes / 16 edges; `lockout_transfer` and `gate_transfer` read back from the API)
- **22:35** verified on a real call

**Symptom to root cause: about 1 minute. Symptom to fix live: about 2 minutes.**

### What I Instrumented Beforehand That Made This Findable

- **The flag is visible in the transcript itself.** Because the verify node's wording branches on `{{human_transfer_enabled}}`, the assistant's first offer proves which value the call received. That one line ruled out the KV, webhook and dynamic-variable path in seconds.
- **Structured `/dv` logs** (`outcome`, `kvMs`, and after this session, `kvError`) confirmed the webhook succeeded for that call.
- **`member_source` in the `get_plan_benefits` response** proved the call had actually reached the specialist, rather than the main assistant just *saying* "transferring".

### The Lesson I'd Tell a Customer

> Anything that's a **policy** (compliance, a kill switch, an attempt limit) belongs in a deterministic condition or in code, not in a prompt. Use LLM edges for *intent* ("does the caller want a specialist?"). Use expression edges for *permission* ("are transfers allowed right now?"). Chain them: the model decides what the caller wants, and the platform decides whether it's allowed.

---

## Bonus: the alarm that "never fired" (it did)

**Symptom:** after a callback was booked, the `callback_due` log from the actor's `alarm()` handler never appeared in `telnyx-edge logs verify-line`. Two minutes, then nine minutes, passed with nothing.

**What it looked like:** a broken alarm. Earlier in the build I'd hit a real alarm bug: actor ids containing `+` (from E.164 phone numbers) are rejected by the alarm reminder name, and the fix is `callerKey()` stripping non-digits.

**What it actually was:** nothing was broken. I proved it in two steps:
1. I added a read-back. `scheduleCallback` now returns `await this.ctx.storage.getAlarm()`, logged as `alarmInMs: 119836`, so the alarm was set.
2. I added state to the `/dv` log. `beginCall` now reports `pendingCallback`. A probe call showed `{"status":"due","alarmAt":null}`: the handler **had run** and flipped the status.

So the handler ran, but its log line was missing. The Telnyx Stateful Actors observability docs explain why: `console.log` inside an actor goes to a **separate stream**, `telnyx-edge actors logs CallerSession`, not the function's logs. There, every alarm was on time:

```
21:09:12.231Z  callback_due cb_d72694a3        __alarm__ ok 127ms
21:17:57.798Z  callback_due cb_c64133be        __alarm__ ok 71ms
21:24:01.295Z  callback_due cb_2681a906        __alarm__ ok 73ms
```

**Lesson:** "no log line" is not "didn't happen". Know which process writes which stream. Function logs, actor runtime logs and actor invocation logs (`--type invocations`, one platform record per method call, including `__alarm__`) are three different places.
