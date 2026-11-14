// Direct import avoids bundling entire Telnyx + AWS SDK (2.6 MB) and dodges secret-scanner false positives from doc comments.
import { StatefulActor } from "../node_modules/@telnyx/edge-runtime/dist/stateful-actor.js";
import type { AlarmInfo } from "@telnyx/edge-runtime";

interface PendingCallback {
  callbackId: string;
  reason: string;
  preferredTime: string;
  dueAt: number;
  status: string;
}

const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 30 * 60 * 1000;
const CALLBACK_DELAY_MS = 2 * 60 * 1000;

export class CallerSession extends StatefulActor<Env> {
  async beginCall(callControlId: string): Promise<{ attempts: number; isLockedOut: boolean; isReturning: boolean; pendingCallback: { status: string | null; dueAt: number | null; alarmAt: number | null } }> {
    await this.ctx.storage.put("call_control_id", callControlId);
    const now = Date.now();
    const lockedUntil = (await this.ctx.storage.get<number>("locked_until")) ?? 0;
    const failedAttempts = (await this.ctx.storage.get<number>("failed_attempts")) ?? 0;
    const lastVerifiedAt = await this.ctx.storage.get<string>("last_verified_at");
    const isLockedOut = now < lockedUntil;
    const hadExpiredLockout = lockedUntil > 0 && now >= lockedUntil;
    const pending = await this.ctx.storage.get<PendingCallback>("pending_callback");
    const alarmAt = await this.ctx.storage.getAlarm();
    return { attempts: hadExpiredLockout ? 0 : failedAttempts, isLockedOut, isReturning: !!lastVerifiedAt, pendingCallback: { status: pending?.status ?? null, dueAt: pending?.dueAt ?? null, alarmAt } };
  }

  // Demo/support reset: clears the failed-attempt counter and any active lockout for this caller.
  async resetLockout(): Promise<{ hadLockout: boolean }> {
    const lockedUntil = (await this.ctx.storage.get<number>("locked_until")) ?? 0;
    await this.ctx.storage.delete("failed_attempts");
    await this.ctx.storage.delete("locked_until");
    return { hadLockout: lockedUntil > Date.now() };
  }

  async recordAttempt(verified: boolean): Promise<{ attempts: number; isLockedOut: boolean; callControlId: string }> {
    const now = Date.now();
    let attempts = (await this.ctx.storage.get<number>("failed_attempts")) ?? 0;
    const lockedUntil = (await this.ctx.storage.get<number>("locked_until")) ?? 0;
    const callControlId = (await this.ctx.storage.get<string>("call_control_id")) ?? "";

    if (now < lockedUntil) {
      return { attempts, isLockedOut: true, callControlId };
    }

    if (lockedUntil > 0 && now >= lockedUntil) {
      attempts = 0;
      await this.ctx.storage.delete("locked_until");
    }

    if (verified) {
      await this.ctx.storage.put("failed_attempts", 0);
      await this.ctx.storage.put("last_verified_at", new Date().toISOString());
      return { attempts: 0, isLockedOut: false, callControlId };
    }

    attempts += 1;
    await this.ctx.storage.put("failed_attempts", attempts);
    if (attempts >= MAX_ATTEMPTS) {
      await this.ctx.storage.put("locked_until", now + LOCKOUT_MS);
    }

    return { attempts, isLockedOut: attempts >= MAX_ATTEMPTS, callControlId };
  }

  // Also used as one instance per conversation: the conversation id survives an assistant handoff.
  async rememberMember(memberId: string): Promise<void> {
    await this.ctx.storage.put("member_id", memberId);
  }

  async getMemberId(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("member_id");
  }

  async scheduleCallback(reason: string, preferredTime: string): Promise<{ callbackId: string; dueAt: number; alarmAt: number | null }> {
    const callbackId = "cb_" + crypto.randomUUID().slice(0, 8);
    const dueAt = Date.now() + CALLBACK_DELAY_MS;
    const pending: PendingCallback = { callbackId, reason, preferredTime, dueAt, status: "scheduled" };
    await this.ctx.storage.put("pending_callback", pending);
    await this.ctx.setAlarm(dueAt);
    const alarmAt = await this.ctx.storage.getAlarm();
    return { callbackId, dueAt, alarmAt };
  }

  async alarm(_alarmInfo: AlarmInfo): Promise<void> {
    const pending = await this.ctx.storage.get<PendingCallback>("pending_callback");
    if (!pending || pending.status !== "scheduled") return;
    pending.status = "due";
    await this.ctx.storage.put("pending_callback", pending);
    // In production: place outbound call via Call Control here.
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", route: "alarm", action: "callback_due", callbackId: pending.callbackId, outcome: "ok" }));
  }
}
