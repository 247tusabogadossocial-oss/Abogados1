import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { nextId } from "./helpers";

async function findCallLogByRetellCallId(ctx: any, retellCallId: string) {
  const matches = await ctx.db
    .query("callLogs")
    .withIndex("by_retellCallId", (q: any) => q.eq("retellCallId", retellCallId))
    .collect();
  if (!matches.length) return null;
  return matches.sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

async function findRecentInboundPlaceholder(
  ctx: any,
  input: {
    fromNumber: string;
    toNumber?: string;
    now?: number;
    windowMs: number;
  }
) {
  const now = input.now ?? Date.now();
  const fromNumber = String(input.fromNumber ?? "").trim();
  const toNumber = String(input.toNumber ?? "").trim();
  if (!fromNumber) return null;

  const rows = await ctx.db.query("callLogs").collect();
  const matches = rows.filter((row: any) => {
    if (row?.isPlaceholder !== true) return false;
    if (String(row?.direction ?? "").trim().toLowerCase() !== "inbound") return false;
    if (String(row?.phoneNumber ?? "").trim() !== fromNumber) return false;
    if (toNumber && String(row?.toNumber ?? "").trim() !== toNumber) return false;
    return now - Number(row?.createdAt ?? 0) <= input.windowMs;
  });

  if (!matches.length) return null;
  return matches.sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

async function findLeadByNumericId(ctx: any, id: number) {
  const matches = await ctx.db
    .query("leads")
    .filter((q: any) => q.eq(q.field("id"), id))
    .collect();
  if (!matches.length) return null;
  return matches.sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

function normalizeLeadStatusFromCallStatus(status: unknown): string {
  const s = String(status ?? "").trim().toLowerCase();

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

  // Rejected attorney decisions return the lead to pending for reassignment.
  if (s === "rechazada_por_abogado" || s === "rejected") {
    return "pendiente";
  }

  return s;
}

/* ============================================================
   LISTAR CALL LOGS
============================================================ */

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("callLogs").collect();
    return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  },
});

