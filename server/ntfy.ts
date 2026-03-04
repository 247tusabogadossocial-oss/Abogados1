function cleanText(value: unknown): string {
  if (value == null) return "N/A";
  const text = String(value).trim();
  return text || "N/A";
}

export async function notifyNtfyNewCall(data: {
  leadName?: string | null;
  phone?: string | null;
  caseType?: string | null;
  practiceArea?: string | null;
  urgency?: string | null;
  callId?: string | null;
}) {
  const url = String(process.env.NTFY_TOPIC_URL ?? "").trim();
  if (!url) return;

  const msg =
    `Cliente: ${cleanText(data.leadName)}\n` +
    `Tel: ${cleanText(data.phone)}\n` +
    `Caso: ${cleanText(data.caseType ?? data.practiceArea)}\n` +
    `Urgencia: ${cleanText(data.urgency)}\n` +
    `ID: ${cleanText(data.callId)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Title: "Nueva llamada",
      Priority: "high",
      Tags: "phone,rotating_light",
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: msg,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `ntfy error ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`
    );
  }
}

