import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Clock, Phone, FileText, Copy, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { useAssignedAttorneyCall } from "@/hooks/use-attorney-call";
import { useToast } from "@/hooks/use-toast";
import { withApiBase } from "@/lib/queryClient";
import { US_CITIES } from "@/hooks/usCities";
import { CASE_TYPES } from "@/hooks/caseTypes";

function formatDuration(seconds?: number | null) {
  const s = Math.max(0, Number(seconds ?? 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function getRecordingUrl(call: any): string {
  return String(
    call?.recordingUrl ??
      call?.recording_url ??
      call?.recording_url_public ??
      call?.recording?.url ??
      call?.recording?.recording_url ??
      call?.recording?.recording_url_public ??
      call?.recording?.public_url ??
      call?.scrubbed_recording_url ??
      call?.recording_multi_channel_url ??
      call?.scrubbed_recording_multi_channel_url ??
      call?.analysis?.recordingUrl ??
      call?.analysis?.recording_url ??
      call?.analysis?.recording_url_public ??
      call?.analysis?.recording?.url ??
      call?.analysis?.recording?.recording_url ??
      call?.analysis?.recording?.recording_url_public ??
      call?.analysis?.post_call_analysis?.recordingUrl ??
      call?.analysis?.post_call_analysis?.recording_url ??
      call?.analysis?.post_call_analysis?.recording_url_public ??
      call?.analysis?.post_call_analysis?.recording?.url ??
      call?.analysis?.scrubbed_recording_url ??
      call?.analysis?.recording_multi_channel_url ??
      call?.analysis?.scrubbed_recording_multi_channel_url ??
      ""
  ).trim();
}

function getCallKey(call: any): string {
  return String(call?.retellCallId ?? call?.call_id ?? call?.callId ?? call?.id ?? "");
}

function normalizeCaseStatus(status?: string | null) {
  const s = String(status ?? "").toLowerCase().trim();
  if (s === "closed" || s === "finalized" || s === "finalizada") return "finalizado";
  return s;
}

function getErrorMessage(error: unknown, fallback: string): string {
  const message = String((error as any)?.message ?? "").trim();
  if (!message) return fallback;
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    if (parsed && typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Keep raw message when it is not JSON.
  }
  return message;
}

const norm = (v: any) => String(v ?? "").trim().toLowerCase();

function cleanText(value: any): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(escape(raw)).trim();
  } catch {
    return raw.trim();
  }
}

function firstText(...values: any[]): string {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function findByKeyFragments(source: any, fragments: string[]): string {
  if (!source || typeof source !== "object") return "";

  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (typeof rawValue !== "string") continue;
    const key = String(rawKey).toLowerCase();
    if (!fragments.some((fragment) => key.includes(fragment))) continue;
    const text = firstText(rawValue);
    if (text) return text;
  }

  return "";
}

function normalizeKey(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function digitsOnly(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

function isLikelyPhone(value: string): boolean {
  const digits = digitsOnly(value);
  return digits.length >= 7 && digits.length <= 15;
}

function formatManualFieldLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatManualFieldValue(value: any): string {
  if (value == null) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);

  if (typeof value === "string") {
    const text = firstText(value);
    return text || "-";
  }

  if (Array.isArray(value)) {
    if (!value.length) return "-";
    return value
      .map((item) => formatManualFieldValue(item))
      .filter((item) => item && item !== "-")
      .join(", ");
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "-";
    }
  }

  return String(value);
}

function getManualValueByKeyCandidates(
  data: Record<string, any>,
  keys: string[],
  options?: { requirePhone?: boolean }
): string {
  const requirePhone = Boolean(options?.requirePhone);
  const wanted = keys.map((key) => normalizeKey(key));
  const entries = Object.entries(data ?? {});

  const pick = (value: any) => {
    const text = firstText(value);
    if (!text) return "";
    if (requirePhone && !isLikelyPhone(text)) return "";
    return text;
  };

  for (const [rawKey, rawValue] of entries) {
    if (wanted.includes(normalizeKey(rawKey))) {
      const text = pick(rawValue);
      if (text) return text;
    }
  }

  for (const [rawKey, rawValue] of entries) {
    const normalized = normalizeKey(rawKey);
    if (!wanted.some((candidate) => normalized.includes(candidate))) continue;
    const text = pick(rawValue);
    if (text) return text;
  }

  return "";
}

function getManualIntakeData(call: any): Record<string, any> {
  const direct = call?.intakeData;
  if (direct && typeof direct === "object") return direct;

  const nested = call?.intake?.data;
  if (nested && typeof nested === "object") return nested;

  return {};
}

function isManualCall(call: any): boolean {
  const retellCallId = String(call?.retellCallId ?? call?.call_id ?? call?.callId ?? "").trim();
  const direction = String(call?.direction ?? "").trim().toLowerCase();
  return retellCallId.startsWith("manual-") || direction === "manual";
}

function getCallSummary(call: any): string {
  return firstText(
    call?.summary,
    call?.analysis?.call_summary,
    call?.analysis?.post_call_analysis?.call_summary
  );
}

function getCallTranscript(call: any): string {
  return firstText(call?.transcript, call?.analysis?.transcript);
}

function getAnalysisSentiment(call: any): string {
  return (
    firstText(
      call?.analysis?.user_sentiment,
      call?.analysis?.post_call_analysis?.user_sentiment,
      call?.analysis?.sentiment,
      call?.sentiment
    ) || "-"
  );
}

function getAnalysisSuccessLabel(call: any): string {
  const successful =
    call?.analysis?.call_successful ??
    call?.analysis?.post_call_analysis?.call_successful;
  if (successful === true) return "Yes";
  if (successful === false) return "No";
  return "-";
}

function getCallCity(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};
  const manualData = getManualIntakeData(call);

  return firstText(
    call?.city,
    call?.leadCity,
    call?.analysis?.city,
    call?.analysis?.post_call_data?.city,
    call?.post_call_data?.city,
    call?.extracted?.city,
    call?.analysis?.custom_analysis_data?.city,
    cad?.ciudad,
    cad?.residence_city,
    cad?.client_city,
    getManualValueByKeyCandidates(manualData, ["city", "ciudad", "residenceCity", "clientCity"]),
    findByKeyFragments(cad, ["city", "ciudad", "residence", "residencia"]),
    findByKeyFragments(postData, ["city", "ciudad", "residence", "residencia"]),
    findByKeyFragments(manualData, ["city", "ciudad", "residence", "residencia"])
  );
}

