# Demo script

Call **+1 786 892 9548**. Each path is one short call (about 1 to 2 minutes).

## What the demo shows

1. **Active coverage.** Recording disclosure (speak node), member lookup through the MCP tool `verify_eligibility`, plan and copay read back, hang-up.
2. **Hand-off to a specialist.** Inactive coverage, then a transfer to a second assistant with a different voice. It already knows the member, passed in code by conversation id (`member_source: "conversation"`).
3. **Callback.** `schedule_callback` books it in the caller's actor. The assistant reads back a reference, and the actor's alarm fires two minutes later.
4. **Kill switch.** With `flags/human_transfer_enabled` set to `false` in KV, asking for a person is refused and a callback is offered instead, with no redeploy. An expression edge enforces this, not the model.
5. **Lockout.** Three failed verifications, counted across calls by the caller's actor. The next call goes straight to the lockout notice.
6. **Observability.** Structured logs stream live while the calls run. Each call's transcript and tool calls match the logs on `conversationId`.

## Try it yourself

| Path | Say after the disclosure |
|---|---|
| Active | "Member ID RVP100234, date of birth April 12, 2016." |
| Inactive → specialist | "Member ID RVP200871, date of birth September 3, 2019." Then: "Can I talk to someone now?" |
| Inactive → callback | Same member. Then: "Just call me back." It reads a reference, then: "No, that's all." |
| Not found / lockout | Any member ID with a wrong date of birth. Three failures lock the number for 30 minutes. |

The flag state decides whether "talk to someone" transfers you or offers a callback. A locked-out number can be cleared with `POST /admin/reset` (see README).
