import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { nextId } from "./helpers";

function normalizeLeadStatus(value: unknown): string {
  const s = String(value ?? "").trim().toLowerCase();

  if (!s || s === "new" || s === "pending" || s === "pendiente") {
    return "pendiente";
  }

  if (
    s === "en_espera_aceptacion" ||
    s === "en espera de aceptacion" ||
    s === "en revision" ||
    s === "en_revision" ||
    s === "review" ||
    s === "in_review" ||
    s === "pendiente_aprobacion_abogado"
  ) {
    return "en_espera_aceptacion";
  }

  if (s === "asignada" || s === "assigned") {
    return "asignada";
  }

  if (
    s === "finalizado" ||
    s === "finalizada" ||
    s === "finalized" ||
    s === "closed"
  ) {
    return "finalizado";
  }

  return s;
}

async function findLeadByNumericId(ctx: any, id: number) {
  const matches = await ctx.db
    .query("leads")
    .filter((q: any) => q.eq(q.field("id"), id))
    .collect();
  if (!matches.length) return null;
  return matches.sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

function firstNonEmptyString(...values: any[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/* LIST LEADS */
export const list = query({
  args: { search: v.optional(v.string()), status: v.optional(v.string()) },
  handler: async (ctx, { search, status }) => {
    const rows = await ctx.db.query("leads").collect();
    const callLogs = await ctx.db.query("callLogs").collect();

    const latestRetellByLeadId = new Map<number, { retellCallId: string; createdAt: number }>();
    for (const log of callLogs) {
      const leadId = Number((log as any)?.leadId ?? 0);
      const retellCallId = String((log as any)?.retellCallId ?? "").trim();
      if (!Number.isFinite(leadId) || leadId <= 0 || !retellCallId) continue;

      const createdAt = Number((log as any)?.createdAt ?? 0);
      const current = latestRetellByLeadId.get(leadId);
      if (!current || createdAt >= current.createdAt) {
        latestRetellByLeadId.set(leadId, { retellCallId, createdAt });
      }
    }

    const statusFilter = status ? normalizeLeadStatus(status) : undefined;

    const normalizedRows = rows.map((l) => ({
      ...l,
      status: normalizeLeadStatus(l.status),
      retellCallId:
        latestRetellByLeadId.get(Number((l as any)?.id ?? 0))?.retellCallId ||
        String((l as any)?.retellCallId ?? "").trim() ||
        undefined,
    }));

    const s = (search ?? "").toLowerCase().trim();

    const sorted = normalizedRows.sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    );

    const statusFiltered = statusFilter
      ? sorted.filter((l) => l.status === statusFilter)
      : sorted;

    if (!s) return statusFiltered;

    return statusFiltered.filter((l) => {
      const hay = `${l.name} ${l.phone} ${l.caseType ?? ""} ${
        l.urgency ?? ""
      }`.toLowerCase();
      return hay.includes(s);
    });
  },
});

/* CREATE LEAD */
export const create = mutation({
  args: {
    name: v.string(),
    phone: v.string(),
    practiceArea: v.string(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const newId = await nextId(ctx, "leads");
    const now = Date.now();

    await ctx.db.insert("leads", {
      id: newId,
      name: args.name,
      phone: args.phone,
      practiceArea: args.practiceArea,
      source: args.source,
      status: "pendiente",
      createdAt: now,
    });

    return newId;
  },
});

/* GET LEAD */
export const get = query({
  args: { id: v.number() },
  handler: async (ctx, { id }) => {
    return await findLeadByNumericId(ctx, id);
  },
});

/* UPDATE LEAD */
export const update = mutation({
  args: {
    id: v.number(),
    updates: v.any(),
  },
  handler: async (ctx, { id, updates }) => {
    const lead = await findLeadByNumericId(ctx, id);

    if (!lead) throw new Error("Lead not found");

    const allowed = [
      "name",
      "phone",
      "practiceArea",
      "source",
      "email",
      "city",
      "age",
      "caseType",
      "urgency",
      "status",
      "attorneyId",
      "retellCallId",
      "retellAgentId",
      "summary",
      "transcript",
      "lastContactedAt",
    ];

    const patch: any = {};
    for (const k of allowed) {
      if (updates?.[k] !== undefined) {
        patch[k] = updates[k];
      }
    }

    if (patch.status !== undefined) {
      patch.status = normalizeLeadStatus(patch.status);
    }

    await ctx.db.patch(lead._id, patch);
    return await ctx.db.get(lead._id);
  },
});

/* ASSIGN ATTORNEY */
export const assignAttorney = mutation({
  args: { id: v.number(), attorneyId: v.string() },
  handler: async (ctx, { id, attorneyId }) => {
    const lead = await findLeadByNumericId(ctx, id);

    if (!lead) throw new Error("Lead not found");

    await ctx.db.patch(lead._id, {
      attorneyId,
      status: "asignada",
    });

    return await ctx.db.get(lead._id);
  },
});

export const createManualLead = mutation({
  args: {
    name: v.string(),
    phone: v.string(),
    practiceArea: v.string(),
    data: v.any(),
  },

  handler: async (ctx, args) => {
    const newId = await nextId(ctx, "leads");
    const callLogId = await nextId(ctx, "callLogs");
    const now = Date.now();
    const manualRetellCallId = `manual-${newId}-${now}`;
    const data = args.data ?? {};

    const city = firstNonEmptyString(
      data.city,
      data.clientCity,
      data.residenceCity
    );
    const stateProvince = firstNonEmptyString(
      data.stateProvince,
      data.state,
      data.state_province,
      data.residenceState
    );
    const location = firstNonEmptyString(
      data.location,
      data.ubicacion,
      [city, stateProvince].filter(Boolean).join(", ")
    );
    const email = firstNonEmptyString(data.email, data.correo);
    const address = firstNonEmptyString(data.address, data.direccion);
    const caseType = firstNonEmptyString(
      data.caseType,
      data.case_type,
      args.practiceArea
    );
    const urgency = firstNonEmptyString(
      data.urgency,
      data.urgencyLevel,
      data.priority
    );
    const summary = firstNonEmptyString(
      data.summary,
      data.narrative,
      data.caseNotes,
      data.deadlineNotes
    );
    const caseNotes = firstNonEmptyString(
      data.caseNotes,
      data.deadlineNotes,
      data.narrative
    );

    // 1) Crear lead
    await ctx.db.insert("leads", {
      id: newId,
      name: args.name,
      phone: args.phone,
      ...(email ? { email } : {}),
      ...(city ? { city } : {}),
      ...(caseType ? { caseType } : {}),
      ...(urgency ? { urgency } : {}),
      ...(summary ? { summary } : {}),
      practiceArea: args.practiceArea,
      source: "manual",
      status: "pendiente",
      retellCallId: manualRetellCallId,
      createdAt: now,
    });

    // 2) Guardar intake
    await ctx.db.insert("intakes", {
      leadId: newId,
      practiceArea: args.practiceArea,
      data: args.data,
      createdAt: now,
    });

    // 3) Crear call log
    await ctx.db.insert("callLogs", {
      id: callLogId,
      leadId: newId,
      retellCallId: manualRetellCallId,
      status: "pendiente",
      direction: "manual",
      phoneNumber: args.phone,
      ...(summary ? { summary } : {}),
      ...(city ? { city } : {}),
      ...(stateProvince ? { stateProvince } : {}),
      ...(location ? { location } : {}),
      ...(email ? { email } : {}),
      ...(address ? { address } : {}),
      ...(caseType ? { caseType } : {}),
      ...(caseNotes ? { caseNotes } : {}),
      createdAt: now,
    });

    return newId;
  },
});