function getCallCaseType(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};
  const manualData = getManualIntakeData(call);

  return firstText(
    call?.caseType,
    call?.case_type,
    call?.analysis?.case_type,
    call?.analysis?.caseType,
    call?.analysis?.post_call_data?.case_type,
    call?.analysis?.custom_analysis_data?.case_type,
    getManualValueByKeyCandidates(manualData, ["caseType", "case_type", "practiceArea"]),
    cad?.tipo_caso,
    findByKeyFragments(cad, ["case", "caso", "practice", "matter"]),
    findByKeyFragments(postData, ["case", "caso", "practice", "matter"]),
    findByKeyFragments(manualData, ["case", "caso", "practice", "matter"])
  );
}

function getCallState(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};
  const manualData = getManualIntakeData(call);

  return firstText(
    call?.stateProvince,
    call?.state,
    call?.analysis?.state,
    call?.analysis?.state_province,
    call?.analysis?.post_call_data?.state,
    call?.analysis?.post_call_data?.state_province,
    call?.analysis?.custom_analysis_data?.state,
    call?.analysis?.custom_analysis_data?.state_province,
    cad?.estado,
    cad?.province,
    cad?.residence_state,
    cad?.residence_state_province,
    getManualValueByKeyCandidates(manualData, [
      "stateProvince",
      "state",
      "estado",
      "residenceState",
      "state_province",
    ]),
    findByKeyFragments(cad, ["state", "estado", "province", "provincia"]),
    findByKeyFragments(postData, ["state", "estado", "province", "provincia"]),
    findByKeyFragments(manualData, ["state", "estado", "province", "provincia"])
  );
}

function getCallLocation(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};
  const manualData = getManualIntakeData(call);

  return firstText(
    call?.location,
    call?.analysis?.location,
    call?.analysis?.post_call_data?.location,
    call?.analysis?.custom_analysis_data?.location,
    call?.analysis?.custom_analysis_data?.ubicacion,
    cad?.residencia,
    cad?.residence,
    getManualValueByKeyCandidates(manualData, ["location", "ubicacion"]),
    findByKeyFragments(cad, ["location", "ubicacion", "residence", "residencia"]),
    findByKeyFragments(postData, ["location", "ubicacion", "residence", "residencia"]),
    findByKeyFragments(manualData, ["location", "ubicacion", "residence", "residencia"])
  );
}

function getCallEmail(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};
  const manualData = getManualIntakeData(call);

  return firstText(
    call?.email,
    call?.leadEmail,
    call?.analysis?.email,
    call?.analysis?.post_call_data?.email,
    call?.analysis?.custom_analysis_data?.email,
    call?.analysis?.custom_analysis_data?.correo,
    getManualValueByKeyCandidates(manualData, ["email", "correo"]),
    findByKeyFragments(cad, ["email", "correo"]),
    findByKeyFragments(postData, ["email", "correo"]),
    findByKeyFragments(manualData, ["email", "correo"])
  );
}

function getCallAddress(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};
  const manualData = getManualIntakeData(call);

  return firstText(
    call?.address,
    call?.analysis?.address,
    call?.analysis?.post_call_data?.address,
    call?.analysis?.custom_analysis_data?.address,
    call?.analysis?.custom_analysis_data?.direccion,
    getManualValueByKeyCandidates(manualData, ["address", "direccion"]),
    findByKeyFragments(cad, ["address", "direccion", "street"]),
    findByKeyFragments(postData, ["address", "direccion", "street"]),
    findByKeyFragments(manualData, ["address", "direccion", "street"])
  );
}

