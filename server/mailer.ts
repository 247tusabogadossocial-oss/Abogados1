import "dotenv/config";
import sgMail from "@sendgrid/mail";

type AssignmentEmail = {
  to: string;
  leadName?: string | null;
  caseType: string | null;
  urgency: string | null;
  summary?: string | null;
  notes?: string;
  acceptUrl?: string;
  rejectUrl?: string;
  isManualCase?: boolean;
};

type AssignmentDecisionEmail = {
  decision: "accept" | "reject";
  attorneyName?: string | null;
  attorneyEmail?: string | null;
  caseType?: string | null;
  notes?: string | null;
};

type NewCallAlertEmail = {
  to?: string | string[]; // si no llega, se usa NEW_CALL_ALERT_TO (o fallback al from)
  retellCallId: string;
  phoneNumber?: string | null;
  caseType?: string | null;
  location?: string | null;
  summary?: string | null;
  receivedAt?: Date | number | string | null;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadNameFromSummary(summary: string, leadName?: string | null): string {
  const cleanedSummary = String(summary ?? "").trim();
  const normalizedLeadName = String(leadName ?? "").trim();
  if (!cleanedSummary || !normalizedLeadName) return cleanedSummary;

  const candidates = [
    normalizedLeadName,
    ...normalizedLeadName
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3),
  ];

  let sanitized = cleanedSummary;
  for (const candidate of Array.from(new Set(candidates)).sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.replace(new RegExp(`\\b${escapeRegex(candidate)}\\b`, "gi"), "");
  }

  return sanitized
    .replace(/\s{2,}/g, " ")
    .replace(/\s([,.;:!?])/g, "$1")
    .trim();
}

function mustSendGridKey(): string {
  const key = String(process.env.SENDGRID_API_KEY ?? "").trim();
  if (!key) throw new Error("SENDGRID_API_KEY no esta configurado");
  return key;
}

function getMailFrom() {
  const fromName = String(process.env.SMTP_FROM_NAME ?? "Tus Abogados 24/7").trim();
  const fromEmail = String(process.env.MAIL_FROM_EMAIL ?? "").trim();
  if (!fromEmail) throw new Error("MAIL_FROM_EMAIL no esta configurado");
  return { fromName, fromEmail, from: `${fromName} <${fromEmail}>` };
}

function ensureSendGridReady() {
  const key = mustSendGridKey();
  sgMail.setApiKey(key);
}

function normalizeRecipients(value: string | string[] | undefined | null): string[] {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  // permite "a@a.com,b@b.com"
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
}

function formatAlertDate(value?: Date | number | string | null): string {
  if (value == null) return new Date().toLocaleString("es-US");
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(String(value));
  if (Number.isNaN(date.getTime())) return new Date().toLocaleString("es-US");
  return date.toLocaleString("es-US");
}

export function getNewCallAlertRecipients(): string[] {
  const raw = String(process.env.NEW_CALL_ALERT_TO ?? "").trim();
  const { fromEmail } = getMailFrom();
  const values = raw ? raw.split(",").map((v) => v.trim()) : [fromEmail];
  return Array.from(new Set(values.filter(Boolean)));
}

/**
 * Envío centralizado (HTTP) usando SendGrid Web API (no SMTP).
 * Esto evita los timeouts de SMTP en Render.
 */
async function deliverEmail(input: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}) {
  ensureSendGridReady();
  const { fromName, fromEmail } = getMailFrom();
  const toList = normalizeRecipients(input.to);

  if (!toList.length) throw new Error("Destinatario (to) vacio");

  console.log("[MAIL] sending via SendGrid API...");
  console.log("[MAIL] from:", `${fromName} <${fromEmail}>`);
  console.log("[MAIL] to:", toList.join(", "));
  console.log("[MAIL] subject:", input.subject);

  await sgMail.send({
    to: toList,
    from: { email: fromEmail, name: fromName },
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  });

  console.log("[MAIL] sent via SendGrid API ✅");
  return { ok: true };
}

