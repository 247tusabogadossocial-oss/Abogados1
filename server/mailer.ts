import "dotenv/config";
import nodemailer from "nodemailer";
import sgMail from "@sendgrid/mail";

type AssignmentEmail = {
  to: string | string[];
  leadName?: string | null;
  caseType: string | null;
  urgency: string | null;
  summary?: string | null;
  notes?: string;
  acceptUrl?: string;
  rejectUrl?: string;
};

type AssignmentDecisionEmail = {
  decision: "accept" | "reject";
  attorneyName?: string | null;
  attorneyEmail?: string | null;
  caseType?: string | null;
  notes?: string | null;
};

type NewCallAlertEmail = {
  to: string | string[];
  retellCallId: string;
  phoneNumber?: string | null;
  caseType?: string | null;
  location?: string | null;
  summary?: string | null;
  receivedAt?: Date | number | string | null;
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} no esta configurado`);
  return v;
}

const smtpTimeoutMs = Number(process.env.SMTP_TIMEOUT_MS ?? "8000");

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toHtmlWithBreaks(value: string, fallback: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return escapeHtml(fallback);
  return escapeHtml(trimmed).replace(/\r?\n/g, "<br/>");
}

function normalizeRecipients(value: string | string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  const recipients = values
    .flatMap((entry) => String(entry ?? "").split(/[,\n;]+/))
    .map((entry) => entry.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  return recipients.filter((recipient) => {
    const key = recipient.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatSendGridError(error: any): Error {
  const statusCode = Number(error?.code ?? error?.response?.statusCode ?? 0);
  const bodyErrors = Array.isArray(error?.response?.body?.errors)
    ? error.response.body.errors
        .map((entry: any) => String(entry?.message ?? "").trim())
        .filter(Boolean)
    : [];
  const parts = [
    statusCode > 0 ? `SendGrid error ${statusCode}` : "SendGrid error",
    String(error?.message ?? "").trim(),
    bodyErrors.join("; "),
  ].filter(Boolean);

  return new Error(parts.join(": "));
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

function getMailFrom() {
  const fromName = process.env.SMTP_FROM_NAME ?? "Tus Abogados 24/7";
  const fromEmail = String(
    process.env.MAIL_FROM_EMAIL ??
      process.env.SENDGRID_FROM_EMAIL ??
      process.env.SMTP_USER ??
      ""
  ).trim();
  if (!fromEmail) {
    throw new Error(
      "MAIL_FROM_EMAIL, SENDGRID_FROM_EMAIL o SMTP_USER deben estar configurados"
    );
  }
  return {
    from: {
      email: fromEmail,
      name: fromName,
    },
    fromEmail,
  };
}

function getSendGridClient() {
  sgMail.setApiKey(String(mustEnv("SENDGRID_API_KEY")).trim());
  return sgMail;
}

function hasSendGridConfig(): boolean {
  return String(process.env.SENDGRID_API_KEY ?? "").trim().length > 0;
}

function hasSmtpConfig(): boolean {
  return (
    String(process.env.SMTP_USER ?? "").trim().length > 0 &&
    String(process.env.SMTP_PASS ?? "").trim().length > 0
  );
}

function getMailProvider(): "sendgrid" | "smtp" {
  if (hasSendGridConfig()) return "sendgrid";
  if (hasSmtpConfig()) return "smtp";
  throw new Error(
    "Configura SENDGRID_API_KEY o SMTP_USER/SMTP_PASS para enviar correos"
  );
}

function createSmtpTransporter() {
  const smtpHost = String(process.env.SMTP_HOST ?? "smtp.gmail.com").trim();
  const smtpHostIp = String(process.env.SMTP_HOST_IP ?? "").trim();
  const smtpPort = Number(process.env.SMTP_PORT ?? "587");
  const smtpSecure =
    String(process.env.SMTP_SECURE ?? "").trim().toLowerCase() === "true" ||
    smtpPort === 465;

  return nodemailer.createTransport({
    host: smtpHostIp || smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    requireTLS: !smtpSecure,
    connectionTimeout: smtpTimeoutMs,
    greetingTimeout: smtpTimeoutMs,
    socketTimeout: smtpTimeoutMs,
    name: String(process.env.SMTP_CLIENT_NAME ?? "crm.tusabogados247.local").trim(),
    auth: {
      user: mustEnv("SMTP_USER"),
      pass: mustEnv("SMTP_PASS"),
    },
    tls: {
      servername: smtpHost,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
  });
}

function getNotificationRecipients() {
  const raw = String(process.env.NEW_CALL_ALERT_TO ?? "").trim();
  const fallback = getMailFrom().fromEmail;
  const recipients = normalizeRecipients(raw ? raw : [fallback]);
  if (recipients.length === 0) {
    throw new Error(
      "NEW_CALL_ALERT_TO o una direccion remitente valida deben estar configurados"
    );
  }
  return recipients;
}

async function deliverEmail(input: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}) {
  const { from } = getMailFrom();
  const provider = getMailProvider();
  const to = normalizeRecipients(input.to);
  if (to.length === 0) {
    throw new Error("No hay destinatarios de correo validos");
  }
  const subject = String(input.subject ?? "").trim();
  if (!subject) {
    throw new Error("El asunto del correo no puede estar vacio");
  }

  console.log(`[MAIL] sending via ${provider}...`);
  console.log("[MAIL] from:", `${from.name} <${from.email}>`);
  console.log("[MAIL] to:", to.join(", "));

  if (provider === "sendgrid") {
    try {
      await getSendGridClient().send({
        from,
        to,
        subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      });
    } catch (error: any) {
      throw formatSendGridError(error);
    }
  } else {
    try {
      await createSmtpTransporter().sendMail({
        from: `${from.name} <${from.email}>`,
        to,
        subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      });
    } catch (error: any) {
      throw new Error(String(error?.message ?? "SMTP error"));
    }
  }

  console.log(`[MAIL] sent via ${provider}`);
  return { ok: true };
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
  return getNotificationRecipients();
}

export async function sendAttorneyAssignmentEmail(data: AssignmentEmail) {
  const isValidationFlow = Boolean(data.acceptUrl || data.rejectUrl);
  const subject = isValidationFlow
    ? `Nuevo caso para validacion: ${data.caseType ?? "General"}`
    : "NUEVO CASO ASIGNADO";
  const title = isValidationFlow ? "Nuevo caso para validacion" : "NUEVO CASO ASIGNADO";
  const intro = isValidationFlow
    ? "Revisa el caso y confirma si deseas aceptarlo."
    : "Mira desde tu perfil los datos completos del caso.";
  const summary = stripLeadNameFromSummary(String(data.summary ?? ""), data.leadName);
  const notes = String(data.notes ?? "").trim();
  const htmlSummary = toHtmlWithBreaks(summary, "Sin resumen disponible.");
  const htmlNotes = toHtmlWithBreaks(notes, "Sin notas adicionales.");
  const textLines = [
    title,
    "",
    intro,
    "",
    `Tipo de caso: ${data.caseType ?? "General"}`,
    `Urgencia: ${data.urgency ?? "Medium"}`,
    "",
    `Resumen: ${summary || "Sin resumen disponible."}`,
  ];
  if (notes) {
    textLines.push("", `Notas adicionales: ${notes}`);
  }
  if (data.acceptUrl) {
    textLines.push("", `Aceptar: ${data.acceptUrl}`);
  }
  if (data.rejectUrl) {
    textLines.push("", `Rechazar: ${data.rejectUrl}`);
  }
  const text = textLines.join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(intro)}</p>
      <ul>
        <li><b>Tipo de caso:</b> ${escapeHtml(data.caseType ?? "General")}</li>
        <li><b>Urgencia:</b> ${escapeHtml(data.urgency ?? "Medium")}</li>
      </ul>
      <p><b>Resumen:</b><br/>${htmlSummary}</p>
      ${notes ? `<p><b>Notas adicionales:</b><br/>${htmlNotes}</p>` : ""}
      ${
        data.acceptUrl || data.rejectUrl
          ? `<div style="margin-top: 16px; display: flex; gap: 10px; flex-wrap: wrap;">
              ${
                data.acceptUrl
                  ? `<a href="${escapeHtml(data.acceptUrl)}" style="display: inline-block; padding: 10px 16px; border-radius: 10px; background: #16a34a; color: #fff; text-decoration: none;">Aceptar</a>`
                  : ""
              }
              ${
                data.rejectUrl
                  ? `<a href="${escapeHtml(data.rejectUrl)}" style="display: inline-block; padding: 10px 16px; border-radius: 10px; background: #dc2626; color: #fff; text-decoration: none;">Rechazar</a>`
                  : ""
              }
            </div>`
          : ""
      }
    </div>
  `;

  return await deliverEmail({
    to: data.to,
    subject,
    html,
    text,
  });
}

