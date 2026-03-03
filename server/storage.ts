import { convexClient } from "./convexClient";
import { randomUUID } from "node:crypto";
import type {
  Lead,
  InsertLead,
  UpdateLeadRequest,
  CallLog,
  InsertCallLog,
  DashboardStats,
  Attorney,
  InsertAttorney,
  User,
} from "@shared/types";
import type { Id } from "../convex/_generated/dataModel";


// Normalizador fuerte para specialties
function normalizeSpecialties(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];

    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
      } catch {}
    }

    if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
    return [s];
  }

  return [];
}

export interface IStorage {
  // Leads
  getLeads(search?: string, status?: string): Promise<Lead[]>;
  getLead(id: number): Promise<Lead | undefined>;
  getLeadByRetellCallId(retellCallId: string): Promise<Lead | undefined>;
  createLead(lead: InsertLead): Promise<Lead>;
  updateLead(id: number, updates: UpdateLeadRequest): Promise<Lead>;
  assignAttorneyToLead(leadId: number, attorneyId: string): Promise<Lead>;

  // Call Logs
  getCallLogs(): Promise<any[]>;
  createCallLog(log: InsertCallLog): Promise<CallLog>;
  getCallLogByRetellCallId(retellCallId: string): Promise<CallLog | undefined>;
  updateCallLogByRetellCallId(retellCallId: string, updates: Partial<InsertCallLog>): Promise<CallLog>;
  markNewCallAlertSent(retellCallId: string, sentAt?: number): Promise<boolean>;
  upsertInboundPlaceholder(input: {
    fromNumber: string;
    toNumber?: string;
    sourceEvent?: string;
    createdAt?: number;
  }): Promise<CallLog>;
  claimInboundPlaceholder(input: {
    retellCallId: string;
    fromNumber: string;
    toNumber?: string;
    sourceEvent?: string;
    claimedAt?: number;
  }): Promise<CallLog | undefined>;

  // Attorneys
  getAttorneys(filters?: { q?: string; city?: string; state?: string; specialty?: string }): Promise<Attorney[]>;
  createAttorney(attorney: InsertAttorney): Promise<Attorney>;
  getAttorney(attorneyId: string): Promise<Attorney | undefined>;

  // Stats
  getDashboardStats(): Promise<DashboardStats>;

  // Users (Auth)
  getUserById(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  listUsers(): Promise<User[]>;
  createUser(user: { email: string; name: string; role: string; passwordHash: string; id?: string }): Promise<User>;
  setUserActive(id: string, isActive: boolean): Promise<User>;
}

export class ConvexStorage implements IStorage {
  // -------------------------
  // Leads
  // -------------------------
  async getLeads(search?: string, status?: string): Promise<Lead[]> {
    const { client, api } = convexClient();
    const rows: any[] = await client.query(api.leads.list, {
      search: search || undefined,
      status: status && status !== "All" ? status : undefined,
    });
    // Convert timestamps to Date objects to match old shape if needed
    return rows.map((l) => ({
      ...l,
      createdAt: l.createdAt ? new Date(l.createdAt) : null,
      lastContactedAt: l.lastContactedAt ? new Date(l.lastContactedAt) : null,
    })) as any;
  }

  async getLead(id: number): Promise<Lead | undefined> {
    const { client, api } = convexClient();
    const l: any = await client.query(api.leads.get, { id });
    if (!l) return undefined;
    return {
      ...l,
      createdAt: l.createdAt ? new Date(l.createdAt) : null,
      lastContactedAt: l.lastContactedAt ? new Date(l.lastContactedAt) : null,
    } as any;
  }

