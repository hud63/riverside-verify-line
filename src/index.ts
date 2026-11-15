import { handleMcp } from "./mcp";

export { CallerSession } from "./caller-session";

export interface LogEntry {
  ts: string;
  requestId: string;
  route: string;
  level: string;
  [key: string]: unknown;
}

export async function timed<T>(entry: LogEntry, field: "kvMs" | "actorMs", fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await fn();
  entry[field] = ((entry[field] as number) ?? 0) + (Date.now() - start);
  return result;
}

export function maskPhone(phone: string): string {
  return "***" + phone.slice(-4);
}

// Actor instance names show up in platform invocation logs, so never use the raw phone number:
// SHA-256 of the digits, rendered as decimal so the name stays digits-only (the alarm reminder name rejects "+").
// Normalizing to digits first makes "+1 786..." from Telnyx and "(786) ..." from the LLM hit the same actor.
export async function callerKey(phone: string): Promise<string> {
  const digits = phone.replace(/\D/g, "");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(digits));
  const hex = Array.from(new Uint8Array(hash).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return BigInt("0x" + hex).toString();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      requestId: crypto.randomUUID(),
      route: url.pathname,
      level: "info",
    };
    const t0 = Date.now();
    let response!: Response;

    try {
      if (req.method === "POST" && url.pathname === "/dv") {
        response = await handleDynamicVariables(req, env, entry);
      } else if (req.method === "POST" && url.pathname === "/mcp") {
        response = await handleMcp(req, env, entry);
      } else if (req.method === "POST" && url.pathname === "/admin/reset") {
        response = await handleReset(req, env, entry);
      } else if (req.method === "GET" && url.pathname === "/health") {
        response = Response.json({ status: "ok", timestamp: new Date().toISOString() });
      } else if (req.method === "GET" && url.pathname === "/") {
        entry.action = "index";
        entry.outcome = "ok";
        response = Response.json({ service: "Riverside Verify Line", description: "Telnyx Voice AI insurance eligibility assistant: dynamic-variables webhook, MCP server and CallerSession actor on a Telnyx Edge Function.", phone: "+1 786 892 9548", routes: { "POST /dv": "dynamic-variables webhook (called by the assistant at call start)", "POST /mcp": "MCP server (JSON-RPC: initialize, tools/list, tools/call)", "GET /health": "health check" }, repo: "https://github.com/hud63/riverside-verify-line" });
      } else {
        entry.outcome = "not_found";
        response = Response.json({ error: "not_found" }, { status: 404 });
      }
    } catch (e) {
      entry.outcome = "error";
      entry.level = "error";
      entry.error = e instanceof Error ? e.message : String(e);
      response = Response.json({ error: "internal_error" }, { status: 500 });
    } finally {
      entry.totalMs = Date.now() - t0;
      if ((entry.totalMs as number) > 500 && entry.level === "info") {
        entry.level = "warn";
      }
      console.log(JSON.stringify(entry));
      response.headers.set("x-request-id", entry.requestId);
    }

    return response;
  },
};

async function handleDynamicVariables(req: Request, env: Env, entry: LogEntry): Promise<Response> {
  const body = await req.json() as {
    data: {
      event_type: string;
      payload: { telnyx_end_user_target: string; call_control_id: string; [k: string]: unknown };
    };
  };

  const phone = body.data.payload.telnyx_end_user_target;
  const callControlId = body.data.payload.call_control_id;
  entry.callerId = maskPhone(phone);
  entry.callControlId = callControlId;
  entry.action = "beginCall";

  const caller = env.CALLER.idFromName(await callerKey(phone));

  const [actorResult, [humanTransferEnabled, afterHoursMode]] = await Promise.all([
    timed(entry, "actorMs", () => caller.beginCall(callControlId)),
    timed(entry, "kvMs", () => Promise.all([
      env.FLAGS.get("flags/human_transfer_enabled").catch((e: unknown) => { entry.kvError = String(e).slice(0, 120); return null; }),
      env.FLAGS.get("flags/after_hours_mode").catch((e: unknown) => { entry.kvError = String(e).slice(0, 120); return null; }),
    ])),
  ]);

  const humanTransfer = humanTransferEnabled !== "false" && afterHoursMode !== "true";
  entry.outcome = actorResult.isLockedOut ? "locked_out" : "ok";
  entry.pendingCallback = actorResult.pendingCallback;

  return Response.json({
    dynamic_variables: {
      is_locked_out: String(actorResult.isLockedOut),
      is_returning_caller: String(actorResult.isReturning),
      attempts_today: String(actorResult.attempts),
      human_transfer_enabled: String(humanTransfer),
      trace_id: callControlId,
    },
  });
}

// Support/demo endpoint: clears a caller's lockout. Token lives in KV (admin/reset_token), never in code.
async function handleReset(req: Request, env: Env, entry: LogEntry): Promise<Response> {
  entry.action = "resetLockout";
  const expected = await env.FLAGS.get("admin/reset_token");
  const given = req.headers.get("x-admin-token") ?? "";
  if (!expected || given !== expected) {
    entry.outcome = "unauthorized";
    entry.level = "warn";
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as { phone?: string };
  const phone = String(body.phone ?? "");
  if (!phone) {
    entry.outcome = "bad_input";
    return Response.json({ error: "phone is required" }, { status: 400 });
  }
  entry.callerId = maskPhone(phone);
  const caller = env.CALLER.idFromName(await callerKey(phone));
  const result = await timed(entry, "actorMs", () => caller.resetLockout());
  entry.outcome = "ok";
  entry.hadLockout = result.hadLockout;
  return Response.json({ reset: true, hadLockout: result.hadLockout });
}