export async function sendAttorneyDecisionEmail(data: AssignmentDecisionEmail) {
  const to = getNotificationRecipients();

  const decisionLabel = data.decision === "accept" ? "ACEPTADO" : "RECHAZADO";
  const subject = `Respuesta abogado: ${decisionLabel} - ${data.caseType ?? "Caso"}`;
  const notes = String(data.notes ?? "").trim();
  const textLines = [
    "Respuesta del abogado",
    "",
    "Se registro una decision desde el correo del abogado.",
    "",
    `Decision: ${decisionLabel}`,
    `Abogado: ${data.attorneyName ?? "N/A"}`,
    `Correo abogado: ${data.attorneyEmail ?? "N/A"}`,
    `Tipo de caso: ${data.caseType ?? "N/A"}`,
  ];
  if (notes) {
    textLines.push("", `Notas del abogado: ${notes}`);
  }
  const text = textLines.join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4">
      <h2>Respuesta del abogado</h2>
      <p>Se registro una decision desde el correo del abogado.</p>
      <ul>
        <li><b>Decision:</b> ${escapeHtml(decisionLabel)}</li>
        <li><b>Abogado:</b> ${escapeHtml(data.attorneyName ?? "N/A")}</li>
        <li><b>Correo abogado:</b> ${escapeHtml(data.attorneyEmail ?? "N/A")}</li>
        <li><b>Tipo de caso:</b> ${escapeHtml(data.caseType ?? "N/A")}</li>
      </ul>
      ${notes ? `<p><b>Notas del abogado:</b><br/>${toHtmlWithBreaks(notes, "Sin notas.")}</p>` : ""}
    </div>
  `;

  return await deliverEmail({
    to,
    subject,
    html,
    text,
  });
}

export async function sendNewCallAlertEmail(data: NewCallAlertEmail) {
  const phoneNumber = String(data.phoneNumber ?? "").trim();
  const caseType = String(data.caseType ?? "").trim();
  const location = String(data.location ?? "").trim();
  const summary = String(data.summary ?? "").trim();
  const receivedAt = formatAlertDate(data.receivedAt);
  const subject = `Nueva llamada CRM${phoneNumber ? `: ${phoneNumber}` : ""}`;
  const text = [
    "Nueva llamada en CRM",
    "",
    "Se registro una nueva llamada en el CRM.",
    "",
    `Telefono: ${phoneNumber || "No disponible"}`,
    `Tipo de caso: ${caseType || "General"}`,
    `Ubicacion: ${location || "No disponible"}`,
    `Fecha: ${receivedAt}`,
    `Retell Call ID: ${data.retellCallId}`,
    "",
    `Resumen: ${summary || "Sin resumen disponible aun."}`,
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4">
      <h2>Nueva llamada en CRM</h2>
      <p>Se registro una nueva llamada en el CRM.</p>
      <ul>
        <li><b>Telefono:</b> ${escapeHtml(phoneNumber || "No disponible")}</li>
        <li><b>Tipo de caso:</b> ${escapeHtml(caseType || "General")}</li>
        <li><b>Ubicacion:</b> ${escapeHtml(location || "No disponible")}</li>
        <li><b>Fecha:</b> ${escapeHtml(receivedAt)}</li>
        <li><b>Retell Call ID:</b> ${escapeHtml(data.retellCallId)}</li>
      </ul>
      <p><b>Resumen:</b><br/>${toHtmlWithBreaks(summary, "Sin resumen disponible aun.")}</p>
    </div>
  `;

  return await deliverEmail({
    to: data.to,
    subject,
    html,
    text,
  });
}