function getCallCaseNotes(call: any): string {
  const manualData = getManualIntakeData(call);
  return firstText(
    call?.caseNotes,
    getManualValueByKeyCandidates(manualData, ["caseNotes", "deadlineNotes", "narrative"])
  );
}

function getCallLocationLabel(call: any): string {
  const location = getCallLocation(call);
  if (location) return location;

  const city = getCallCity(call);
  const state = getCallState(call);
  if (city && state) return `${city}, ${state}`;

  return city || state || "Ubicacion pendiente";
}

function normalizeExtraFields(
  value: any
): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => ({
      label: String(item?.label ?? "").trim(),
      value: String(item?.value ?? "").trim(),
    }))
    .filter((item: any) => item.label || item.value);
}

function Field({ label, value }: { label: string; value: any }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{String(value ?? "").trim() || "-"}</div>
    </div>
  );
}

function getManualClientEntries(call: any) {
  const manualData = getManualIntakeData(call);
  const firstName = getManualValueByKeyCandidates(manualData, [
    "firstName",
    "first_name",
    "nombre",
  ]);
  const lastName = getManualValueByKeyCandidates(manualData, [
    "lastName",
    "last_name",
    "surname",
    "apellido",
    "apellidos",
  ]);
  const name = firstText(
    getManualValueByKeyCandidates(manualData, ["name", "fullName", "clientName"]),
    [firstName, lastName].filter(Boolean).join(" ").trim(),
    firstName,
    call?.leadName
  );
  const phone = getManualValueByKeyCandidates(
    manualData,
    ["phone", "phoneNumber", "callerPhone", "telefono", "tel", "cell", "cel", "mobile"],
    { requirePhone: true }
  );
  const email = getManualValueByKeyCandidates(manualData, ["email", "correo"]);
  const address = getManualValueByKeyCandidates(manualData, ["address", "direccion"]);
  const city = getManualValueByKeyCandidates(manualData, ["city", "ciudad"]);
  const state = getManualValueByKeyCandidates(manualData, [
    "stateProvince",
    "state",
    "estado",
  ]);
  const county = getManualValueByKeyCandidates(manualData, ["county"]);

  return [
    { key: "name", label: "Name", value: formatManualFieldValue(name) },
    { key: "phone", label: "Phone", value: formatManualFieldValue(phone) },
    { key: "email", label: "Email", value: formatManualFieldValue(email) },
    { key: "address", label: "Address", value: formatManualFieldValue(address) },
    { key: "city", label: "City", value: formatManualFieldValue(city) },
    { key: "state", label: "State", value: formatManualFieldValue(state) },
    { key: "county", label: "County", value: formatManualFieldValue(county) },
  ];
}

function getManualCaseEntries(call: any) {
  const manualData = getManualIntakeData(call);
  const clientFieldKeys = new Set(
    [
      "name",
      "fullname",
      "clientname",
      "firstname",
      "lastname",
      "surname",
      "apellido",
      "apellidos",
      "phone",
      "phonenumber",
      "callerphone",
      "telefono",
      "tel",
      "cell",
      "cel",
      "mobile",
      "email",
      "correo",
      "address",
      "direccion",
      "city",
      "ciudad",
      "stateprovince",
      "state",
      "estado",
      "county",
      "location",
      "ubicacion",
    ].map((key) => normalizeKey(key))
  );

  return Object.entries(manualData)
    .filter(([key]) => !clientFieldKeys.has(normalizeKey(key)))
    .map(([key, value]) => ({
      key,
      label: formatManualFieldLabel(key),
      value: formatManualFieldValue(value),
    }));
}

