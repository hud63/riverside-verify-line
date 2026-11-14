import { timed, maskPhone, callerKey, type LogEntry } from "./index";

interface Member {
  dob: string;
  status: "active" | "inactive";
  planName: string;
  groupNumber: string;
  copayPrimary: number;
  copaySpecialist: number;
  deductible: number;
  deductibleMet: number;
  outOfPocketMax: number;
  network: string;
}

const MEMBERS: Record<string, Member> = {
  RVP100234: { dob: "2016-04-12", status: "active", planName: "Blue Shield PPO Gold", groupNumber: "GRP001", copayPrimary: 25, copaySpecialist: 40, deductible: 1500, deductibleMet: 200, outOfPocketMax: 6000, network: "PPO" },
  RVP200871: { dob: "2019-09-03", status: "inactive", planName: "Aetna HMO Silver", groupNumber: "GRP002", copayPrimary: 30, copaySpecialist: 50, deductible: 2500, deductibleMet: 0, outOfPocketMax: 8000, network: "HMO" },
  RVP300512: { dob: "2014-01-27", status: "active", planName: "Medicaid Kids Care", groupNumber: "GRP003", copayPrimary: 0, copaySpecialist: 0, deductible: 0, deductibleMet: 0, outOfPocketMax: 0, network: "Medicaid" },
  RVP400123: { dob: "2018-06-15", status: "active", planName: "Blue Shield PPO Gold", groupNumber: "GRP004", copayPrimary: 25, copaySpecialist: 40, deductible: 1500, deductibleMet: 500, outOfPocketMax: 6000, network: "PPO" },
  RVP500999: { dob: "2020-11-30", status: "inactive", planName: "Aetna HMO Silver", groupNumber: "GRP005", copayPrimary: 30, copaySpecialist: 50, deductible: 2500, deductibleMet: 0, outOfPocketMax: 8000, network: "HMO" },
  RVP600777: { dob: "2015-03-22", status: "active", planName: "Medicaid Kids Care", groupNumber: "GRP006", copayPrimary: 0, copaySpecialist: 0, deductible: 0, deductibleMet: 0, outOfPocketMax: 0, network: "Medicaid" },
  RVP700555: { dob: "2017-08-09", status: "active", planName: "Blue Shield PPO Gold", groupNumber: "GRP007", copayPrimary: 25, copaySpecialist: 40, deductible: 1500, deductibleMet: 150, outOfPocketMax: 6000, network: "PPO" },
  RVP800333: { dob: "2013-12-01", status: "inactive", planName: "Aetna HMO Silver", groupNumber: "GRP008", copayPrimary: 30, copaySpecialist: 50, deductible: 2500, deductibleMet: 0, outOfPocketMax: 8000, network: "HMO" },
  RVP900111: { dob: "2022-04-18", status: "active", planName: "Medicaid Kids Care", groupNumber: "GRP009", copayPrimary: 0, copaySpecialist: 0, deductible: 0, deductibleMet: 0, outOfPocketMax: 0, network: "Medicaid" },
  RVP100888: { dob: "2010-09-25", status: "active", planName: "Blue Shield PPO Gold", groupNumber: "GRP010", copayPrimary: 25, copaySpecialist: 40, deductible: 1500, deductibleMet: 1500, outOfPocketMax: 6000, network: "PPO" },
};

const normalizeMemberId = (id: string) => {
  const cleaned = id.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digits = (cleaned.match(/\d/g) || []).length;
  // STT often mishears RVP as RBP/RDP; all real IDs use the RVP prefix.
  if (digits === 6) return "RVP" + cleaned.replace(/\D/g, "");
  return cleaned;
};

const conversationKey = (id: string) => "conv" + id.toLowerCase().replace(/[^a-z0-9]/g, "");

const TOOLS = [
  {
    name: "verify_eligibility",
    description: "Check insurance eligibility for a member by ID and date of birth.",
    inputSchema: {
      type: "object",
      properties: {
        member_id: { type: "string", description: "Member's insurance ID number" },
        date_of_birth: { type: "string", description: "Member's date of birth in YYYY-MM-DD format" },
        caller_phone: { type: "string", description: "The caller's phone number, exactly as given in your instructions" },
      },
      required: ["member_id", "date_of_birth", "caller_phone"],
    },
  },
  {
    name: "schedule_callback",
    description: "Schedule a callback from a benefits specialist.",
    inputSchema: {
      type: "object",
      properties: {
        caller_phone: { type: "string", description: "The caller's phone number, exactly as given in your instructions" },
        reason: { type: "string", description: "Brief reason for callback" },
        preferred_time: { type: "string", description: "Preferred callback time, e.g. 'tomorrow morning'" },
      },
      required: ["caller_phone", "reason"],
    },
  },
  {
    name: "get_plan_benefits",
    description: "Retrieve benefit details for the member verified earlier on this call. No arguments needed; pass member_id only if the caller gives a different member.",
    inputSchema: {
      type: "object",
      properties: {
        member_id: { type: "string", description: "Member's insurance ID number, optional" },
      },
      required: [],
    },
  },
];

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpc(id: string | number, result: unknown, error?: { code: number; message: string }): Response {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id };
  if (error) body.error = error; else body.result = result;
  return Response.json(body);
}