  async getLeadByRetellCallId(retellCallId: string): Promise<Lead | undefined> {
    const { client, api } = convexClient();
    const normalizedRetellCallId = String(retellCallId || "").trim();
    if (!normalizedRetellCallId) return undefined;

    // Prefer callLogs as source of truth for retellCallId -> leadId mapping.
    const callLog: any = await client.query(api.callLogs.getByRetellCallId, {
      retellCallId: normalizedRetellCallId,
    });

    if (callLog?.leadId != null) {
      return this.getLead(Number(callLog.leadId));
    }

    // Fallback for legacy rows where retellCallId was stored directly on leads.
    const rows: any[] = await client.query(api.leads.list, {});
    const l = rows.find(
      (row) =>
        String((row as any)?.retellCallId ?? "").trim() === normalizedRetellCallId
    );
    if (!l) return undefined;

    return {
      ...l,
      createdAt: l.createdAt ? new Date(l.createdAt) : null,
      lastContactedAt: l.lastContactedAt ? new Date(l.lastContactedAt) : null,
    } as any;
  }

  async createLead(lead: InsertLead): Promise<Lead> {
    const { client, api } = convexClient();
    const name = String((lead as any).name ?? "Unknown Lead");
    const phone = String((lead as any).phone ?? "Unknown");
    const practiceArea = String(
      (lead as any).practiceArea ?? (lead as any).caseType ?? "General"
    );
    const source = String(
      (lead as any).source ?? ((lead as any).retellCallId ? "retell" : "manual")
    );

    const newId: number = await client.mutation(api.leads.create, {
      name,
      phone,
      practiceArea,
      source,
    });

    // Apply optional fields in a second mutation supported by leads.update.
    const patch: any = {};
    const optionalFields = [
      "caseType",
      "urgency",
      "status",
      "attorneyId",
      "summary",
      "transcript",
      "lastContactedAt",
      "retellCallId",
      "retellAgentId",
    ];
    for (const field of optionalFields) {
      const value = (lead as any)[field];
      if (value !== undefined) patch[field] = value;
    }

    if (Object.keys(patch).length > 0) {
      return this.updateLead(newId, patch);
    }

    const created = await this.getLead(newId);
    if (!created) {
      throw new Error(`Lead ${newId} no encontrado despues de crearlo`);
    }
    return created;
  }

  async updateLead(id: number, updates: UpdateLeadRequest): Promise<Lead> {
    const { client, api } = convexClient();
    const mapped: any = { ...updates };
    // convert Date -> number
    if ((mapped as any).lastContactedAt instanceof Date) mapped.lastContactedAt = (mapped as any).lastContactedAt.getTime();
    const updated: any = await client.mutation(api.leads.update, { id, updates: mapped });
    return {
      ...updated,
      createdAt: updated.createdAt ? new Date(updated.createdAt) : null,
      lastContactedAt: updated.lastContactedAt ? new Date(updated.lastContactedAt) : null,
    } as any;
  }

  async assignAttorneyToLead(leadId: number, attorneyId: string): Promise<Lead> {
    const { client, api } = convexClient();
    const updated: any = await client.mutation(api.leads.assignAttorney, { id: leadId, attorneyId });
    return {
      ...updated,
      createdAt: updated.createdAt ? new Date(updated.createdAt) : null,
      lastContactedAt: updated.lastContactedAt ? new Date(updated.lastContactedAt) : null,
    } as any;
  }