function renderManualCallForm(call: any) {
  const manualData = getManualIntakeData(call);
  const intake = call?.intake;
  const manualClientEntries = getManualClientEntries(call);
  const manualCaseEntries = getManualCaseEntries(call);

  if (!intake && Object.keys(manualData).length === 0) {
    return (
      <div className="text-muted-foreground">
        No hay informacion disponible del formulario manual.
      </div>
    );
  }

  return (
    <Card className="rounded-2xl border-border/60 shadow-sm">
      <CardHeader>
        <CardTitle className="text-base">Formulario del caso manual</CardTitle>
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-4">
          <div className="text-sm font-semibold">Vista completa del formulario</div>

          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">
              Informacion del cliente
            </div>
            <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
              {manualClientEntries.map((field) => (
                <div
                  key={`client-${field.key}`}
                  className="rounded-lg border border-border/70 bg-white p-3"
                >
                  <div className="text-xs text-muted-foreground">{field.label}</div>
                  <div className="mt-1 font-medium break-words">{field.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">
              Datos del caso
            </div>
            {manualCaseEntries.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No hay datos adicionales en este formulario.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                {manualCaseEntries.map((field) => (
                  <div
                    key={`case-${field.key}`}
                    className="rounded-lg border border-border/70 bg-white p-3"
                  >
                    <div className="text-xs text-muted-foreground">{field.label}</div>
                    <div className="mt-1 font-medium break-words whitespace-pre-wrap">
                      {field.value}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AttorneyCaseDetailsSection({
  call,
  onSaved,
  toast,
}: {
  call: any;
  onSaved: () => Promise<any>;
  toast: (opts: any) => void;
}) {
  const [isEditingBasic, setIsEditingBasic] = useState(false);
  const [isEditingExtra, setIsEditingExtra] = useState(false);
  const [saving, setSaving] = useState(false);
  const [caseDetails, setCaseDetails] = useState({
    email: getCallEmail(call),
    address: getCallAddress(call),
    city: getCallCity(call),
    stateProvince: getCallState(call),
    location: getCallLocation(call),
    caseType: getCallCaseType(call),
    caseNotes: getCallCaseNotes(call),
  });
  const [extraFields, setExtraFields] = useState<Array<{ label: string; value: string }>>(
    normalizeExtraFields(call?.extraFields)
  );

  useEffect(() => {
    setIsEditingBasic(false);
    setIsEditingExtra(false);
    setCaseDetails({
      email: getCallEmail(call),
      address: getCallAddress(call),
      city: getCallCity(call),
      stateProvince: getCallState(call),
      location: getCallLocation(call),
      caseType: getCallCaseType(call),
      caseNotes: getCallCaseNotes(call),
    });
    setExtraFields(normalizeExtraFields(call?.extraFields));
  }, [call]);

  const save = async () => {
    const retellCallId = getCallKey(call);
    if (!retellCallId) return;

    try {
      setSaving(true);
      const response = await fetch(
        withApiBase(`/api/call-logs/${encodeURIComponent(retellCallId)}/details`),
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            email: caseDetails.email.trim(),
            address: caseDetails.address.trim(),
            city: caseDetails.city.trim(),
            stateProvince: caseDetails.stateProvince.trim(),
            location: caseDetails.location.trim(),
            caseType: caseDetails.caseType.trim(),
            caseNotes: caseDetails.caseNotes.trim(),
            extraFields,
          }),
        }
      );
      if (!response.ok) throw new Error(await response.text());
      await onSaved();
      toast({
        title: "Datos actualizados",
        description: "La informacion del caso se guardo correctamente.",
        className: "border-emerald-200 bg-emerald-50 text-emerald-900",
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error guardando datos",
        description: getErrorMessage(err, "No se pudo guardar la informacion del caso"),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="rounded-2xl border border-border/60 bg-background p-4 space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Datos basicos del caso</div>
          {!isEditingBasic ? (
            <button
              onClick={() => setIsEditingBasic(true)}
              className="text-xs bg-primary text-white px-3 py-1.5 rounded-lg"
            >
              Editar
            </button>
          ) : (
            <button
              onClick={async () => {
                await save();
                setIsEditingBasic(false);
              }}
              disabled={saving}
              className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg disabled:opacity-60"
            >
              {saving ? "Guardando..." : "Guardar"}
            </button>
          )}
        </div>

        {!isEditingBasic ? (
          <div className="space-y-3 text-sm">
            <Field label="Correo" value={caseDetails.email} />
            <Field label="Direccion" value={caseDetails.address} />
            <Field label="Notas importantes" value={caseDetails.caseNotes} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Correo</label>
                <input
                  type="email"
                  value={caseDetails.email}
                  onChange={(e) =>
                    setCaseDetails((prev) => ({ ...prev, email: e.target.value }))
                  }
                  className="w-full rounded-md border border-border px-3 py-2 text-sm"
                  placeholder="cliente@email.com"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Direccion</label>
                <input
                  type="text"
                  value={caseDetails.address}
                  onChange={(e) =>
                    setCaseDetails((prev) => ({ ...prev, address: e.target.value }))
                  }
                  className="w-full rounded-md border border-border px-3 py-2 text-sm"
                  placeholder="123 Main St"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Notas importantes del caso</label>
              <textarea
                value={caseDetails.caseNotes}
                onChange={(e) =>
                  setCaseDetails((prev) => ({ ...prev, caseNotes: e.target.value }))
                }
                className="w-full rounded-md border border-border px-3 py-2 text-sm min-h-[100px]"
                placeholder="Detalles importantes para seguimiento..."
              />
            </div>
          </>
        )}
      </div>

      <div className="rounded-2xl border border-dashed border-border/70 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Informacion adicional</div>
          {!isEditingExtra ? (
            <button
              onClick={() => setIsEditingExtra(true)}
              className="text-xs bg-primary text-white px-3 py-1.5 rounded-lg"
            >
              Editar
            </button>
          ) : (
            <button
              onClick={async () => {
                await save();
                setIsEditingExtra(false);
              }}
              disabled={saving}
              className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg disabled:opacity-60"
            >
              {saving ? "Guardando..." : "Guardar"}
            </button>
          )}
        </div>

        {!isEditingExtra ? (
          <div className="space-y-3 text-sm">
            {extraFields.length === 0 && (
              <div className="text-muted-foreground">No hay informacion adicional.</div>
            )}
            {extraFields.map((field, index) => (
              <Field key={index} label={field.label} value={field.value} />
            ))}
          </div>
        ) : (
          <>
            {extraFields.map((field, index) => (
              <div key={index} className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => {
                    const copy = [...extraFields];
                    copy[index].label = e.target.value;
                    setExtraFields(copy);
                  }}
                  className="rounded-md border border-border px-3 py-2 text-sm"
                />
                <input
                  type="text"
                  value={field.value}
                  onChange={(e) => {
                    const copy = [...extraFields];
                    copy[index].value = e.target.value;
                    setExtraFields(copy);
                  }}
                  className="rounded-md border border-border px-3 py-2 text-sm"
                />
              </div>
            ))}

            <button
              type="button"
              onClick={() => setExtraFields((prev) => [...prev, { label: "", value: "" }])}
              className="text-xs bg-muted px-3 py-1.5 rounded-lg hover:bg-muted/70"
            >
              + Agregar campo
            </button>
          </>
        )}
      </div>
    </>
  );
}

function getCallPhoneNumber(call: any): string {
  const manualData = getManualIntakeData(call);
  return firstText(
    call?.phoneNumber,
    call?.leadPhone,
    call?.phone,
    getManualValueByKeyCandidates(
      manualData,
      ["phone", "phoneNumber", "callerPhone", "telefono", "tel", "cell", "cel", "mobile"],
      { requirePhone: true }
    ),
    call?.phone,
    call?.from_number,
    call?.analysis?.from_number,
    call?.analysis?.post_call_data?.phone,
    call?.analysis?.custom_analysis_data?.phone
  );
}

function StatusBadge({ status }: { status?: string | null }) {
  const s = normalizeCaseStatus(status || "pendiente");

  if (s === "finalizado") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
        Finalizado
      </span>
    );
  }

  if (s === "asignada") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-200">
        <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
        Aceptada por abogado
      </span>
    );
  }

  if (s === "rechazada_por_abogado") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200">
        <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
        Reasignar
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-600" />
      Pendiente
    </span>
  );
}

export default function AttorneyCall() {
  const ITEMS_PER_PAGE = 5;
  const [copiedCallKey, setCopiedCallKey] = useState<string | null>(null);
  const [closingCallKey, setClosingCallKey] = useState<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<any | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activePage, setActivePage] = useState(1);
  const [finalizedPage, setFinalizedPage] = useState(1);
  const [openActiveSection, setOpenActiveSection] = useState(false);
  const [openFinalizedSection, setOpenFinalizedSection] = useState(false);
  const [cityText, setCityText] = useState("");
  const [caseTypeText, setCaseTypeText] = useState("");
  const [nameOrPhoneText, setNameOrPhoneText] = useState("");
  const { toast } = useToast();
  const callId = useMemo(
    () => new URLSearchParams(window.location.search).get("callId") ?? undefined,
    []
  );

  const { data, isLoading, error, refetch } = useAssignedAttorneyCall(callId);
  const calls = useMemo(() => {
    const rows = Array.isArray(data?.calls)
      ? data.calls
      : data?.call
        ? [data.call]
        : [];
    return rows.filter(Boolean);
  }, [data]);

  const filteredCalls = useMemo(() => {
    return calls.filter((call: any) => {
      const callLocationText = norm(getCallCity(call));
      const callCaseType = norm(getCallCaseType(call));

      const cityMatch = !cityText || callLocationText.includes(norm(cityText));
      const caseMatch = !caseTypeText || callCaseType.includes(norm(caseTypeText));

      const searchQuery = norm(nameOrPhoneText);
      const queryDigits = searchQuery.replace(/\D/g, "");
      const callName = norm(
        call?.leadName ??
          call?.analysis?.custom_analysis_data?.name ??
          call?.analysis?.post_call_data?.name ??
          call?.name
      );
      const callPhoneRaw = String(getCallPhoneNumber(call));
      const callPhoneNorm = callPhoneRaw.replace(/\D/g, "");
      const nameMatch = !searchQuery || callName.includes(searchQuery);
      const phoneMatch =
        !searchQuery ||
        (queryDigits.length > 0
          ? callPhoneNorm.includes(queryDigits)
          : norm(callPhoneRaw).includes(searchQuery));
      const nameOrPhoneMatch = !searchQuery || nameMatch || phoneMatch;

      return cityMatch && caseMatch && nameOrPhoneMatch;
    });
  }, [calls, cityText, caseTypeText, nameOrPhoneText]);

  const activeCalls = useMemo(
    () => filteredCalls.filter((call: any) => normalizeCaseStatus(call?.status) !== "finalizado"),
    [filteredCalls]
  );
  const finalizedCalls = useMemo(
    () => filteredCalls.filter((call: any) => normalizeCaseStatus(call?.status) === "finalizado"),
    [filteredCalls]
  );

  const activeTotalPages = Math.max(1, Math.ceil(activeCalls.length / ITEMS_PER_PAGE));
  const finalizedTotalPages = Math.max(1, Math.ceil(finalizedCalls.length / ITEMS_PER_PAGE));

  useEffect(() => {
    setActivePage(1);
    setFinalizedPage(1);
  }, [filteredCalls]);

  useEffect(() => {
    setActivePage((p) => Math.min(p, activeTotalPages));
  }, [activeTotalPages]);

  useEffect(() => {
    setFinalizedPage((p) => Math.min(p, finalizedTotalPages));
  }, [finalizedTotalPages]);

  const activeCallsPage = useMemo(() => {
    const start = (activePage - 1) * ITEMS_PER_PAGE;
    return activeCalls.slice(start, start + ITEMS_PER_PAGE);
  }, [activeCalls, activePage]);

  const finalizedCallsPage = useMemo(() => {
    const start = (finalizedPage - 1) * ITEMS_PER_PAGE;
    return finalizedCalls.slice(start, start + ITEMS_PER_PAGE);
  }, [finalizedCalls, finalizedPage]);

  useEffect(() => {
    if (!selectedCall) return;
    const selectedKey = getCallKey(selectedCall);
    if (!selectedKey) return;

    const updated = calls.find((call: any) => getCallKey(call) === selectedKey);
    if (updated) {
      setSelectedCall(updated);
    }
  }, [calls, selectedCall]);

  useEffect(() => {
    if (!callId) return;
    const targetCallId = String(callId);

    const targetActiveIndex = activeCalls.findIndex(
      (call: any) => getCallKey(call) === targetCallId
    );
    if (targetActiveIndex >= 0) {
      const page = Math.floor(targetActiveIndex / ITEMS_PER_PAGE) + 1;
      setActivePage(page);
      setOpenActiveSection(true);
      setOpenFinalizedSection(false);
      setSelectedCall(activeCalls[targetActiveIndex]);
      setDetailsOpen(true);
      return;
    }

    const targetFinalizedIndex = finalizedCalls.findIndex(
      (call: any) => getCallKey(call) === targetCallId
    );
    if (targetFinalizedIndex >= 0) {
      const page = Math.floor(targetFinalizedIndex / ITEMS_PER_PAGE) + 1;
      setFinalizedPage(page);
      setOpenFinalizedSection(true);
      setOpenActiveSection(false);
      setSelectedCall(finalizedCalls[targetFinalizedIndex]);
      setDetailsOpen(true);
    }
  }, [callId, activeCalls, finalizedCalls]);

  async function closeCase(call: any) {
    const retellCallId = getCallKey(call);
    if (!retellCallId) {
      toast({
        variant: "destructive",
        title: "No se puede cerrar este caso",
        description: "No encontre el identificador de la llamada.",
      });
      return;
    }

    try {
      setClosingCallKey(retellCallId);
      const response = await fetch(withApiBase("/api/attorney/close-case"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ retellCallId }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      toast({
        title: "Caso finalizado",
        description: "El caso fue marcado como finalizado en todo el CRM.",
        className: "border-emerald-200 bg-emerald-50 text-emerald-900",
      });

      await refetch();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error al cerrar caso",
        description: getErrorMessage(err, "No se pudo finalizar el caso"),
      });
    } finally {
      setClosingCallKey(null);
    }
  }

  function renderCaseDetail(call: any) {
    const callKey = getCallKey(call);
    const copied = copiedCallKey === callKey;
    const isFinalized = normalizeCaseStatus(call?.status) === "finalizado";
    const isClosing = closingCallKey === callKey;
    const manual = isManualCall(call);

    return (
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-xl">Detalle del caso</CardTitle>
            <div className="flex items-center gap-2">
              <StatusBadge status={call.status} />
              {!isFinalized && (
                <button
                  type="button"
                  onClick={() => closeCase(call)}
                  disabled={isClosing}
                  className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 transition disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {isClosing ? "Cerrando..." : "Cerrar caso"}
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {call.leadName ?? "AI Lead"}
            </span>

            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4 opacity-60" />
              {formatDuration(call.duration)}
            </span>

            {getCallPhoneNumber(call) && (
              <span className="flex items-center gap-1">
                <Phone className="h-4 w-4 opacity-60" />
                {getCallPhoneNumber(call)}
              </span>
            )}

            <span className="flex items-center gap-1">
              <FileText className="h-4 w-4 opacity-60" />
              {manual ? "Formulario manual" : getCallSummary(call) ? "Con resumen" : "Sin resumen"}
            </span>
          </div>
        </CardHeader>

        <CardContent>
          {manual ? (
            renderManualCallForm(call)
          ) : (
          <Tabs defaultValue="resumen" className="w-full">
            <TabsList className="grid w-full grid-cols-4 rounded-xl">
              <TabsTrigger value="resumen" className="rounded-lg">
                Resumen
              </TabsTrigger>
              <TabsTrigger value="transcripcion" className="rounded-lg">
                Transcripcion
              </TabsTrigger>
              <TabsTrigger value="analisis" className="rounded-lg">
                Analisis
              </TabsTrigger>
              <TabsTrigger value="audio" className="rounded-lg" disabled={!getRecordingUrl(call)}>
                Audio
              </TabsTrigger>
            </TabsList>

            <TabsContent value="resumen" className="mt-4">
              <Card className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Resumen</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-foreground/80 leading-relaxed">
                  {getCallSummary(call) || "Sin resumen disponible."}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="transcripcion" className="mt-4">
              <Card className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="text-base">Transcripcion</CardTitle>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(getCallTranscript(call));
                      setCopiedCallKey(callKey);
                      setTimeout(() => setCopiedCallKey(null), 1500);
                    }}
                    disabled={!getCallTranscript(call)}
                    className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Copy className="h-4 w-4" />
                    {copied ? "Copiado" : "Copiar"}
                  </button>
                </CardHeader>

                <CardContent>
                  <div className="rounded-2xl border border-border/60 bg-muted/30 p-4 text-sm whitespace-pre-wrap leading-relaxed">
                    {getCallTranscript(call) || "Sin transcripcion disponible."}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="analisis" className="mt-4">
              <Card className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Analisis</CardTitle>
                </CardHeader>

                <CardContent className="space-y-4">
                  <Separator />
                  <div className="space-y-3 text-sm">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                        <div className="text-xs text-muted-foreground">Sentimiento</div>
                        <div className="font-medium">
                          {getAnalysisSentiment(call)}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                        <div className="text-xs text-muted-foreground">Exitosa</div>
                        <div className="font-medium">
                          {getAnalysisSuccessLabel(call)}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                      <div className="text-xs text-muted-foreground mb-2">Resumen IA</div>
                      <div className="leading-relaxed text-foreground/80">
                        {getCallSummary(call) || "-"}
                      </div>
                    </div>

                    <AttorneyCaseDetailsSection
                      call={call}
                      onSaved={async () => {
                        await refetch();
                      }}
                      toast={toast}
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="audio" className="mt-4">
              <Card className="rounded-2xl border-border/60 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Audio</CardTitle>
                </CardHeader>
                <CardContent>
                  {getRecordingUrl(call) ? (
                    <audio controls className="w-full">
                      <source src={getRecordingUrl(call)} />
                    </audio>
                  ) : (
                    <div className="text-sm text-muted-foreground">No hay audio disponible.</div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
          )}
        </CardContent>
      </Card>
    );
  }

  function renderCaseListItem(call: any, idx: number, toneOffset = 0) {
    const callKey = getCallKey(call);
    const manual = isManualCall(call);
    const tinted = (idx + toneOffset) % 2 === 0;
    const cardTone = tinted
      ? "border-sky-200 bg-sky-50/70 hover:bg-sky-100/70"
      : "border-border/60 bg-white hover:bg-slate-50/80";

    return (
      <button
        key={callKey || String(call?.id ?? idx)}
        type="button"
        onClick={() => {
          setSelectedCall(call);
          setDetailsOpen(true);
        }}
        className="group block w-full text-left"
      >
        <Card className={`shadow-sm transition-colors ${cardTone}`}>
          <CardContent className="p-5">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="text-lg font-semibold text-foreground">
                    {call?.leadName ?? "AI Lead"}
                  </div>
                  <StatusBadge status={call?.status} />
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-4 w-4 opacity-60" />
                    {formatDuration(call?.duration)}
                  </span>

                  {getCallPhoneNumber(call) && (
                    <span className="flex items-center gap-1">
                      <Phone className="h-4 w-4 opacity-60" />
                      {getCallPhoneNumber(call)}
                    </span>
                  )}

                  <span className="flex items-center gap-1">
                    <FileText className="h-4 w-4 opacity-60" />
                    {manual ? "Formulario manual" : getCallSummary(call) ? "Con resumen" : "Sin resumen"}
                  </span>
                </div>

                <div className="text-sm text-foreground/75 line-clamp-2">
                  {manual
                    ? "Haz clic para ver el formulario completo del caso."
                    : getCallSummary(call) || "Sin resumen disponible para este caso."}
                </div>
              </div>

              <div className="ml-auto inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-sky-200 bg-white/80 px-3 py-2 text-xs font-semibold text-sky-800 transition-colors duration-200 group-hover:border-blue-400 group-hover:bg-blue-600 group-hover:text-white">
                Ver detalles
                <ChevronRight className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
      </button>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />

      <div className="md:pl-64">
        <div className="p-8 space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <h1 className="text-3xl font-bold tracking-tight">Mis casos</h1>
              <p className="text-muted-foreground">
                Aqui aparecen todos los casos enviados por admin o agente
              </p>
            </div>

            <button
              type="button"
              onClick={() => refetch()}
              className="rounded-xl px-4 py-2 text-sm font-medium border border-border hover:bg-muted transition"
            >
              Actualizar
            </button>
          </div>

          {isLoading && <div className="text-muted-foreground">Cargando casos...</div>}

          {error && (
            <div className="text-destructive">
              Error cargando casos: {String((error as any)?.message ?? error)}
            </div>
          )}

          {!isLoading && !error && calls.length === 0 && (
            <Card className="border-border/60 shadow-sm">
              <CardContent className="py-8 text-muted-foreground">
                No tienes casos enviados por ahora.
              </CardContent>
            </Card>
          )}

          {!isLoading && !error && calls.length > 0 && (
            <>
              <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-gray-700">
                    Buscar por nombre o numero
                  </label>
                  <input
                    type="text"
                    placeholder="Ej: Maria o +1 555..."
                    value={nameOrPhoneText}
                    onChange={(e) => setNameOrPhoneText(e.target.value)}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-gray-700">
                    Ciudad / Ubicacion (EE. UU.)
                  </label>
                  <input
                    list="attorney-us-cities"
                    type="text"
                    placeholder="Escribe una ciudad..."
                    value={cityText}
                    onChange={(e) => setCityText(e.target.value)}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <datalist id="attorney-us-cities">
                    {US_CITIES.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-gray-700">Tipo de caso</label>
                  <input
                    list="attorney-case-types"
                    type="text"
                    placeholder="Escribe un tipo de caso..."
                    value={caseTypeText}
                    onChange={(e) => setCaseTypeText(e.target.value)}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <datalist id="attorney-case-types">
                    {CASE_TYPES.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  <span className="text-xs text-muted-foreground">
                    Puedes escribir cualquier otro tipo si no aparece.
                  </span>
                </div>
              </div>

              <Card className="border-border/60 shadow-sm">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Phone className="h-5 w-5" />
                    Casos
                  </CardTitle>
                </CardHeader>

                <CardContent className="pt-0">
                  {filteredCalls.length === 0 ? (
                    <div className="text-muted-foreground">
                      No hay casos que coincidan con los filtros.
                    </div>
                  ) : (
                    <div className="space-y-6">
                      <section className="space-y-4 rounded-xl border border-border/60 p-4">
                        <div className="flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => setOpenActiveSection((v) => !v)}
                            className="inline-flex items-center gap-2 text-sm font-semibold text-green-700 dark:text-green-300"
                          >
                            {openActiveSection ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                            Casos activos
                          </button>
                          <span className="inline-flex min-w-9 items-center justify-center rounded-full bg-muted px-3 py-1 text-lg font-bold text-foreground">
                            {activeCalls.length}
                          </span>
                        </div>

                        {openActiveSection && (
                          <>
                            {activeCalls.length === 0 ? (
                              <div className="rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                                No hay casos activos.
                              </div>
                            ) : (
                              <>
                                <div className="space-y-4">
                                  {activeCallsPage.map((call: any, idx: number) =>
                                    renderCaseListItem(call, idx, (activePage - 1) * ITEMS_PER_PAGE)
                                  )}
                                </div>
                                <div className="flex items-center justify-end gap-3">
                                  <button
                                    type="button"
                                    onClick={() => setActivePage((p) => Math.max(1, p - 1))}
                                    disabled={activePage <= 1}
                                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    Anterior
                                  </button>
                                  <span className="text-xs text-muted-foreground">
                                    Pagina {activePage} de {activeTotalPages}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setActivePage((p) => Math.min(activeTotalPages, p + 1))
                                    }
                                    disabled={activePage >= activeTotalPages}
                                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    Siguiente
                                  </button>
                                </div>
                              </>
                            )}
                          </>
                        )}
                      </section>

                      <section className="space-y-4 rounded-xl border border-border/60 p-4">
                        <div className="flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => setOpenFinalizedSection((v) => !v)}
                            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-300"
                          >
                            {openFinalizedSection ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                            Casos finalizados
                          </button>
                          <span className="inline-flex min-w-9 items-center justify-center rounded-full bg-muted px-3 py-1 text-lg font-bold text-foreground">
                            {finalizedCalls.length}
                          </span>
                        </div>

                        {openFinalizedSection && (
                          <>
                            {finalizedCalls.length === 0 ? (
                              <div className="rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                                Aun no hay casos finalizados.
                              </div>
                            ) : (
                              <>
                                <div className="space-y-4">
                                  {finalizedCallsPage.map((call: any, idx: number) =>
                                    renderCaseListItem(
                                      call,
                                      idx,
                                      activeCallsPage.length + (finalizedPage - 1) * ITEMS_PER_PAGE
                                    )
                                  )}
                                </div>
                                <div className="flex items-center justify-end gap-3">
                                  <button
                                    type="button"
                                    onClick={() => setFinalizedPage((p) => Math.max(1, p - 1))}
                                    disabled={finalizedPage <= 1}
                                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    Anterior
                                  </button>
                                  <span className="text-xs text-muted-foreground">
                                    Pagina {finalizedPage} de {finalizedTotalPages}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setFinalizedPage((p) => Math.min(finalizedTotalPages, p + 1))
                                    }
                                    disabled={finalizedPage >= finalizedTotalPages}
                                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    Siguiente
                                  </button>
                                </div>
                              </>
                            )}
                          </>
                        )}
                      </section>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      <Dialog
        open={detailsOpen}
        onOpenChange={(open) => {
          setDetailsOpen(open);
          if (!open) {
            setSelectedCall(null);
          }
        }}
      >
        <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto p-0">
          <div className="p-6 pr-14">
            <DialogHeader className="sr-only">
              <DialogTitle>Detalle del caso</DialogTitle>
            </DialogHeader>
            {selectedCall ? (
              renderCaseDetail(selectedCall)
            ) : (
              <div className="text-sm text-muted-foreground">Selecciona un caso.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