export async function handleMcp(req: Request, env: Env, entry: LogEntry): Promise<Response> {
  const { id, method, params = {} } = await req.json() as JsonRpcRequest;

  if (id === undefined) {
    return new Response(null, { status: 202 });
  }

  if (method === "initialize") {
    return jsonRpc(id, { protocolVersion: (params.protocolVersion as string) ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "verify-line", version: "1.0.0" } });
  }

  if (method === "tools/list") {
    return jsonRpc(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    entry.action = params.name as string;
    entry.conversationId = (params._meta as Record<string, unknown> | undefined)?.telnyx_conversation_id as string | undefined;
    entry.metaKeys = Object.keys((params._meta as Record<string, unknown>) ?? {});
    const output = await runTool(params.name as string, (params.arguments as Record<string, unknown>) ?? {}, env, entry);
    return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(output) }], ...(output.isError ? { isError: true } : {}) });
  }

  if (method === "ping") {
    return jsonRpc(id, {});
  }

  return jsonRpc(id, null, { code: -32601, message: "Method not found" });
}

async function runTool(name: string, args: Record<string, unknown>, env: Env, entry: LogEntry): Promise<Record<string, unknown>> {
  switch (name) {
    case "verify_eligibility": return verifyEligibility(args, env, entry);
    case "schedule_callback": return scheduleCallback(args, env, entry);
    case "get_plan_benefits": return getPlanBenefits(args, env, entry);
    default: return { isError: true, error: `Tool not found: ${name}` };
  }
}

async function verifyEligibility(args: Record<string, unknown>, env: Env, entry: LogEntry): Promise<Record<string, unknown>> {
  const memberId = String(args.member_id ?? "");
  const dob = String(args.date_of_birth ?? "");
  const callerPhone = String(args.caller_phone ?? "");
  if (!memberId || !dob || !callerPhone) {
    entry.outcome = "bad_input";
    return { error: "member_id, date_of_birth, and caller_phone are required" };
  }

  const conversationId = entry.conversationId as string | undefined;
  const normalizedId = normalizeMemberId(memberId);
  const member = MEMBERS[normalizedId] ?? null;
  const status = !member || member.dob !== dob ? "not_found" : member.status;

  entry.callerId = maskPhone(callerPhone);

  const caller = env.CALLER.idFromName(await callerKey(callerPhone));
  const conversation = status !== "not_found" && conversationId ? env.CALLER.idFromName(conversationKey(conversationId)) : null;

  const [actorResult] = await timed(entry, "actorMs", () => Promise.all([
    caller.recordAttempt(status !== "not_found"), // inactive coverage is still a verified identity
    conversation?.rememberMember(normalizedId),
  ]));
  entry.callControlId = actorResult.callControlId;

  if (actorResult.isLockedOut) {
    entry.outcome = "locked_out";
    return { status: "locked_out", message: "Too many failed verification attempts. Offer a transfer to a benefits specialist." };
  }

  entry.outcome = status;
  return {
    status,
    plan_name: status === "active" ? (member?.planName ?? null) : null,
    copay: status === "active" ? (member?.copayPrimary ?? null) : null,
    group_number: status === "active" ? (member?.groupNumber ?? null) : null,
    message: status === "active" ? `Member ${normalizedId} is active on ${member?.planName}.` : status === "not_found" ? "No member found with that ID and date of birth." : `Member ${normalizedId} is inactive.`,
  };
}

async function scheduleCallback(args: Record<string, unknown>, env: Env, entry: LogEntry): Promise<Record<string, unknown>> {
  const callerPhone = String(args.caller_phone ?? "");
  const reason = String(args.reason ?? "");
  if (!callerPhone || !reason) {
    entry.outcome = "bad_input";
    return { error: "caller_phone and reason are required" };
  }

  const caller = env.CALLER.idFromName(await callerKey(callerPhone));

  const result = await timed(entry, "actorMs", () => caller.scheduleCallback(reason, String(args.preferred_time ?? "next available")));
  entry.outcome = "ok";
  entry.callbackId = result.callbackId;
  entry.alarmInMs = result.alarmAt === null ? null : result.alarmAt - Date.now();
  return {
    scheduled: true,
    callback_id: result.callbackId,
    spoken_reference: result.callbackId.replace("cb_", "").toUpperCase().split("").join(" "),
    estimated_time: String(args.preferred_time ?? "within one business day"),
    message: `Callback scheduled. Read the reference to the caller exactly as: ${result.callbackId.replace("cb_", "").toUpperCase().split("").join(", ")}.`,
  };
}

async function getPlanBenefits(args: Record<string, unknown>, env: Env, entry: LogEntry): Promise<Record<string, unknown>> {
  const conversationId = entry.conversationId as string | undefined;
  let memberId = String(args.member_id ?? "");
  if (memberId) {
    entry.memberSource = "args";
  } else if (conversationId) {
    const conv = env.CALLER.idFromName(conversationKey(conversationId));
    const id = await timed(entry, "actorMs", () => conv.getMemberId());
    entry.memberSource = "conversation";
    if (id) memberId = id;
  }

  if (!memberId) {
    entry.outcome = "bad_input";
    return { error: "No member has been verified on this call; the caller may be locked out after too many failed attempts. Do not ask for the member ID. Tell the caller a billing coordinator will call them back within one business day." };
  }

  const normalizedId = normalizeMemberId(memberId);
  const member = MEMBERS[normalizedId];
  if (!member) {
    entry.outcome = "not_found";
    return { message: "No plan found for that member ID." };
  }

  entry.outcome = "ok";
  return {
    member_id: normalizedId,
    member_source: entry.memberSource,
    coverage_status: member.status,
    plan_name: member.planName,
    deductible: member.deductible,
    deductible_met: member.deductibleMet,
    out_of_pocket_max: member.outOfPocketMax,
    copay_primary: member.copayPrimary,
    copay_specialist: member.copaySpecialist,
    network: member.network,
    message: member.status === "active"
      ? `Plan details for member ${normalizedId}: ${member.planName} (coverage active).`
      : `Coverage for member ${normalizedId} is inactive. These are the ${member.planName} plan terms on file; share them when the caller asks and say the coverage is inactive.`,
  };
}