  // -------------------------
  // Call Logs
  // -------------------------
  async getCallLogs(): Promise<any[]> {
    const { client, api } = convexClient();
    const rows: any[] = await client.query(api.callLogs.listWithLead, {});
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt ? new Date(r.createdAt) : null,
    }));
  }

  async createCallLog(log: InsertCallLog): Promise<CallLog> {
    const { client, api } = convexClient();
    const created: any = await client.mutation(api.callLogs.upsertByRetellCallId, {
      retellCallId: (log as any).retellCallId,
      updates: {
        leadId: (log as any).leadId ?? undefined,
        agentId: (log as any).agentId ?? undefined,
        phoneNumber: (log as any).phoneNumber ?? undefined,
        toNumber: (log as any).toNumber ?? undefined,
        status: (log as any).status ?? undefined,
        direction: (log as any).direction ?? undefined,
        sourceEvent: (log as any).sourceEvent ?? undefined,
        isPlaceholder: (log as any).isPlaceholder ?? undefined,
        duration: (log as any).duration ?? undefined,
        recordingUrl: (log as any).recordingUrl ?? undefined,
        summary: (log as any).summary ?? undefined,
        transcript: (log as any).transcript ?? undefined,
        sentiment: (log as any).sentiment ?? undefined,
        city: (log as any).city ?? undefined,
        stateProvince: (log as any).stateProvince ?? undefined,
        location: (log as any).location ?? undefined,
        email: (log as any).email ?? undefined,
        address: (log as any).address ?? undefined,
        caseType: (log as any).caseType ?? undefined,
        caseNotes: (log as any).caseNotes ?? undefined,
        analysis: (log as any).analysis ?? undefined,
        pendingAttorneyId: (log as any).pendingAttorneyId ?? undefined,
        assignmentStatus: (log as any).assignmentStatus ?? undefined,
        assignmentNotes: (log as any).assignmentNotes ?? undefined,
        assignmentRequestedAt: (log as any).assignmentRequestedAt ?? undefined,
        assignmentDecisionAt: (log as any).assignmentDecisionAt ?? undefined,
        assignmentDecisionByAttorneyId:
          (log as any).assignmentDecisionByAttorneyId ?? undefined,
        assignmentDecisionNotes:
          (log as any).assignmentDecisionNotes ?? undefined,
        assignmentDeliveredAt: (log as any).assignmentDeliveredAt ?? undefined,
        assignmentDeliveredByUserId:
          (log as any).assignmentDeliveredByUserId ?? undefined,
      },
    });
    return { ...created, createdAt: created.createdAt ? new Date(created.createdAt) : null } as any;
  }

  async getCallLogByRetellCallId(retellCallId: string): Promise<CallLog | undefined> {
    const { client, api } = convexClient();
    const row: any = await client.query(api.callLogs.getByRetellCallId, { retellCallId });
    if (!row) return undefined;
    return { ...row, createdAt: row.createdAt ? new Date(row.createdAt) : null } as any;
  }

  async updateCallLogByRetellCallId(retellCallId: string, updates: Partial<InsertCallLog>): Promise<CallLog> {
    const { client, api } = convexClient();
    const patch: any = { ...updates };
    const row: any = await client.mutation(api.callLogs.upsertByRetellCallId, { retellCallId, updates: patch });
    return { ...row, createdAt: row.createdAt ? new Date(row.createdAt) : null } as any;
  }

  async markNewCallAlertSent(retellCallId: string, sentAt?: number): Promise<boolean> {
    const { client, api } = convexClient();
    return await client.mutation(api.callLogs.markNewCallAlertSent, {
      retellCallId,
      sentAt,
    });
  }

  async upsertInboundPlaceholder(input: {
    fromNumber: string;
    toNumber?: string;
    sourceEvent?: string;
    createdAt?: number;
  }): Promise<CallLog> {
    const { client, api } = convexClient();
    const row: any = await client.mutation(api.callLogs.upsertInboundPlaceholder, input);
    return { ...row, createdAt: row.createdAt ? new Date(row.createdAt) : null } as any;
  }

  async claimInboundPlaceholder(input: {
    retellCallId: string;
    fromNumber: string;
    toNumber?: string;
    sourceEvent?: string;
    claimedAt?: number;
  }): Promise<CallLog | undefined> {
    const { client, api } = convexClient();
    const row: any = await client.mutation(api.callLogs.claimInboundPlaceholder, input);
    if (!row) return undefined;
    return { ...row, createdAt: row.createdAt ? new Date(row.createdAt) : null } as any;
  }

  // -------------------------
  // Attorneys
  // -------------------------
  async getAttorney(attorneyId: string): Promise<Attorney | undefined> {
    const { client, api } = convexClient();
    const row: any = await client.query(api.attorneys.getById, { id: attorneyId as Id<"attorneys"> });
    if (!row) return undefined;
    return { ...row, createdAt: row.createdAt ? new Date(row.createdAt) : null } as any;
  }

  async getAttorneys(filters?: { q?: string; city?: string; state?: string; specialty?: string }): Promise<Attorney[]> {
    const { client, api } = convexClient();
    const rows: any[] = await client.query(api.attorneys.list, {
      q: filters?.q || undefined,
      city: filters?.city || undefined,
      state: filters?.state || undefined,
      specialty: filters?.specialty || undefined,
    });
    return rows.map((a) => ({ ...a, createdAt: a.createdAt ? new Date(a.createdAt) : null })) as any;
  }

  async createAttorney(attorney: InsertAttorney): Promise<Attorney> {
    const { client, api } = convexClient();
    const created: any = await client.mutation(api.attorneys.create, {
      id: (attorney as any).id || randomUUID(),
      name: (attorney as any).name,
      email: (attorney as any).email,
      phone: (attorney as any).phone ?? undefined,
      city: (attorney as any).city ?? undefined,
      stateProvince: (attorney as any).stateProvince ?? undefined,
      notes: (attorney as any).notes ?? undefined,
      specialties: normalizeSpecialties((attorney as any).specialties),
    });
    return { ...created, createdAt: created.createdAt ? new Date(created.createdAt) : null } as any;
  }

  async upsertLeadByRetellCallId(retellCallId: string, data: any) {
    const normalizedRetellCallId = String(retellCallId || "").trim();
    const payload = { ...(data || {}), retellCallId: normalizedRetellCallId };

    const existing = await this.getLeadByRetellCallId(normalizedRetellCallId);
    if (existing) {
      return this.updateLead(existing.id, payload as any);
    }

    return this.createLead({
      name: String(payload.name ?? "Unknown Lead"),
      phone: String(payload.phone ?? "Unknown"),
      caseType: payload.caseType,
      urgency: payload.urgency,
      status: payload.status ?? "pendiente",
      attorneyId: payload.attorneyId,
      retellCallId: normalizedRetellCallId || undefined,
      retellAgentId: payload.retellAgentId,
      summary: payload.summary,
      transcript: payload.transcript,
    } as any);
  }

  // -------------------------
  // Stats
  // -------------------------
  async getDashboardStats(): Promise<DashboardStats> {
    const { client, api } = convexClient();
    return (await client.query(api.stats.dashboard, {})) as any;
  }

  // -------------------------
  // Users (Auth)
  // -------------------------
  async getUserById(id: string): Promise<User | undefined> {
    const { client, api } = convexClient();
    const u: any = await client.query(api.users.getById, { id });
    return u as any;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const { client, api } = convexClient();
    const u: any = await client.query(api.users.getByEmail, { email: email.toLowerCase().trim() });
    return u as any;
  }

  async listUsers(): Promise<User[]> {
    const { client, api } = convexClient();
    const rows: any[] = await client.query(api.users.list, {});
    return rows as any;
  }

  async createUser(user: { email: string; name: string; role: string; passwordHash: string; id?: string }): Promise<User> {
    const { client, api } = convexClient();
    const id = user.id || randomUUID();
    const created: any = await client.mutation(api.users.create, {
      id,
      email: user.email.toLowerCase().trim(),
      name: user.name.trim(),
      role: user.role,
      passwordHash: user.passwordHash,
    });
    return created as any;
  }

  async setUserActive(id: string, isActive: boolean): Promise<User> {
    const { client, api } = convexClient();
    const updated: any = await client.mutation(api.users.setActive, { id, isActive: isActive ? 1 : 0 });
    return updated as any;
  }
}

export const storage = new ConvexStorage();
