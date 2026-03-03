import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { requireAuth, requireAdmin } from "./auth";
import bcrypt from "bcryptjs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  sendAttorneyAssignmentEmail,
  sendAttorneyDecisionEmail,
  sendNewCallAlertEmail,
} from "./mailer";
import { openrouter } from "./services/ai";
import { convexClient } from "./convexClient";


/* ============================================================
   HELPERS
============================================================ */

function safeString(v: any, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  return String(v);
}

function pickFirstString(...values: any[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

function pickFirstByKeyFragments(
  source: any,
  fragments: string[]
): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (typeof rawValue !== "string" || !rawValue.trim()) continue;
    const key = String(rawKey).toLowerCase();
    if (fragments.some((fragment) => key.includes(fragment))) {
      return rawValue.trim();
    }
  }
  return undefined;
}

function hasOwn(obj: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj ?? {}, key);
}

function extractRecordingUrl(
  payload: any,
  call: any,
  analysis: any,
  retellCallDetails?: any
): string | undefined {
  const post = analysis?.post_call_analysis || {};

  return pickFirstString(
    call?.recordingUrl,
    call?.recording_url,
    call?.recording_url_public,
    call?.recording?.url,
    call?.recording?.recording_url,
    call?.recording?.recording_url_public,
    call?.recording?.public_url,
    payload?.recordingUrl,
    payload?.recording_url,
    payload?.recording_url_public,
    payload?.recording?.url,
    payload?.recording?.recording_url,
    payload?.recording?.recording_url_public,
    payload?.recording?.public_url,
    analysis?.recordingUrl,
    analysis?.recording_url,
    analysis?.recording_url_public,
    analysis?.recording?.url,
    analysis?.recording?.recording_url,
    analysis?.recording?.recording_url_public,
    post?.recordingUrl,
    post?.recording_url,
    post?.recording_url_public,
    post?.recording?.url,
    post?.recording?.recording_url,
    post?.recording?.recording_url_public,
    retellCallDetails?.recording_url,
    retellCallDetails?.recordingUrl,
    retellCallDetails?.scrubbed_recording_url,
    retellCallDetails?.recording_multi_channel_url,
    retellCallDetails?.scrubbed_recording_multi_channel_url
  );
}

async function fetchRetellCallById(callId: string): Promise<any | null> {
  const apiKey = safeString(process.env.RETELL_API_KEY).trim();
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const r = await fetch(
      `https://api.retellai.com/v2/get-call/${encodeURIComponent(callId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!r.ok) {
      console.warn(`[RETELL] get-call failed ${r.status} for callId=${callId}`);
      return null;
    }

    return await r.json();
  } catch (err: any) {
    console.warn(
      `[RETELL] get-call error for callId=${callId}: ${err?.message ?? "unknown"}`
    );
    return null;
  }
}

function normalizeEvent(event: any): string {
  return String(event || "").trim().toLowerCase();
}

function isAnalyzedEvent(e: string) {
  return e === "call_analyzed" || e === "call.analyzed";
}

function isFinalEvent(e: string) {
  return (
    e === "call_completed" ||
    e === "call.completed" ||
    e === "call_ended" ||
    e === "call.ended"
  );
}

function isInboundEvent(e: string) {
  return e === "call_inbound" || e === "call.inbound";
}

function normalizeDirection(value: any): string | undefined {
  const direction = String(value ?? "").trim().toLowerCase();
  return direction || undefined;
}

const recentNewCallAlertIds = new Map<string, number>();
const NEW_CALL_ALERT_CACHE_TTL_MS = 1000 * 60 * 60 * 6;

function hasRecentNewCallAlert(callId: string): boolean {
  const now = Date.now();
  recentNewCallAlertIds.forEach((ts, cachedCallId) => {
    if (now - ts > NEW_CALL_ALERT_CACHE_TTL_MS) {
      recentNewCallAlertIds.delete(cachedCallId);
    }
  });

  const sentAt = recentNewCallAlertIds.get(callId);
  return typeof sentAt === "number" && now - sentAt <= NEW_CALL_ALERT_CACHE_TTL_MS;
}

function rememberNewCallAlert(callId: string) {
  recentNewCallAlertIds.set(callId, Date.now());
}

function mapStatusFromAnalysis(
  analysis: any
): "pendiente" | "en_espera_aceptacion" | "asignada" {
  // New calls must always enter as pending. Assignment flow updates this later.
  return "pendiente";
}

function toTimeMs(v: any): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return 0;
}

function normalizeUserRole(v: any): "admin" | "agent" | "abogado" | null {
  const role = String(v ?? "")
    .toLowerCase()
    .trim();
  if (role === "admin" || role === "agent" || role === "abogado") return role;
  return null;
}

function normalizeCrmStatus(v: any): string {
  const s = String(v ?? "")
    .toLowerCase()
    .trim();

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

function normalizeEmail(v: any): string {
  return safeString(v).toLowerCase().trim();
}

function buildFallbackLeadName(phoneNumber?: string): string {
  const digits = safeString(phoneNumber).replace(/\D+/g, "");
  if (!digits) return "Cliente sin identificar";
  return `Cliente ${digits.slice(-4)}`;
}

async function ensureLeadLinkedToCall(input: {
  retellCallId: string;
  existingLeadId?: number | null;
  phoneNumber?: string;
  name?: string;
  caseType?: string;
  urgency?: string;
  transcript?: string;
  summary?: string;
  status?: string;
}): Promise<number | undefined> {
  const retellCallId = safeString(input.retellCallId).trim();
  if (!retellCallId) return undefined;

  const existingLeadId = Number(input.existingLeadId ?? 0);
  if (Number.isFinite(existingLeadId) && existingLeadId > 0) {
    return existingLeadId;
  }

  const existingLead = await storage.getLeadByRetellCallId(retellCallId);
  if (existingLead) return existingLead.id;

  const phoneNumber = safeString(input.phoneNumber).trim();
  const created = await storage.createLead({
    retellCallId,
    name: safeString(input.name).trim() || buildFallbackLeadName(phoneNumber),
    phone: phoneNumber || "Sin numero",
    caseType: safeString(input.caseType).trim() || "General",
    urgency: safeString(input.urgency).trim() || "Medium",
    transcript: safeString(input.transcript).trim() || undefined,
    summary: safeString(input.summary).trim() || undefined,
    status: normalizeCrmStatus(input.status ?? "pendiente"),
  } as any);

  return created.id;
}

async function persistInboundPlaceholderAndLead(input: {
  fromNumber: string;
  toNumber?: string;
  sourceEvent?: string;
  createdAt?: number;
}) {
  const placeholder = await storage.upsertInboundPlaceholder({
    fromNumber: input.fromNumber,
    toNumber: input.toNumber || undefined,
    sourceEvent: input.sourceEvent,
    createdAt: input.createdAt ?? Date.now(),
  });

  const placeholderRetellCallId = safeString((placeholder as any)?.retellCallId).trim();
  const placeholderLeadId = Number((placeholder as any)?.leadId ?? 0);
  const linkedLeadId = await ensureLeadLinkedToCall({
    retellCallId: placeholderRetellCallId,
    existingLeadId: placeholderLeadId,
    phoneNumber: input.fromNumber,
    status: "pendiente",
  });

  if (
    placeholderRetellCallId &&
    Number.isFinite(linkedLeadId) &&
    linkedLeadId! > 0 &&
    (!Number.isFinite(placeholderLeadId) || placeholderLeadId <= 0)
  ) {
    await storage.updateCallLogByRetellCallId(placeholderRetellCallId, {
      leadId: linkedLeadId,
    } as any);
  }

  return {
    placeholder,
    linkedLeadId: Number.isFinite(linkedLeadId) ? linkedLeadId : undefined,
  };
}

type EmailDecision = "accept" | "reject";

function getEmailDecisionSecret(): string {
  return (
    safeString(process.env.EMAIL_DECISION_SECRET).trim() ||
    safeString(process.env.SESSION_SECRET).trim()
  );
}

function getEmailDecisionTtlMs(): number {
  const raw = Number(process.env.EMAIL_DECISION_TTL_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 1000 * 60 * 60 * 72;
}

function signEmailDecisionToken(input: {
  callId: string;
  attorneyId: string;
  decision: EmailDecision;
  exp: number;
}): string {
  const secret = getEmailDecisionSecret();
  if (!secret) throw new Error("EMAIL_DECISION_SECRET no esta configurado");
  const payload = `${input.callId}|${input.attorneyId}|${input.decision}|${input.exp}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function verifyEmailDecisionToken(input: {
  callId: string;
  attorneyId: string;
  decision: EmailDecision;
  exp: number;
  sig: string;
}): boolean {
  const expected = signEmailDecisionToken({
    callId: input.callId,
    attorneyId: input.attorneyId,
    decision: input.decision,
    exp: input.exp,
  });
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(input.sig));
  } catch {
    return false;
  }
}

