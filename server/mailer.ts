import "dotenv/config";
import nodemailer from "nodemailer";

type AssignmentEmail = {
  to: string;
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

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} no esta configurado`);
  return v;
}

const smtpTimeoutMs = Number(process.env.SMTP_TIMEOUT_MS ?? "8000");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT ?? "587"),
  secure: false,
  connectionTimeout: smtpTimeoutMs,
  greetingTimeout: smtpTimeoutMs,
  socketTimeout: smtpTimeoutMs,
  auth: {
    user: mustEnv("SMTP_USER"),
    pass: mustEnv("SMTP_PASS"),
  },
});

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

function getMailFrom() {
  const fromName = process.env.SMTP_FROM_NAME ?? "Tus Abogados 24/7";
  const fromEmail = mustEnv("SMTP_USER");
  return {
    from: `${fromName} <${fromEmail}>`,
    fromEmail,
  };
}

export async function sendAttorneyAssignmentEmail(data: AssignmentEmail) {
  const { from } = getMailFrom();

  console.log("[MAIL] sending SMTP...");
  console.log("[MAIL] from:", from);
  console.log("[MAIL] to:", data.to);

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
    </div>
  `;

  const info = await transporter.sendMail({
    from,
    to: data.to,
    subject,
    html,
  });

  console.log("[MAIL] smtp messageId:", info.messageId);

  return { ok: true, messageId: info.messageId };
}

export async function sendAttorneyDecisionEmail(data: AssignmentDecisionEmail) {
  const { from, fromEmail } = getMailFrom();
  const to = fromEmail;

  const decisionLabel = data.decision === "accept" ? "ACEPTADO" : "RECHAZADO";
  const subject = `Respuesta abogado: ${decisionLabel} - ${data.caseType ?? "Caso"}`;
  const notes = String(data.notes ?? "").trim();

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4">
      <h2>Respuesta del abogado</h2>
      <p>Se registro una decision desde el correo del abogado.</p>
      <ul>
        <li><b>Decision:</b> ${decisionLabel}</li>
        <li><b>Abogado:</b> ${data.attorneyName ?? "N/A"}</li>
        <li><b>Correo abogado:</b> ${data.attorneyEmail ?? "N/A"}</li>
        <li><b>Tipo de caso:</b> ${data.caseType ?? "N/A"}</li>
      </ul>
      ${notes ? `<p><b>Notas del abogado:</b><br/>${notes}</p>` : ""}
    </div>
  `;

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html,
  });

  console.log("[MAIL] decision messageId:", info.messageId);

  return { ok: true, messageId: info.messageId };
}