export const listWithLead = query({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db.query("callLogs").collect();
    const leads = await ctx.db.query("leads").collect();

    const leadById = new Map(leads.map((l) => [l.id, l]));

    return logs
      .map((log) => {
        const lead = log.leadId != null ? leadById.get(log.leadId) : undefined;
        const recordingUrl =
          (log as any).recordingUrl ??
          (log as any).recording_url ??
          (log as any).recording_url_public ??
          (log as any).recording?.url ??
          (log as any).recording?.recording_url ??
          (log as any).recording?.recording_url_public ??
          (log as any).recording?.public_url ??
          (log as any).scrubbed_recording_url ??
          (log as any).recording_multi_channel_url ??
          (log as any).scrubbed_recording_multi_channel_url ??
          (log as any).analysis?.recordingUrl ??
          (log as any).analysis?.recording_url ??
          (log as any).analysis?.recording_url_public ??
          (log as any).analysis?.recording?.url ??
          (log as any).analysis?.recording?.recording_url ??
          (log as any).analysis?.recording?.recording_url_public ??
          (log as any).analysis?.post_call_analysis?.recordingUrl ??
          (log as any).analysis?.post_call_analysis?.recording_url ??
          (log as any).analysis?.post_call_analysis?.recording_url_public ??
          (log as any).analysis?.post_call_analysis?.recording?.url ??
          (log as any).analysis?.scrubbed_recording_url ??
          (log as any).analysis?.recording_multi_channel_url ??
          (log as any).analysis?.scrubbed_recording_multi_channel_url ??
          undefined;
        const pendingAttorneyId =
          (log as any).pendingAttorneyId ??
          (log as any).analysis?.assignment?.requestedAttorneyId ??
          null;
        const assignmentStatus =
          (log as any).assignmentStatus ??
          (log as any).analysis?.assignment?.decision ??
          null;

        return {
          ...log,
          recordingUrl,
          pendingAttorneyId,
          assignmentStatus,
          leadId: lead?.id ?? log.leadId ?? null,
          leadName: lead?.name ?? null,
          caseType: lead?.caseType ?? (log as any).caseType ?? null,
          urgency: lead?.urgency ?? null,
          attorneyId: lead?.attorneyId ?? null,
          leadPhone: lead?.phone ?? null,
          leadEmail: lead?.email ?? null,
          leadCity: lead?.city ?? log.city ?? null,
          leadAge: (lead as any)?.age ?? null,
          leadStatus: lead?.status ?? null,
        };
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  },
});

/* ============================================================
   GET POR RETELL CALL ID
============================================================ */

export const getByRetellCallId = query({
  args: { retellCallId: v.string() },
  handler: async (ctx, { retellCallId }) => {
    return await findCallLogByRetellCallId(ctx, retellCallId);
  },
});

/* ============================================================
   ACTUALIZAR STATUS DESDE FRONT
============================================================ */

export const updateCallStatus = mutation({
  args: {
    callId: v.id("callLogs"),
    status: v.union(
      v.literal("pendiente"),
      v.literal("en_espera_aceptacion"),
      v.literal("asignada")
    ),
  },
  handler: async (ctx, { callId, status }) => {
    await ctx.db.patch(callId, { status });

    const call = await ctx.db.get(callId);
    if (!call?.leadId) return;

    const lead = await findLeadByNumericId(ctx, call.leadId);

    if (lead) {
      await ctx.db.patch(lead._id, { status });
    }
  },
});

export const markNewCallAlertSent = mutation({
  args: {
    retellCallId: v.string(),
    sentAt: v.optional(v.number()),
  },
  handler: async (ctx, { retellCallId, sentAt }) => {
    const existing = await findCallLogByRetellCallId(ctx, retellCallId);
    if (!existing) return false;
    if (typeof (existing as any).newCallAlertSentAt === "number") return false;

    await ctx.db.patch(existing._id, {
      newCallAlertSentAt: sentAt ?? Date.now(),
    });

    return true;
  },
});

export const upsertInboundPlaceholder = mutation({
  args: {
    fromNumber: v.string(),
    toNumber: v.optional(v.string()),
    sourceEvent: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.createdAt ?? Date.now();
    const fromNumber = String(args.fromNumber ?? "").trim();
    const toNumber = String(args.toNumber ?? "").trim();
    if (!fromNumber) {
      throw new Error("fromNumber es obligatorio");
    }

    const existing = await findRecentInboundPlaceholder(ctx, {
      fromNumber,
      toNumber,
      now,
      windowMs: 1000 * 60 * 3,
    });
    if (existing) return existing;

    const newId = await nextId(ctx, "callLogs");
    const docId = await ctx.db.insert("callLogs", {
      id: newId,
      retellCallId: `inbound:${fromNumber}:${toNumber || "unknown"}:${now}`,
      phoneNumber: fromNumber,
      ...(toNumber ? { toNumber } : {}),
      status: "pendiente",
      direction: "inbound",
      isPlaceholder: true,
      sourceEvent: args.sourceEvent ?? "call_inbound",
      createdAt: now,
      extraFields: [],
    });

    return await ctx.db.get(docId);
  },
});

export const claimInboundPlaceholder = mutation({
  args: {
    retellCallId: v.string(),
    fromNumber: v.string(),
    toNumber: v.optional(v.string()),
    sourceEvent: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const alreadyExists = await findCallLogByRetellCallId(ctx, args.retellCallId);
    if (alreadyExists) return alreadyExists;

    const placeholder = await findRecentInboundPlaceholder(ctx, {
      fromNumber: args.fromNumber,
      toNumber: args.toNumber,
      now: args.claimedAt ?? Date.now(),
      windowMs: 1000 * 60 * 60 * 6,
    });
    if (!placeholder) return null;

    await ctx.db.patch(placeholder._id, {
      retellCallId: args.retellCallId,
      isPlaceholder: false,
      ...(args.toNumber ? { toNumber: args.toNumber } : {}),
      ...(args.sourceEvent ? { sourceEvent: args.sourceEvent } : {}),
    });

    return await ctx.db.get(placeholder._id);
  },
});

/* ============================================================
   UPSERT SEGURO (ANTI-DUPLICADOS REAL)
============================================================ */

export const upsertByRetellCallId = mutation({
  args: {
    retellCallId: v.string(),
    updates: v.any(),
  },
  handler: async (ctx, { retellCallId, updates }) => {
    const normalizedUpdates: any = { ...(updates ?? {}) };
    if (
      normalizedUpdates.summary !== undefined &&
      typeof normalizedUpdates.summary !== "string"
    ) {
      delete normalizedUpdates.summary;
    }
    if (
      normalizedUpdates.extraFields !== undefined &&
      !Array.isArray(normalizedUpdates.extraFields)
    ) {
      delete normalizedUpdates.extraFields;
    }

    // 1️⃣ Buscar existente
    const existing = await findCallLogByRetellCallId(ctx, retellCallId);

    // 2️⃣ Si existe → patch
    if (existing) {
      const summaryFromAnalysis =
        normalizedUpdates?.analysis?.call_summary ??
        normalizedUpdates?.analysis?.post_call_analysis?.call_summary;
      const safeSummary =
        normalizedUpdates.summary ??
        (typeof summaryFromAnalysis === "string" ? summaryFromAnalysis : undefined) ??
        (typeof existing.summary === "string" ? existing.summary : undefined);
      const safeExtraFields = Array.isArray(normalizedUpdates.extraFields)
        ? normalizedUpdates.extraFields
        : Array.isArray((existing as any).extraFields)
          ? (existing as any).extraFields
          : [];
      const patch: any = {
        ...normalizedUpdates,
        extraFields: safeExtraFields,
      };
      if (typeof safeSummary === "string") {
        patch.summary = safeSummary;
      } else if (
        (existing as any).summary !== undefined &&
        typeof (existing as any).summary !== "string"
      ) {
        // Auto-heal legacy invalid docs that stored summary as null/non-string.
        patch.summary = "";
      } else {
        delete patch.summary;
      }

      await ctx.db.patch(existing._id, patch);

      const updated: any = await ctx.db.get(existing._id);

      // 🔁 Sincronizar lead si cambió status
      if (updated?.leadId && normalizedUpdates?.status) {
        const lead = await findLeadByNumericId(ctx, updated.leadId);

        if (lead) {
          await ctx.db.patch(lead._id, {
            status: normalizeLeadStatusFromCallStatus(normalizedUpdates.status),
          });
        }
      }

      return updated;
    }

    // 3️⃣ Si no existe → intentar insertar
    try {
      const newId = await nextId(ctx, "callLogs");
      const now = Date.now();

      const summaryFromAnalysis =
        normalizedUpdates?.analysis?.call_summary ??
        normalizedUpdates?.analysis?.post_call_analysis?.call_summary;
      const safeSummary =
        normalizedUpdates.summary ??
        (typeof summaryFromAnalysis === "string" ? summaryFromAnalysis : undefined);

      const docId = await ctx.db.insert("callLogs", {
        id: newId,
        retellCallId,
        status: "pendiente",
        createdAt: now,
        ...normalizedUpdates,
        ...(typeof safeSummary === "string" ? { summary: safeSummary } : {}),
        extraFields: normalizedUpdates.extraFields ?? [],
      });

      const inserted = await ctx.db.get(docId);

      // 🔁 Sincronizar lead
      if (normalizedUpdates?.leadId != null) {
        const lead = await findLeadByNumericId(ctx, normalizedUpdates.leadId);

        if (lead) {
          await ctx.db.patch(lead._id, {
            status: normalizeLeadStatusFromCallStatus(
              normalizedUpdates.status ?? "pendiente"
            ),
          });
        }
      }

      return inserted;

    } catch (err) {
      // 4️⃣ Si ocurre condición de carrera → reconsultar
      const retry = await findCallLogByRetellCallId(ctx, retellCallId);

      if (retry) return retry;

      throw err;
    }
  },
});