function renderEmailDecisionResult(
  res: any,
  opts: { title: string; message: string; ok?: boolean; statusCode?: number }
) {
  const { title, message, ok = false, statusCode = 200 } = opts;
  const bg = ok ? "#ecfdf5" : "#fef2f2";
  const border = ok ? "#bbf7d0" : "#fecaca";
  const text = ok ? "#166534" : "#991b1b";
  return res.status(statusCode).type("html").send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
      </head>
      <body style="margin:0;padding:24px;font-family:Arial,sans-serif;background:#f9fafb;">
        <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;">
          <h2 style="margin:0 0 12px 0;">${title}</h2>
          <div style="background:${bg};border:1px solid ${border};color:${text};padding:12px;border-radius:10px;">
            ${message}
          </div>
          <p style="margin-top:14px;color:#6b7280;font-size:13px;">Puedes cerrar esta ventana.</p>
        </div>
      </body>
    </html>
  `);
}

function callLogMatchesAttorney(log: any, attorneyId: string): boolean {
  const cleanAttorneyId = safeString(attorneyId).trim();
  if (!cleanAttorneyId) return false;
  const status = safeString((log as any)?.status).toLowerCase();
  const assignmentStatus = safeString((log as any)?.assignmentStatus).toLowerCase();
  const assignedAttorneyId = safeString(log?.attorneyId || log?.pendingAttorneyId).trim();
  if (status !== "asignada" && status !== "finalizado") return false;
  if (assignmentStatus !== "delivered" && assignmentStatus !== "closed") return false;
  return assignedAttorneyId === cleanAttorneyId;
}

function computeDashboardStatsFromLeads(leads: any[]) {
  const totalLeads = leads.length;
  const qualifiedLeads = leads.filter(
    (l) => safeString((l as any)?.status).toLowerCase() === "en_espera_aceptacion"
  ).length;
  const convertedLeads = leads.filter(
    (l) => {
      const status = safeString((l as any)?.status).toLowerCase();
      return status === "asignada" || status === "finalizado";
    }
  ).length;
  const diffs = leads
    .map((l) =>
      (l as any)?.lastContactedAt && (l as any)?.createdAt
        ? toTimeMs((l as any).lastContactedAt) - toTimeMs((l as any).createdAt)
        : null
    )
    .filter((x): x is number => typeof x === "number" && x > 0);
  const avgMs = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
  return {
    totalLeads,
    qualifiedLeads,
    convertedLeads,
    avgResponseTimeMinutes: Math.round(avgMs / 60000),
  };
}

async function resolveAttorneyIdForUser(user: any): Promise<string | null> {
  const userId = safeString(user?.id).trim();
  if (userId) {
    const attorneyById = await storage.getAttorney(userId);
    const attorneyIdById = safeString((attorneyById as any)?.id).trim();
    if (attorneyIdById) return attorneyIdById;
  }

  const userEmail = normalizeEmail(user?.email);
  if (!userEmail) return null;

  const attorneys = await storage.getAttorneys({ q: userEmail });
  const me = attorneys.find(
    (a: any) => normalizeEmail((a as any)?.email) === userEmail
  );
  const attorneyIdByEmail = safeString((me as any)?.id).trim();
  return attorneyIdByEmail || null;
}

function toPublicUser(u: any) {
  return {
    id: String(u?.id ?? ""),
    email: String(u?.email ?? ""),
    name: String(u?.name ?? ""),
    role: normalizeUserRole(u?.role) ?? "agent",
    isActive: Number(u?.isActive ?? 1),
    createdAt: Number(u?.createdAt ?? 0),
    updatedAt: Number(u?.updatedAt ?? 0),
  };
}


/* ============================================================
   ROUTES
============================================================ */

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  

  /* ================= AUTH GUARD ================= */

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    if (req.method === "OPTIONS") return next();
    if (req.path.startsWith("/api/auth")) return next();
    if (req.path.startsWith("/api/attorney/email-decision")) return next();

    const cleanPath = req.path.replace(/\/+$/, "");
    const retellPath = api.webhooks.retell.path.replace(/\/+$/, "");

    if (cleanPath === retellPath || cleanPath === "/api/webhook")
      return next();

    return requireAuth(req as any, res as any, next);
  });

  /* ============================================================
     AI ASSISTANT (CONSULTIVO)
  ============================================================ */
  /* ============================================================
     AI ASSISTANT (CONSULTIVO)
  ============================================================ */

  app.post("/api/ai-assistant", async (req, res) => {
    try {
      const message = safeString(req.body?.message).trim();
      if (!message) {
        return res.status(400).json({ error: "Message required" });
      }

      const msg = message.toLowerCase();

      // 🔥 OBTENER CLIENTE CORRECTO DE CONVEX
      const { client, api: convexGeneratedApi } = convexClient();

      let leadsData: any[] = [];
let callsData: any[] = [];
let structuredContext = "No leads data requested or available.";

const wantsLeads =
  msg.includes("lead") ||
  msg.includes("cliente") ||
  msg.includes("clientes") ||
  msg.includes("pendiente") ||
  msg.includes("asignada") ||
  msg.includes("asignados") ||
  msg.includes("cuántos") ||
  msg.includes("cuantos");

if (wantsLeads) {
  const allLeads = await client.query(convexGeneratedApi.leads.list, {});

  const totalLeadsCount = allLeads.length;

  const pendingCount = allLeads.filter(
    (l: any) => String(l.status).toLowerCase() === "pendiente"
  ).length;

  const assignedCount = allLeads.filter(
    (l: any) => String(l.status).toLowerCase() === "asignada"
  ).length;

  leadsData = allLeads.slice(0, 10).map((l: any) => ({
    id: l.id,
    name: l.name,
    status: l.status,
    caseType: l.caseType,
    urgency: l.urgency,
    createdAt: l.createdAt,
  }));

  structuredContext = `
LEADS SUMMARY:
Total leads (real): ${totalLeadsCount}
Pending leads (real): ${pendingCount}
Assigned leads (real): ${assignedCount}
Showing first ${leadsData.length} records:

${JSON.stringify(leadsData, null, 2)}
`;
}
      // 🔎 Traer llamadas si la intención lo sugiere
      if (msg.includes("call") || msg.includes("llamada")) {
  const allCalls = await client.query(
    convexGeneratedApi.callLogs.listWithLead,
    {}
  );

  const totalCalls = allCalls.length;

  const endedCalls = allCalls.filter(
    (c: any) => String(c.status).toLowerCase() === "ended"
  ).length;

  callsData = allCalls.slice(0, 10);

  structuredContext += `

CALLS SUMMARY:
Total calls (real): ${totalCalls}
Ended calls: ${endedCalls}
Showing first ${callsData.length} records:

${JSON.stringify(callsData, null, 2)}
`;
}

      // 🧠 Enviar contexto a OpenRouter
      const completion = await openrouter.chat.completions.create({
        model: "openai/gpt-4o-mini",
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: `
You are a senior CRM data analyst inside a law firm.

STRICT RULES:
- You MUST answer only using the provided CRM DATA.
- You MUST count and analyze the data explicitly before answering.
- If the data is empty, say clearly: "There is no data available."
- Never invent information.
- Be precise and numerical when possible.
- If the question asks for totals, compute them.
- If the question asks for pending leads, filter by status = "pendiente".
- Respond in Spanish.
`
          },
          {
            role: "user",
            content: `
USER QUESTION:
${message}

CRM DATA:
${structuredContext}

Recent Calls:
${JSON.stringify(callsData, null, 2)}
            `,
          },
        ],
      });

      return res.json({
        reply: completion.choices[0].message.content ?? "",
      });

    } catch (error) {
      console.error("AI Error:", error);
      return res.status(500).json({ error: "AI assistant failed" });
    }
  });
  /* ================= USERS (ADMIN) ================= */

  app.get("/api/users", requireAdmin as any, async (_req, res) => {
    try {
      const users = await storage.listUsers();
      return res.json(users.map((u: any) => toPublicUser(u)));
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to fetch users" });
    }
  });

  app.post("/api/users", requireAdmin as any, async (req, res) => {
    try {
      const email = safeString(req.body?.email).toLowerCase().trim();
      const name = safeString(req.body?.name).trim();
      const role = normalizeUserRole(req.body?.role);
      const password = safeString(req.body?.password);

      if (!email || !name || !role || password.length < 8) {
        return res.status(400).json({
          message:
            "email, name, role (admin|agent|abogado) y password (>=8) son obligatorios",
        });
      }

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "Ese email ya existe" });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const created = await storage.createUser({
        email,
        name,
        role,
        passwordHash,
      });

      return res.status(201).json(toPublicUser(created));
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to create user" });
    }
  });

  app.patch("/api/users/:id/active", requireAdmin as any, async (req, res) => {
    try {
      const id = safeString(req.params.id).trim();
      const isActiveRaw = req.body?.isActive;
      const isActive =
        typeof isActiveRaw === "boolean"
          ? isActiveRaw
          : String(isActiveRaw ?? "")
              .toLowerCase()
              .trim() === "true";

      if (!id) {
        return res.status(400).json({ message: "id es obligatorio" });
      }

      const updated = await storage.setUserActive(id, isActive);
      return res.json(toPublicUser(updated));
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to update user" });
    }
  });

  /* ================= CALL LOGS ================= */

  app.get("/api/call-logs", async (req: any, res) => {
    const logs = await storage.getCallLogs();
    const role = normalizeUserRole(req.user?.role) ?? "agent";
    if (role !== "abogado") return res.json(logs);

    const attorneyId = await resolveAttorneyIdForUser(req.user);
    if (!attorneyId) return res.json([]);

    const filtered = logs.filter((log: any) => callLogMatchesAttorney(log, attorneyId));
    return res.json(filtered);
  });

  app.patch("/api/call-logs/:retellCallId/details", async (req, res) => {
    try {
      const retellCallId = safeString(req.params.retellCallId).trim();
      if (!retellCallId) {
        return res.status(400).json({ message: "retellCallId es obligatorio" });
      }

      const existing = await storage.getCallLogByRetellCallId(retellCallId);
      if (!existing) {
        return res.status(404).json({ message: "Call log no encontrado" });
      }

      const updates: Record<string, any> = {};
      const mapField = (key: string) => {
        if (hasOwn(req.body, key)) {
          updates[key] = safeString(req.body?.[key]).trim();
        }
      };

      mapField("email");
      mapField("address");
      mapField("city");
      if (hasOwn(req.body, "state")) {
        updates.stateProvince = safeString(req.body?.state).trim();
      }
      mapField("stateProvince");
      mapField("location");
      mapField("caseType");
      mapField("caseNotes");
      if (
        hasOwn(req.body, "extraFields") &&
        Array.isArray(req.body?.extraFields)
      ) {
        updates.extraFields = req.body.extraFields
          .map((item: any) => ({
            label: safeString(item?.label).trim(),
            value: safeString(item?.value).trim(),
          }))
          .filter((item: any) => item.label || item.value);
      }

      if (!updates.location) {
        const fallbackLocation = [updates.city, updates.stateProvince]
          .filter((value) => safeString(value).trim().length > 0)
          .join(", ");
        if (fallbackLocation) {
          updates.location = fallbackLocation;
        }
      }

      if (!Object.keys(updates).length) {
        return res.status(400).json({ message: "No hay campos para actualizar" });
      }

      const updatedCall = await storage.updateCallLogByRetellCallId(
        retellCallId,
        updates as any
      );

      const leadId = Number((updatedCall as any)?.leadId ?? 0);
      if (Number.isFinite(leadId) && leadId > 0) {
        const leadPatch: any = {};
        if (hasOwn(updates, "caseType")) {
          leadPatch.caseType = updates.caseType;
        }
        if (hasOwn(updates, "email")) {
          leadPatch.email = updates.email;
        }
        if (hasOwn(updates, "city")) {
          leadPatch.city = updates.city;
        }
        if (Object.keys(leadPatch).length > 0) {
          await storage.updateLead(leadId, leadPatch);
        }
      }

      return res.json(updatedCall);
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to update call details" });
    }
  });

  app.post("/api/call-logs/:retellCallId/send-to-attorney", async (req: any, res) => {
    try {
      const role = normalizeUserRole(req.user?.role) ?? "agent";
      if (role === "abogado") {
        return res.status(403).json({ message: "No autorizado" });
      }

      const retellCallId = safeString(req.params.retellCallId).trim();
      if (!retellCallId) {
        return res.status(400).json({ message: "retellCallId es obligatorio" });
      }

      const call = await storage.getCallLogByRetellCallId(retellCallId);
      if (!call) {
        return res.status(404).json({ message: "Call log no encontrado" });
      }

      const status = safeString((call as any)?.status).toLowerCase();
      if (status !== "asignada") {
        return res.status(400).json({
          message: "Solo se puede enviar al abogado cuando el caso ya fue aceptado",
        });
      }
      const assignmentStatus = safeString((call as any)?.assignmentStatus).toLowerCase();
      if (assignmentStatus === "delivered") {
        return res.json({
          success: true,
          alreadySent: true,
          to: normalizeEmail((call as any)?.attorneyEmail ?? ""),
          retellCallId,
        });
      }
      if (assignmentStatus !== "accepted") {
        return res.status(400).json({
          message: "El abogado aun no ha aceptado el caso por correo",
        });
      }

      const leadId = Number((call as any)?.leadId ?? 0);
      const lead =
        Number.isFinite(leadId) && leadId > 0
          ? await storage.getLead(leadId)
          : undefined;
      const attorneyId =
        pickFirstString(
          (call as any)?.attorneyId,
          (lead as any)?.attorneyId,
          (call as any)?.pendingAttorneyId
        ) ?? "";
      if (!attorneyId) {
        return res.status(400).json({ message: "No hay abogado asignado en este caso" });
      }

      const attorney = await storage.getAttorney(attorneyId);
      const to = normalizeEmail((attorney as any)?.email);
      if (!to) {
        return res.status(400).json({ message: "El abogado no tiene correo configurado" });
      }

      const leadName =
        pickFirstString(
          (lead as any)?.name,
          (call as any)?.leadName,
          (call as any)?.analysis?.custom_analysis_data?.name
        ) ?? "Lead";
      const caseType =
        pickFirstString(
          (call as any)?.caseType,
          (lead as any)?.caseType
        ) ?? "General";
      const urgency =
        pickFirstString(
          (call as any)?.urgency,
          (lead as any)?.urgency
        ) ?? "Medium";
      const summary =
        pickFirstString(
          (call as any)?.summary,
          (call as any)?.analysis?.call_summary,
          (call as any)?.analysis?.post_call_analysis?.call_summary,
          (lead as any)?.summary
        ) ?? "Sin resumen";
      const notes =
        pickFirstString(
          safeString(req.body?.notes).trim(),
          safeString((call as any)?.assignmentNotes).trim()
        ) ?? undefined;

      await sendAttorneyAssignmentEmail({
        to,
        leadName,
        caseType,
        urgency,
        summary,
        notes,
      });
      await storage.updateCallLogByRetellCallId(retellCallId, {
        assignmentStatus: "delivered",
      } as any);

      return res.json({
        success: true,
        to,
        attorneyId,
        retellCallId,
      });
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to send case to attorney" });
    }
  });

  /* ================= LEADS ================= */

  app.get(api.leads.list.path, async (req, res) => {
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const leads = await storage.getLeads(search, status);
    res.json(leads);
  });

  app.get(api.leads.get.path, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ message: "leadId invalido" });
    }

    const lead = await storage.getLead(id);
    if (!lead) {
      return res.status(404).json({ message: "Lead no encontrado" });
    }

    return res.json(lead);
  });

  app.patch(api.leads.update.path, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ message: "leadId invalido" });
      }

      const existing = await storage.getLead(id);
      if (!existing) {
        return res.status(404).json({ message: "Lead no encontrado" });
      }

      const updates: any = { ...(req.body ?? {}) };
      if (hasOwn(updates, "status")) {
        updates.status = normalizeCrmStatus(updates.status);
      }

      const updated = await storage.updateLead(id, updates);
      return res.json(updated);
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to update lead" });
    }
  });

  app.get(api.leads.stats.path, async (req: any, res) => {
    const role = normalizeUserRole(req.user?.role) ?? "agent";
    if (role !== "abogado") {
      const stats = await storage.getDashboardStats();
      return res.json(stats);
    }

    const attorneyId = await resolveAttorneyIdForUser(req.user);
    if (!attorneyId) {
      return res.json({
        totalLeads: 0,
        qualifiedLeads: 0,
        convertedLeads: 0,
        avgResponseTimeMinutes: 0,
      });
    }

    const [allLeads, logs] = await Promise.all([
      storage.getLeads(),
      storage.getCallLogs(),
    ]);

    const relatedLeadIds = new Set<number>();
    for (const log of logs) {
      if (!callLogMatchesAttorney(log, attorneyId)) continue;
      const leadId = Number((log as any)?.leadId);
      if (Number.isFinite(leadId) && leadId > 0) {
        relatedLeadIds.add(leadId);
      }
    }

    const myLeads = allLeads.filter((lead: any) => {
      const leadAttorneyId = safeString((lead as any)?.attorneyId).trim();
      const leadId = Number((lead as any)?.id);
      return (
        leadAttorneyId === attorneyId ||
        (Number.isFinite(leadId) && relatedLeadIds.has(leadId))
      );
    });

    return res.json(computeDashboardStatsFromLeads(myLeads));
  });

  app.post("/api/leads/:id/assign-attorney", async (req, res) => {
    try {
      const rawLeadId = Number(req.params.id);
      const leadId = Number.isFinite(rawLeadId) && rawLeadId > 0 ? rawLeadId : null;
      const attorneyId = safeString(req.body?.attorneyId).trim();
      const retellCallId = safeString(req.body?.retellCallId).trim();
      const assignmentNotes = safeString(req.body?.assignmentNotes).trim();
      if (!Number.isFinite(rawLeadId)) {
        return res.status(400).json({ message: "leadId invalido" });
      }
      if (!attorneyId) {
        return res.status(400).json({ message: "attorneyId es obligatorio" });
      }
      const [leadById, attorney] = await Promise.all([
        leadId ? storage.getLead(leadId) : Promise.resolve(undefined),
        storage.getAttorney(attorneyId),
      ]);
      if (!attorney) {
        return res.status(404).json({ message: "Abogado no encontrado" });
      }
      const logs = await storage.getCallLogs();
      const targetLog =
        (retellCallId
          ? logs.find(
              (l: any) =>
                String(l?.retellCallId ?? "") === retellCallId &&
                (!leadId || Number(l?.leadId ?? 0) === leadId)
            )
          : null) ??
        (leadId
          ? logs
              .filter((l: any) => Number(l?.leadId) === leadId)
              .sort(
                (a: any, b: any) => toTimeMs(b?.createdAt) - toTimeMs(a?.createdAt)
              )[0]
          : null) ??
        null;
      if (!targetLog?.retellCallId) {
        return res.status(404).json({
          message: "No encontre call log para este lead",
        });
      }
      const effectiveLead =
        leadById ??
        (await storage.createLead({
          retellCallId: String(targetLog.retellCallId),
          name:
            pickFirstString(
              (targetLog as any)?.leadName,
              (targetLog as any)?.analysis?.custom_analysis_data?.name
            ) ?? "Lead",
          phone:
            pickFirstString(
              (targetLog as any)?.phoneNumber,
              (targetLog as any)?.phone,
              (targetLog as any)?.from_number,
              (targetLog as any)?.analysis?.from_number,
              (targetLog as any)?.analysis?.post_call_data?.phone
            ) ?? "Unknown",
          caseType:
            pickFirstString(
              (targetLog as any)?.caseType,
              (targetLog as any)?.analysis?.case_type,
              (targetLog as any)?.analysis?.post_call_data?.case_type
            ) ?? "General",
          urgency:
            pickFirstString(
              (targetLog as any)?.urgency,
              (targetLog as any)?.analysis?.custom_analysis_data?.urgency
            ) ?? "Medium",
          summary:
            pickFirstString(
              (targetLog as any)?.summary,
              (targetLog as any)?.analysis?.call_summary,
              (targetLog as any)?.analysis?.post_call_analysis?.call_summary
            ) ?? undefined,
          transcript:
            pickFirstString(
              (targetLog as any)?.transcript,
              (targetLog as any)?.analysis?.transcript
            ) ?? undefined,
          status: "pendiente",
        } as any));
      const effectiveLeadId = Number((effectiveLead as any)?.id ?? 0);
      if (!Number.isFinite(effectiveLeadId) || effectiveLeadId <= 0) {
        return res.status(400).json({ message: "No se pudo resolver lead para asignar" });
      }

      const updatedLead = await storage.updateLead(effectiveLeadId, {
        status: "en_espera_aceptacion",
      } as any);
      const assignedCall = await storage.updateCallLogByRetellCallId(
        String(targetLog.retellCallId),
        {
          leadId: effectiveLeadId,
          status: "pendiente_aprobacion_abogado",
          pendingAttorneyId: attorneyId,
          assignmentStatus: "pending",
          assignmentNotes: assignmentNotes || undefined,
          assignmentRequestedAt: Date.now(),
        } as any
      );
      const appBaseUrl =
        process.env.APP_URL?.trim() || `${req.protocol}://${req.get("host")}`;
      const callIdForEmail = String(assignedCall?.retellCallId ?? "");
      const emailDecisionExp = Date.now() + getEmailDecisionTtlMs();
      const acceptSig = signEmailDecisionToken({
        callId: callIdForEmail,
        attorneyId,
        decision: "accept",
        exp: emailDecisionExp,
      });
      const rejectSig = signEmailDecisionToken({
        callId: callIdForEmail,
        attorneyId,
        decision: "reject",
        exp: emailDecisionExp,
      });
      const acceptUrl = `${appBaseUrl}/api/attorney/email-decision?callId=${encodeURIComponent(
        callIdForEmail
      )}&attorneyId=${encodeURIComponent(attorneyId)}&decision=accept&exp=${emailDecisionExp}&sig=${encodeURIComponent(
        acceptSig
      )}`;
      const rejectUrl = `${appBaseUrl}/api/attorney/email-decision?callId=${encodeURIComponent(
        callIdForEmail
      )}&attorneyId=${encodeURIComponent(attorneyId)}&decision=reject&exp=${emailDecisionExp}&sig=${encodeURIComponent(
        rejectSig
      )}`;
      const summary =
        pickFirstString(
          (assignedCall as any)?.summary,
          (targetLog as any)?.summary,
          (targetLog as any)?.analysis?.call_summary,
          (targetLog as any)?.analysis?.post_call_analysis?.call_summary,
          (updatedLead as any)?.summary
        ) ?? "Sin resumen";
      const leadName =
        pickFirstString(
          (updatedLead as any)?.name,
          (targetLog as any)?.leadName,
          (targetLog as any)?.analysis?.custom_analysis_data?.name
        ) ?? "Lead";
      const caseType =
        pickFirstString(
          (assignedCall as any)?.caseType,
          (targetLog as any)?.caseType,
          (updatedLead as any)?.caseType
        ) ?? "General";
      const urgency =
        pickFirstString(
          (assignedCall as any)?.urgency,
          (targetLog as any)?.urgency,
          (updatedLead as any)?.urgency
        ) ?? "Medium";
      let mailSent = false;
      let mailError: string | null = null;
      try {
        await sendAttorneyAssignmentEmail({
          to: String((attorney as any).email ?? ""),
          leadName,
          caseType,
          urgency,
          summary,
          notes: assignmentNotes || undefined,
          acceptUrl,
          rejectUrl,
        });
        mailSent = true;
      } catch (err: any) {
        mailError = err?.message ?? "No se pudo enviar correo";
        console.error("Assignment mail error:", err);
      }
      return res.json({
        success: true,
        lead: updatedLead,
        attorney,
        call: assignedCall,
        assignedCallUrl: `${appBaseUrl}/attorney-call?callId=${encodeURIComponent(
          String(assignedCall?.retellCallId ?? "")
        )}`,
        assignmentPayload: {
          attorneyName: String((attorney as any).name ?? "Abogado"),
          attorneyEmail: String((attorney as any).email ?? ""),
          leadName,
          caseType,
          urgency,
          summary,
          notes: assignmentNotes || null,
        },
        mailSent,
        mailError,
      });
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to assign attorney" });
    }
  });

  const notifyDecisionInbox = async (params: {
    decision: EmailDecision;
    attorneyId?: string | null;
    leadId?: number | null;
    notes?: string | null;
  }) => {
    try {
      const attorneyId = safeString(params.attorneyId).trim();
      const leadId = Number(params.leadId ?? 0);
      const [attorney, lead] = await Promise.all([
        attorneyId ? storage.getAttorney(attorneyId) : Promise.resolve(undefined),
        Number.isFinite(leadId) && leadId > 0
          ? storage.getLead(leadId)
          : Promise.resolve(undefined),
      ]);

      await sendAttorneyDecisionEmail({
        decision: params.decision,
        attorneyName: safeString((attorney as any)?.name) || null,
        attorneyEmail: safeString((attorney as any)?.email) || null,
        caseType: safeString((lead as any)?.caseType) || null,
        notes: safeString(params.notes) || null,
      });
    } catch (err) {
      console.error("Decision inbox mail error:", err);
    }
  };

  app.get("/api/attorney/email-decision", async (req: any, res) => {
    try {
      const callId = safeString(req.query?.callId).trim();
      const attorneyId = safeString(req.query?.attorneyId).trim();
      const decision = safeString(req.query?.decision).trim().toLowerCase();
      const sig = safeString(req.query?.sig).trim();
      const exp = Number(req.query?.exp ?? 0);

      if (!callId || !attorneyId || !sig || !Number.isFinite(exp)) {
        return renderEmailDecisionResult(res, {
          title: "Solicitud invalida",
          message: "Faltan parametros para procesar la decision.",
          statusCode: 400,
        });
      }
      if (decision !== "accept" && decision !== "reject") {
        return renderEmailDecisionResult(res, {
          title: "Solicitud invalida",
          message: "La decision no es valida.",
          statusCode: 400,
        });
      }
      if (Date.now() > exp) {
        return renderEmailDecisionResult(res, {
          title: "Enlace expirado",
          message: "Este enlace ya vencio. Solicita una nueva asignacion.",
          statusCode: 410,
        });
      }
      if (
        !verifyEmailDecisionToken({
          callId,
          attorneyId,
          decision,
          exp,
          sig,
        })
      ) {
        return renderEmailDecisionResult(res, {
          title: "Solicitud no valida",
          message: "La firma del enlace no es valida.",
          statusCode: 401,
        });
      }

      const call = await storage.getCallLogByRetellCallId(callId);
      if (!call) {
        return renderEmailDecisionResult(res, {
          title: "Llamada no encontrada",
          message: "No se encontro la llamada asociada a este enlace.",
          statusCode: 404,
        });
      }

      const currentStatus = safeString((call as any)?.status).toLowerCase();
      if (currentStatus === "asignada" || currentStatus === "rechazada_por_abogado") {
        return renderEmailDecisionResult(res, {
          title: "Decision ya procesada",
          message: "Este caso ya fue procesado previamente.",
          ok: true,
        });
      }

      const pendingAttorneyId = safeString((call as any)?.pendingAttorneyId).trim();
      if (pendingAttorneyId && pendingAttorneyId !== attorneyId) {
        return renderEmailDecisionResult(res, {
          title: "No autorizado",
          message: "Este enlace ya no corresponde al abogado actual.",
          statusCode: 403,
        });
      }

      const leadId = Number((call as any)?.leadId ?? 0);
      if (!Number.isFinite(leadId) || leadId <= 0) {
        return renderEmailDecisionResult(res, {
          title: "Lead no valido",
          message: "La llamada no tiene lead valido para actualizar.",
          statusCode: 400,
        });
      }

      if (decision === "accept") {
        await storage.assignAttorneyToLead(leadId, attorneyId);
        await storage.updateLead(leadId, { status: "asignada" } as any);
        await storage.updateCallLogByRetellCallId(callId, {
          status: "asignada",
          pendingAttorneyId: attorneyId,
          assignmentStatus: "accepted",
          assignmentDecisionAt: Date.now(),
          assignmentDecisionByAttorneyId: attorneyId,
        } as any);
        await notifyDecisionInbox({
          decision: "accept",
          attorneyId,
          leadId,
        });
        return renderEmailDecisionResult(res, {
          title: "Caso aceptado",
          message: "Tu decision fue registrada: ACEPTADA por abogado.",
          ok: true,
        });
      }

      await storage.updateLead(leadId, { status: "pendiente" } as any);
      await storage.updateCallLogByRetellCallId(callId, {
        status: "rechazada_por_abogado",
        assignmentStatus: "rejected",
        assignmentDecisionAt: Date.now(),
        assignmentDecisionByAttorneyId: attorneyId,
      } as any);
      await notifyDecisionInbox({
        decision: "reject",
        attorneyId,
        leadId,
      });
      return renderEmailDecisionResult(res, {
        title: "Caso rechazado",
        message: "Tu decision fue registrada: RECHAZADA. El caso queda para reasignar.",
        ok: true,
      });
    } catch (err: any) {
      console.error("Email decision error:", err);
      return renderEmailDecisionResult(res, {
        title: "Error",
        message: err?.message ?? "No se pudo procesar la decision.",
        statusCode: 500,
      });
    }
  });

  app.post("/api/attorney/call-decision", async (req: any, res) => {
    try {
      const retellCallId = safeString(req.body?.retellCallId).trim();
      const decision = safeString(req.body?.decision).trim().toLowerCase();
      const notes = safeString(req.body?.notes).trim();
      if (!retellCallId) {
        return res.status(400).json({ message: "retellCallId es obligatorio" });
      }
      if (decision !== "accept" && decision !== "reject") {
        return res.status(400).json({ message: "decision invalida" });
      }
      const role = normalizeUserRole(req.user?.role) ?? "agent";
      if (role !== "abogado" && role !== "admin") {
        return res.status(403).json({ message: "No autorizado" });
      }
      const call = await storage.getCallLogByRetellCallId(retellCallId);
      if (!call) {
        return res.status(404).json({ message: "Call no encontrada" });
      }
      let actingAttorneyId = safeString((call as any).pendingAttorneyId).trim();
      if (role === "abogado") {
        const resolvedAttorneyId = await resolveAttorneyIdForUser(req.user);
        if (!resolvedAttorneyId) {
          return res.status(403).json({ message: "No encuentro tu perfil de abogado" });
        }
        actingAttorneyId = resolvedAttorneyId;
        const pendingAttorneyId = safeString((call as any).pendingAttorneyId).trim();
        if (pendingAttorneyId && pendingAttorneyId !== actingAttorneyId) {
          return res.status(403).json({ message: "Esta llamada no esta asignada para ti" });
        }
      }
      if (decision === "accept") {
        const effectiveAttorneyId =
          safeString((call as any).pendingAttorneyId).trim() || actingAttorneyId;
        if (!effectiveAttorneyId) {
          return res.status(400).json({ message: "No hay abogado pendiente en esta llamada" });
        }
        const leadId = Number((call as any).leadId ?? 0);
        if (!Number.isFinite(leadId) || leadId <= 0) {
          return res.status(400).json({ message: "La llamada no tiene leadId valido" });
        }
        await storage.assignAttorneyToLead(leadId, effectiveAttorneyId);
        await storage.updateLead(leadId, { status: "asignada" } as any);
        const updated = await storage.updateCallLogByRetellCallId(retellCallId, {
          status: "asignada",
          pendingAttorneyId: effectiveAttorneyId,
          assignmentStatus: "accepted",
          assignmentDecisionAt: Date.now(),
          assignmentDecisionByAttorneyId: effectiveAttorneyId,
          assignmentDecisionNotes: notes || undefined,
        } as any);
        await notifyDecisionInbox({
          decision: "accept",
          attorneyId: effectiveAttorneyId,
          leadId,
          notes: notes || null,
        });
        return res.json({ success: true, call: updated });
      }
      const rejectedLeadId = Number((call as any).leadId ?? 0);
      if (Number.isFinite(rejectedLeadId) && rejectedLeadId > 0) {
        await storage.updateLead(rejectedLeadId, { status: "pendiente" } as any);
      }
      const updated = await storage.updateCallLogByRetellCallId(retellCallId, {
        status: "rechazada_por_abogado",
        assignmentStatus: "rejected",
        assignmentDecisionAt: Date.now(),
        assignmentDecisionByAttorneyId: actingAttorneyId || undefined,
        assignmentDecisionNotes: notes || undefined,
      } as any);
      await notifyDecisionInbox({
        decision: "reject",
        attorneyId: actingAttorneyId || safeString((call as any).pendingAttorneyId).trim(),
        leadId: rejectedLeadId,
        notes: notes || null,
      });
      return res.json({ success: true, call: updated });
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to process attorney decision" });
    }
  });

  /* ================= ATTORNEYS ================= */

  app.get("/api/attorneys", async (req, res) => {
    try {
      const q = req.query.q as string | undefined;
      const city = req.query.city as string | undefined;
      const state = req.query.state as string | undefined;
      const specialty = req.query.specialty as string | undefined;

      const [attorneys, logs] = await Promise.all([
        storage.getAttorneys({
          q,
          city,
          state,
          specialty,
        }),
        storage.getCallLogs(),
      ]);

      const assignedCountByAttorneyId = new Map<string, number>();
      for (const log of logs) {
        const status = safeString((log as any)?.status).toLowerCase();
        const assignmentStatus = safeString((log as any)?.assignmentStatus).toLowerCase();
        const attorneyId = safeString((log as any)?.attorneyId).trim();
        if (!attorneyId) continue;
        if (status !== "asignada" || assignmentStatus !== "delivered") continue;
        assignedCountByAttorneyId.set(
          attorneyId,
          (assignedCountByAttorneyId.get(attorneyId) ?? 0) + 1
        );
      }

      return res.json(
        attorneys.map((attorney: any) => ({
          ...attorney,
          assignedCasesCount:
            assignedCountByAttorneyId.get(safeString((attorney as any)?.id).trim()) ?? 0,
        }))
      );
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to fetch attorneys" });
    }
  });

  app.post("/api/attorneys", async (req, res) => {
    try {
      const name = safeString(req.body?.name).trim();
      const email = normalizeEmail(req.body?.email);
      const password = safeString(req.body?.password);
      const notes = safeString(req.body?.notes).trim();
      const requestedId = safeString(req.body?.id).trim();
      const sharedId = requestedId || randomUUID();

      if (!name || !email || password.length < 8) {
        return res
          .status(400)
          .json({ message: "name, email y password (>=8) son obligatorios" });
      }

      const [existingUserByEmail, attorneysByEmail] = await Promise.all([
        storage.getUserByEmail(email),
        storage.getAttorneys({ q: email }),
      ]);
      const existingAttorneyByEmail = attorneysByEmail.find(
        (a: any) => normalizeEmail((a as any)?.email) === email
      );

      if (existingAttorneyByEmail) {
        return res.status(409).json({ message: "Ya existe un abogado con ese email" });
      }
      if (existingUserByEmail) {
        return res.status(409).json({ message: "Ya existe un usuario con ese email" });
      }

      if (requestedId) {
        const [existingUserById, existingAttorneyById] = await Promise.all([
          storage.getUserById(sharedId),
          storage.getAttorney(sharedId),
        ]);
        if (existingUserById) {
          return res.status(409).json({ message: "Ese id ya existe en users" });
        }
        if (existingAttorneyById) {
          return res.status(409).json({ message: "Ese id ya existe en attorneys" });
        }
      }

      const createdAttorney = await storage.createAttorney({
        id: sharedId,
        name,
        email,
        phone: pickFirstString(req.body?.phone, undefined),
        city: pickFirstString(req.body?.city, undefined),
        stateProvince: pickFirstString(
          req.body?.stateProvince,
          req.body?.state_province,
          undefined
        ),
        notes: notes || undefined,
        specialties: Array.isArray(req.body?.specialties)
          ? req.body.specialties
          : [],
      } as any);

      const passwordHash = await bcrypt.hash(password, 10);
      const createdUser = await storage.createUser({
        id: sharedId,
        email,
        name,
        role: "abogado",
        passwordHash,
      });

      return res.status(201).json({
        attorney: createdAttorney,
        user: toPublicUser(createdUser),
      });
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to create attorney" });
    }
  });

  app.get("/api/attorney/assigned-call", async (req: any, res) => {
    try {
      const role = normalizeUserRole(req.user?.role) ?? "agent";
      const requestedAttorneyId = safeString(req.query.attorneyId).trim();
      const callId = safeString(req.query.callId).trim();

      let attorneyId = requestedAttorneyId;

      if (role !== "admin") {
        const resolvedAttorneyId = await resolveAttorneyIdForUser(req.user);
        if (!resolvedAttorneyId) {
          return res.json({ call: null, attorneyId: null });
        }

        attorneyId = resolvedAttorneyId;
      }

      const logs = await storage.getCallLogs();

      const assignedLogs = logs
        .filter((l: any) => {
          const isAssignedForAttorney = attorneyId
            ? callLogMatchesAttorney(l, attorneyId)
            : (() => {
                const logStatus = String(l?.status ?? "").toLowerCase();
                const assignmentStatus = String((l as any)?.assignmentStatus ?? "").toLowerCase();
                return (
                  (logStatus === "asignada" || logStatus === "finalizado") &&
                  (assignmentStatus === "delivered" || assignmentStatus === "closed")
                );
              })();

          if (!isAssignedForAttorney) return false;

          if (!callId) return true;
          const rid = String(
            l?.retellCallId ?? l?.call_id ?? l?.callId ?? l?.id ?? ""
          );
          return rid === callId;
        })
        .sort((a: any, b: any) => toTimeMs(b?.createdAt) - toTimeMs(a?.createdAt));

      return res.json({
        calls: assignedLogs,
        call: assignedLogs[0] ?? null,
        attorneyId: attorneyId || null,
      });
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to fetch assigned call" });
    }
  });

  app.post("/api/attorney/close-case", async (req: any, res) => {
    try {
      const retellCallId = safeString(req.body?.retellCallId).trim();
      if (!retellCallId) {
        return res.status(400).json({ message: "retellCallId es obligatorio" });
      }

      const role = normalizeUserRole(req.user?.role) ?? "agent";
      if (role !== "abogado" && role !== "admin") {
        return res.status(403).json({ message: "No autorizado" });
      }

      const call = await storage.getCallLogByRetellCallId(retellCallId);
      if (!call) {
        return res.status(404).json({ message: "Call no encontrada" });
      }

      const currentStatus = safeString((call as any)?.status).toLowerCase();
      if (currentStatus !== "asignada" && currentStatus !== "finalizado") {
        return res
          .status(400)
          .json({ message: "Solo puedes cerrar casos activos asignados" });
      }

      const callAttorneyId = safeString(
        (call as any)?.attorneyId || (call as any)?.pendingAttorneyId
      ).trim();

      if (role === "abogado") {
        const resolvedAttorneyId = await resolveAttorneyIdForUser(req.user);
        if (!resolvedAttorneyId) {
          return res.status(403).json({ message: "No encuentro tu perfil de abogado" });
        }
        if (callAttorneyId && callAttorneyId !== resolvedAttorneyId) {
          return res.status(403).json({ message: "Este caso no esta asignado para ti" });
        }
      }

      const leadId = Number((call as any)?.leadId ?? 0);
      if (!Number.isFinite(leadId) || leadId <= 0) {
        return res.status(400).json({ message: "La llamada no tiene leadId valido" });
      }

      if (currentStatus !== "finalizado") {
        await storage.updateLead(leadId, { status: "finalizado" } as any);
      }

      const updated = await storage.updateCallLogByRetellCallId(retellCallId, {
        status: "finalizado",
        assignmentStatus: "closed",
      } as any);

      return res.json({ success: true, call: updated });
    } catch (err: any) {
      return res
        .status(500)
        .json({ message: err?.message ?? "Failed to close case" });
    }
  });

  /* ================= RETELL WEBHOOK ================= */

  const handleRetellWebhook = async (req: any, res: any) => {
    const payload = req.body || {};
    const payloadData = payload.data || {};
    const event = normalizeEvent(
      payload.event || payload.type || payloadData.event || payloadData.type
    );
    const inbound = payload.call_inbound || payloadData.call_inbound || payloadData || {};
    const quickCall = payload.call || payloadData.call || {};
    const quickCallId = pickFirstString(
      quickCall.call_id,
      quickCall.callId,
      quickCall.id,
      payloadData.call_id,
      payloadData.callId,
      payloadData.id,
      payload.call_id,
      payload.callId,
      payload.id,
      payloadData.call?.call_id,
      payloadData.call?.callId,
      payloadData.call?.id
    );

    try {
      if (isInboundEvent(event)) {
        const overrideAgentId = pickFirstString(
          inbound.override_agent_id,
          inbound.overrideAgentId,
          inbound.agent_id,
          inbound.agentId,
          payload.override_agent_id,
          payload.overrideAgentId,
          payload.agent_id,
          payload.agentId
        );
        const overrideAgentVersion = pickFirstString(
          inbound.override_agent_version,
          inbound.overrideAgentVersion,
          inbound.agent_version,
          inbound.agentVersion,
          payload.override_agent_version,
          payload.overrideAgentVersion,
          payload.agent_version,
          payload.agentVersion
        );

        res.status(200).json({
          call_inbound: {
            ...(overrideAgentId ? { override_agent_id: overrideAgentId } : {}),
            ...(overrideAgentVersion ? { override_agent_version: overrideAgentVersion } : {}),
          },
        });
      } else {
        res.status(200).json({ success: true });
      }
    } catch (ackErr: any) {
      console.error(
        `[RETELL] webhook ack failed event=${event || "unknown"} callId=${quickCallId || "none"}: ${
          ackErr?.message ?? "unknown"
        }`
      );
    }

    void (async () => {
      try {
        if (isInboundEvent(event)) {
          const fromNumber =
            pickFirstString(
              inbound.from_number,
              inbound.fromNumber,
              payload.from_number,
              payload.fromNumber
            ) ?? "";
          const toNumber =
            pickFirstString(
              inbound.to_number,
              inbound.toNumber,
              payload.to_number,
              payload.toNumber
            ) ?? "";

          let persistedInbound:
            | {
                placeholder: any;
                linkedLeadId?: number;
              }
            | undefined;

          if (fromNumber) {
            persistedInbound = await persistInboundPlaceholderAndLead({
              fromNumber,
              toNumber: toNumber || undefined,
              sourceEvent: event,
              createdAt: Date.now(),
            });
          }

          if (!fromNumber) return;

          try {
            const placeholder =
              persistedInbound?.placeholder ??
              (
                await persistInboundPlaceholderAndLead({
                  fromNumber,
                  toNumber: toNumber || undefined,
                  sourceEvent: event,
                  createdAt: Date.now(),
                })
              ).placeholder;

            const inboundAlertSent =
              typeof (placeholder as any)?.newCallAlertSentAt === "number" ||
              hasRecentNewCallAlert(String((placeholder as any)?.retellCallId ?? ""));

            if (!inboundAlertSent) {
              try {
                await sendNewCallAlertEmail({
                  to: "247tusabogadossocial@gmail.com",
                  retellCallId: String((placeholder as any)?.retellCallId ?? ""),
                  phoneNumber: fromNumber,
                  receivedAt: (placeholder as any)?.createdAt ?? Date.now(),
                });
                rememberNewCallAlert(String((placeholder as any)?.retellCallId ?? ""));
                await storage.updateCallLogByRetellCallId(
                  String((placeholder as any)?.retellCallId ?? ""),
                  {
                    newCallAlertSentAt: Date.now(),
                  } as any
                );
              } catch (alertErr: any) {
                console.error(
                  `[RETELL] inbound new call email alert failed from=${fromNumber}: ${
                    alertErr?.message ?? "unknown"
                  }`
                );
              }
            }
          } catch (inboundErr: any) {
            console.error(
              `[RETELL] inbound webhook background persistence failed from=${fromNumber}: ${
                inboundErr?.message ?? "unknown"
              }`
            );
          }

          return;
        }

        const call = payload.call || payloadData.call || {};
        const callId = pickFirstString(
          call.call_id,
          call.callId,
          call.id,
          payloadData.call_id,
          payloadData.callId,
          payloadData.id,
          payloadData.call?.call_id,
          payloadData.call?.callId,
          payloadData.call?.id,
          payload.call_id,
          payload.callId,
          payload.id,
          payloadData?.call?.call_id,
          payloadData?.call?.callId,
          payloadData?.call?.id
        );

        console.log(
          `[RETELL] webhook path=${req.path} event=${event || "unknown"} callId=${callId || "none"}`
        );

        if (!callId) {
          console.warn(
            `[RETELL] webhook ignored because callId is missing. event=${event || "unknown"} keys=${Object.keys(
              payload || {}
            ).join(",")}`
          );
          return;
        }

        const fromNumber =
          pickFirstString(
            call.from_number,
            call.fromNumber,
            payloadData.from_number,
            payloadData.fromNumber,
            payloadData.call?.from_number,
            payloadData.call?.fromNumber,
            payload.from_number,
            payload.fromNumber
          ) ?? "";
        const toNumber =
          pickFirstString(
            call.to_number,
            call.toNumber,
            payloadData.to_number,
            payloadData.toNumber,
            payloadData.call?.to_number,
            payloadData.call?.toNumber,
            payload.to_number,
            payload.toNumber
          ) ?? "";
        const direction = normalizeDirection(
          pickFirstString(
            call.direction,
            payloadData.direction,
            payloadData.call?.direction,
            payload.direction
          )
        );

        if (fromNumber && direction === "inbound") {
          try {
            await storage.claimInboundPlaceholder({
              retellCallId: callId,
              fromNumber,
              toNumber: toNumber || undefined,
              sourceEvent: event,
              claimedAt: Date.now(),
            });
          } catch (claimErr: any) {
            console.error(
              `[RETELL] could not claim inbound placeholder for callId=${callId}: ${
                claimErr?.message ?? "unknown"
              }`
            );
          }
        }

        const analysisFromWebhook =
          call.call_analysis ||
          payload.call_analysis ||
          payloadData.call_analysis ||
          payloadData.call?.call_analysis ||
          {};
        const transcriptFromWebhook =
          safeString(call.transcript) ||
          safeString(payloadData.transcript) ||
          safeString(payloadData.call?.transcript) ||
          safeString(payload.transcript) ||
          safeString(analysisFromWebhook?.transcript) ||
          "";
        const provisionalRecordingUrl = extractRecordingUrl(
          payload,
          call,
          analysisFromWebhook
        );

        const shouldTryRetellLookup =
          !!callId &&
          (isAnalyzedEvent(event) || isFinalEvent(event)) &&
          !provisionalRecordingUrl;

        const retellCallDetails = shouldTryRetellLookup
          ? await fetchRetellCallById(callId)
          : null;
        console.log(
          `[RETELL DEBUG] lookup callId=${callId} hasRecording=${Boolean(
            retellCallDetails?.recording_url ||
              retellCallDetails?.recordingUrl ||
              retellCallDetails?.scrubbed_recording_url
          )}`
        );

        const analysis =
          Object.keys(analysisFromWebhook || {}).length > 0
            ? analysisFromWebhook
            : retellCallDetails?.call_analysis || {};

        const transcript =
          transcriptFromWebhook ||
          safeString(retellCallDetails?.transcript) ||
          safeString(analysis?.transcript) ||
          "";

        const durationMs =
          call.duration_ms ??
          payloadData.duration_ms ??
          payloadData.call?.duration_ms ??
          payload.duration_ms ??
          0;

        const durationSec =
          typeof durationMs === "number"
            ? Math.round(durationMs / 1000)
            : 0;

        let existingCall = await storage.getCallLogByRetellCallId(callId);
        if (!existingCall) {
          existingCall = await storage.updateCallLogByRetellCallId(callId, {
            retellCallId: callId,
            status: "pendiente",
            phoneNumber: fromNumber || undefined,
            toNumber: toNumber || undefined,
            direction,
            sourceEvent: event || undefined,
            isPlaceholder: false,
            duration: durationSec || undefined,
          } as any);
        }

        let recordingUrl = extractRecordingUrl(
          payload,
          call,
          analysis,
          retellCallDetails
        );

        if (!recordingUrl && retellCallDetails) {
          recordingUrl = pickFirstString(
            retellCallDetails.recording_url,
            retellCallDetails.recordingUrl,
            retellCallDetails.scrubbed_recording_url,
            retellCallDetails.recording_multi_channel_url,
            retellCallDetails.scrubbed_recording_multi_channel_url
          );
        }
        const looksProcessable =
          isAnalyzedEvent(event) ||
          isFinalEvent(event) ||
          !!recordingUrl ||
          transcript.trim().length > 0 ||
          Object.keys(analysis || {}).length > 0;
        const fallbackLeadName =
          safeString((existingCall as any)?.leadName).trim() ||
          buildFallbackLeadName(fromNumber);
        const fallbackCaseType =
          safeString((existingCall as any)?.caseType).trim() || "General";
        const fallbackUrgency =
          safeString((existingCall as any)?.urgency).trim() || "Medium";
        const normalizedPhoneNumber =
          pickFirstString(fromNumber, (existingCall as any)?.phoneNumber) ?? "";

      const ensuredLeadId = await ensureLeadLinkedToCall({
        retellCallId: callId,
        existingLeadId: Number((existingCall as any)?.leadId ?? 0),
        phoneNumber: normalizedPhoneNumber,
        name: fallbackLeadName,
        caseType: fallbackCaseType,
        urgency: fallbackUrgency,
        transcript,
        status: "pendiente",
      });

      if (Number.isFinite(ensuredLeadId) && ensuredLeadId! > 0) {
        const currentLeadId = Number((existingCall as any)?.leadId ?? 0);
        if (!Number.isFinite(currentLeadId) || currentLeadId <= 0) {
          existingCall = await storage.updateCallLogByRetellCallId(callId, {
            leadId: ensuredLeadId,
          } as any);
        }
      }

        if (!looksProcessable) {
          return;
        }
        const cad = analysis.custom_analysis_data || {};
        const postData = analysis.post_call_data || {};
        const leadName = safeString(cad.name, "").trim();
        const city =
          pickFirstString(
            cad.city,
            cad.ciudad,
            cad.residence_city,
            cad.residenceCity,
            postData.city,
            postData.ciudad,
            analysis.city,
            pickFirstByKeyFragments(cad, ["city", "ciudad", "residence", "residencia"]),
            pickFirstByKeyFragments(postData, ["city", "ciudad", "residence", "residencia"]),
            (existingCall as any)?.city
          ) ?? "";
        const stateProvince =
          pickFirstString(
            cad.state,
            cad.estado,
            cad.state_province,
            cad.province,
            cad.residence_state,
            postData.state,
            postData.estado,
            postData.state_province,
            analysis.state,
            analysis.state_province,
            pickFirstByKeyFragments(cad, ["state", "estado", "province", "provincia"]),
            pickFirstByKeyFragments(postData, ["state", "estado", "province", "provincia"]),
            (existingCall as any)?.stateProvince
          ) ?? "";
        const location =
          pickFirstString(
            cad.location,
            cad.ubicacion,
            cad.residence,
            cad.residencia,
            postData.location,
            postData.ubicacion,
            analysis.location,
            pickFirstByKeyFragments(cad, ["location", "ubicacion", "residence", "residencia"]),
            pickFirstByKeyFragments(postData, ["location", "ubicacion", "residence", "residencia"]),
            [city, stateProvince].filter(Boolean).join(", ")
          ) ?? "";
        const email =
          pickFirstString(
            cad.email,
            cad.correo,
            postData.email,
            analysis.email,
            pickFirstByKeyFragments(cad, ["email", "correo"]),
            pickFirstByKeyFragments(postData, ["email", "correo"]),
            (existingCall as any)?.email
          ) ?? "";
        const address =
          pickFirstString(
            cad.address,
            cad.direccion,
            postData.address,
            postData.direccion,
            analysis.address,
            pickFirstByKeyFragments(cad, ["address", "direccion", "street"]),
            pickFirstByKeyFragments(postData, ["address", "direccion", "street"]),
            (existingCall as any)?.address
          ) ?? "";
        const caseType =
          pickFirstString(
            cad.case_type,
            cad.caseType,
            cad.tipo_caso,
            postData.case_type,
            postData.caseType,
            analysis.case_type,
            analysis.caseType,
            pickFirstByKeyFragments(cad, ["case", "caso", "practice", "matter"]),
            pickFirstByKeyFragments(postData, ["case", "caso", "practice", "matter"]),
            (existingCall as any)?.caseType
          ) ?? "";

        const normalizedName = leadName
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

        const isFakeName =
          !normalizedName ||
          normalizedName === "ai lead" ||
          normalizedName === "unknown" ||
          normalizedName === "test" ||
          normalizedName.length < 3;

        const hasConversation =
          transcript.trim().length > 30 &&
          durationSec > 15;

        const isSuccessful =
          analysis?.call_successful === true &&
          analysis?.user_sentiment === "Positive";

        const isValidCall =
          !isFakeName && hasConversation && isSuccessful;
        const summaryText =
          safeString(analysis?.call_summary) ||
          safeString(analysis?.post_call_analysis?.call_summary) ||
          undefined;

        const existingStatus = String((existingCall as any)?.status ?? "").toLowerCase();
        const protectedStatuses = new Set([
          "pendiente_aprobacion_abogado",
          "rechazada_por_abogado",
          "asignada",
          "en_espera_aceptacion",
          "finalizado",
          "closed",
        ]);
        const webhookStatus = protectedStatuses.has(existingStatus)
          ? existingStatus
          : "pendiente";

        const phoneNumber = normalizedPhoneNumber;
        const normalizedDirection =
          pickFirstString(
            direction,
            (existingCall as any)?.direction
          ) ?? undefined;

        const updatedCall = await storage.updateCallLogByRetellCallId(callId, {
          retellCallId: callId,
          status: webhookStatus,
          phoneNumber: phoneNumber || undefined,
          toNumber: toNumber || (existingCall as any)?.toNumber || undefined,
          direction: normalizedDirection,
          sourceEvent: event || (existingCall as any)?.sourceEvent || undefined,
          isPlaceholder: false,
          duration: durationSec,
          recordingUrl:
            recordingUrl ??
            pickFirstString(
              (existingCall as any)?.recordingUrl,
              (existingCall as any)?.recording_url
            ),
          city,
          stateProvince,
          location,
          email,
          address,
          caseType,
          transcript,
          summary: summaryText,
          analysis: analysis as any,
        });

        const alertAlreadySent =
          typeof (existingCall as any)?.newCallAlertSentAt === "number" ||
          hasRecentNewCallAlert(callId);

        if (!alertAlreadySent) {
          try {
            await sendNewCallAlertEmail({
              to: "247tusabogadossocial@gmail.com",
              retellCallId: callId,
              phoneNumber,
              caseType,
              location,
              summary: summaryText,
              receivedAt: (updatedCall as any)?.createdAt ?? Date.now(),
            });
            rememberNewCallAlert(callId);

            try {
              await storage.updateCallLogByRetellCallId(callId, {
                newCallAlertSentAt: Date.now(),
              } as any);
            } catch (markErr: any) {
              console.warn(
                `[RETELL] could not persist new call alert flag for callId=${callId}: ${
                  markErr?.message ?? "unknown"
                }`
              );
            }
          } catch (alertErr: any) {
            console.error(
              `[RETELL] new call email alert failed for callId=${callId}: ${
                alertErr?.message ?? "unknown"
              }`
            );
          }
        }

        console.log(
          `[RETELL] processed callId=${callId} hasRecording=${Boolean(
            recordingUrl
          )} transcriptLen=${transcript.length}`
        );

        let leadId =
          Number(
            (updatedCall as any)?.leadId ??
              (existingCall as any)?.leadId ??
              ensuredLeadId ??
              0
          ) || undefined;
        let existing =
          Number.isFinite(leadId) && leadId! > 0
            ? await storage.getLead(leadId!)
            : await storage.getLeadByRetellCallId(callId);

        if (!existing) {
          const ensuredLeadId = await ensureLeadLinkedToCall({
            retellCallId: callId,
            existingLeadId: leadId,
            phoneNumber,
            name: leadName,
            caseType,
            urgency: safeString(cad.urgency, "Medium"),
            transcript,
            summary: summaryText,
            status: webhookStatus,
          });

          if (Number.isFinite(ensuredLeadId) && ensuredLeadId! > 0) {
            leadId = ensuredLeadId;
            existing = await storage.getLead(ensuredLeadId!);
            await storage.updateCallLogByRetellCallId(callId, {
              leadId: ensuredLeadId,
            } as any);
          }
        } else {
          leadId = existing.id;
          const updatedCallLeadId = Number((updatedCall as any)?.leadId ?? 0);
          if (!Number.isFinite(updatedCallLeadId) || updatedCallLeadId <= 0) {
            await storage.updateCallLogByRetellCallId(callId, {
              leadId: existing.id,
            } as any);
          }
        }

        if (!isValidCall) {
          return;
        }

        const leadPayload = {
          retellCallId: callId,
          name: leadName,
          phone: phoneNumber || "Sin numero",
          caseType: caseType || "General",
          urgency: safeString(cad.urgency, "Medium"),
          transcript,
          summary: summaryText,
          status: mapStatusFromAnalysis(analysis),
        };

        if (existing) {
          const updated = await storage.updateLead(
            existing.id,
            leadPayload
          );
          leadId = updated.id;
        } else {
          const created = await storage.createLead(
            leadPayload as any
          );
          leadId = created.id;
        }

        await storage.updateCallLogByRetellCallId(callId, {
          leadId,
        });
      } catch (err) {
        console.error("[RETELL] background webhook error:", err);
      }
    })();
  };

  // Keep compatibility with old and current Retell webhook URLs.
  app.post(api.webhooks.retell.path, handleRetellWebhook);
  app.post("/retell-webhook", handleRetellWebhook);
  app.post("/api/webhook", handleRetellWebhook);
  app.post("/webhook", handleRetellWebhook);

  return httpServer;
}