export async function sendAttorneyAssignmentEmail(data: AssignmentEmail) {
  // Evita asuntos agresivos (menos spam)
  const isValidationFlow = Boolean(data.acceptUrl || data.rejectUrl);
  let subject = isValidationFlow
    ? `Caso para revisión: ${data.caseType ?? "General"}`
    : `Caso asignado: ${data.caseType ?? "General"}`;
  if (isValidationFlow && data.isManualCase) {
    subject = "Caso para revisi\u00F3n: FORMULARIO MANUAL";
  }

  const title = isValidationFlow ? "Caso para revisión" : "Caso asignado";
  const intro = isValidationFlow
    ? "Revisa el caso y confirma si deseas aceptarlo."
    : "Se asignó un caso. Puedes revisar los detalles en el CRM.";

  const summary = stripLeadNameFromSummary(String(data.summary ?? ""), data.leadName);
  const notes = String(data.notes ?? "").trim();

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4">
      <h2>${title}</h2>
      <p>${intro}</p>
      <ul>
        <li><b>Tipo de caso:</b> ${data.caseType ?? "General"}</li>
        <li><b>Urgencia:</b> ${data.urgency ?? "Medium"}</li>
      </ul>
      <p><b>Resumen:</b><br/>${summary || "Sin resumen disponible."}</p>
      ${notes ? `<p><b>Notas adicionales:</b><br/>${notes}</p>` : ""}
      ${
        data.acceptUrl || data.rejectUrl
          ? `<div style="margin-top: 16px; display: flex; gap: 10px; flex-wrap: wrap;">
              ${
                data.acceptUrl
                  ? `<a href="${data.acceptUrl}" style="display: inline-block; padding: 10px 16px; border-radius: 10px; background: #16a34a; color: #fff; text-decoration: none;">Aceptar</a>`
                  : ""
              }
              ${
                data.rejectUrl
                  ? `<a href="${data.rejectUrl}" style="display: inline-block; padding: 10px 16px; border-radius: 10px; background: #dc2626; color: #fff; text-decoration: none;">Rechazar</a>`
                  : ""
              }
            </div>`
          : ""
      }
      <hr/>
      <p style="font-size:12px;color:#6b7280;margin-top:12px;">
        Mensaje automático del CRM.
      </p>
    </div>
  `;

  const text = [
    title,
    intro,
    `Tipo de caso: ${data.caseType ?? "General"}`,
    `Urgencia: ${data.urgency ?? "Medium"}`,
    `Resumen: ${summary || "Sin resumen disponible."}`,
    notes ? `Notas: ${notes}` : "",
    data.acceptUrl ? `Aceptar: ${data.acceptUrl}` : "",
    data.rejectUrl ? `Rechazar: ${data.rejectUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return await deliverEmail({
    to: data.to,
    subject,
    html,
    text,
  });
}

export async function sendAttorneyDecisionEmail(data: AssignmentDecisionEmail) {
  const { fromEmail } = getMailFrom();
  const to = fromEmail; // inbox interna

  const decisionLabel = data.decision === "accept" ? "ACEPTADO" : "RECHAZADO";
  const subject = `Decisión de abogado: ${decisionLabel} - ${data.caseType ?? "Caso"}`;
  const notes = String(data.notes ?? "").trim();

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4">
      <h2>Decisión del abogado</h2>
      <p>Se registró una decisión desde el correo del abogado.</p>
      <ul>
        <li><b>Decisión:</b> ${decisionLabel}</li>
        <li><b>Abogado:</b> ${data.attorneyName ?? "N/A"}</li>
        <li><b>Correo abogado:</b> ${data.attorneyEmail ?? "N/A"}</li>
        <li><b>Tipo de caso:</b> ${data.caseType ?? "N/A"}</li>
      </ul>
      ${notes ? `<p><b>Notas del abogado:</b><br/>${notes}</p>` : ""}
      <hr/>
      <p style="font-size:12px;color:#6b7280;margin-top:12px;">
        Mensaje automático del CRM.
      </p>
    </div>
  `;

  const text = [
    "Decisión del abogado",
    `Decisión: ${decisionLabel}`,
    `Abogado: ${data.attorneyName ?? "N/A"}`,
    `Correo abogado: ${data.attorneyEmail ?? "N/A"}`,
    `Tipo de caso: ${data.caseType ?? "N/A"}`,
    notes ? `Notas: ${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return await deliverEmail({
    to,
    subject,
    html,
    text,
  });
}

/**
 * ALERTA: Nueva llamada
 * - Si no pasas `to`, usa NEW_CALL_ALERT_TO (o fallback al from).
 */
export async function sendNewCallAlertEmail(data: NewCallAlertEmail) {
  const recipients = data.to ? normalizeRecipients(data.to) : getNewCallAlertRecipients();
  const phoneNumber = String(data.phoneNumber ?? "").trim();
  const caseType = String(data.caseType ?? "").trim();
  const location = String(data.location ?? "").trim();
  const summary = String(data.summary ?? "").trim();
  const receivedAt = formatAlertDate(data.receivedAt);

  const subject = `Nueva llamada en CRM${phoneNumber ? `: ${phoneNumber}` : ""}`;

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4">
      <h2>Nueva llamada en el CRM</h2>
      <p>Se registró una nueva llamada.</p>
      <ul>
        <li><b>Teléfono:</b> ${phoneNumber || "No disponible"}</li>
        <li><b>Tipo de caso:</b> ${caseType || "General"}</li>
        <li><b>Ubicación:</b> ${location || "No disponible"}</li>
        <li><b>Fecha:</b> ${receivedAt}</li>
        <li><b>Retell Call ID:</b> ${data.retellCallId}</li>
      </ul>
      <p><b>Resumen:</b><br/>${summary || "Sin resumen disponible aún."}</p>
      <hr/>
      <p style="font-size:12px;color:#6b7280;margin-top:12px;">
        Mensaje automático del CRM.
      </p>
    </div>
  `;

  const text = [
    "Nueva llamada en el CRM",
    `Teléfono: ${phoneNumber || "No disponible"}`,
    `Tipo de caso: ${caseType || "General"}`,
    `Ubicación: ${location || "No disponible"}`,
    `Fecha: ${receivedAt}`,
    `Retell Call ID: ${data.retellCallId}`,
    `Resumen: ${summary || "Sin resumen disponible aún."}`,
  ].join("\n");

  return await deliverEmail({
    to: recipients,
    subject,
    html,
    text,
  });
}
