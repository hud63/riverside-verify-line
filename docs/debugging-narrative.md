# The kill switch that didn't kill

## What broke

- Live transfers were switched off in KV (`flags/human_transfer_enabled = "false"`).
- A caller with inactive coverage asked "Can I talk to one now?"
- The assistant transferred them to the specialist anyway.

## How I found it

- I pulled the conversation transcript right after the call:

```
assistant  "...Would you like me to schedule a callback from a benefits specialist?"   <- callback only
user       "Can I talk to one now?"
assistant  "I'm transferring you to our benefits specialist now."
tool       get_plan_benefits -> member_source: "conversation"   <- specialist is live
```

- The first line was the clue. The assistant offers only a callback when the flag is `false`, so the flag had reached it.
- The `/dv` log for that call showed `outcome: ok` with no `kvError`. The KV read and webhook were fine.

## Root cause

- The transfer route was an **LLM edge**, and Telnyx gives each LLM edge to the model as a tool (`transition__specialist_now`).
- The caller clearly wanted a specialist, so the model called that tool. It treated "transfer is available" as a hint, not a rule.
- A kill switch was being enforced by a sentence in a prompt.

## Fix

- I added a speak node, `transfer_gate`, in front of every route to the specialist.
- Out of it, an **expression edge**: `human_transfer_enabled == "true"` goes to the transfer.
- The default edge goes to "Live transfers aren't available right now, so I can set up a callback for you instead."
- Telnyx evaluates expression edges before the model turn, so the model can't override them.
- The same gate now covers the lockout route, which had also been transferring callers unconditionally.

```json
{ "id": "gate_transfer", "start_node_id": "transfer_gate", "target": { "node_id": "transfer_notice" },
  "condition": { "type": "expression", "expression": { "type": "comparison", "op": "==",
    "left": { "type": "variable", "name": "human_transfer_enabled" },
    "right": { "type": "string_literal", "value": "true" } } } }
```

## Proof

```
user       "Can I talk to a specialist now?"
assistant  "One moment. Live transfers aren't available right now, so I can set up a callback for you instead."
tool       schedule_callback -> booked
tool       hangup -> ok
```

- About 1 minute from symptom to root cause, and about 2 minutes to the fix being live.
- Verified on a real call: same caller, same member, flag off.

## What made it findable

- The assistant's wording depends on the flag, so the transcript shows which flag value the call got.
- `/dv` logs record `outcome`, `kvMs` and `kvError` for every call.
- `member_source: "conversation"` proved the call really reached the specialist.

## Lesson

- Policy (kill switches, limits, compliance) belongs in expression edges or code, not prompts.
- LLM edges decide **intent**. Expression edges decide **permission**.

---

## Bonus: the alarm that "never fired"

- **Symptom:** the alarm's `callback_due` log line never appeared in the function logs.
- **Check 1:** `scheduleCallback` reads the alarm back after setting it (`alarmInMs: 119836`), so the alarm was set.
- **Check 2:** the next call's `/dv` log showed `pendingCallback.status: "due"`, so the handler had run.
- **Cause:** an actor's `console.log` goes to its own stream, `telnyx-edge actors logs CallerSession`. Every alarm there fired on time.
- **Lesson:** "no log line" doesn't mean "didn't happen". Check which stream a process writes to.
