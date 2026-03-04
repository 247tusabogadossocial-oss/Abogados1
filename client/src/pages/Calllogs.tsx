import { useCallback, useEffect, useMemo, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { useCallLogs } from "@/hooks/use-call-logs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Phone,
  Clock,
  Copy,
  Gavel,
  MapPin,
  Send,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { withApiBase } from "@/lib/queryClient";

import { US_CITIES } from "@/hooks/usCities";
import { CASE_TYPES } from "@/hooks/caseTypes";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";





function formatDuration(seconds?: number | null) {
  const s = Math.max(0, Number(seconds ?? 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function StatusBadge({
  status,
  assignmentStatus,
}: {
  status?: string | null;
  assignmentStatus?: string | null;
}) {
  const s = (status ?? "pendiente").toLowerCase();
  const as = (assignmentStatus ?? "").toLowerCase();

  if (s === "pendiente_aprobacion_abogado") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-orange-100 px-3 py-1 text-xs font-medium text-orange-800 dark:bg-orange-900/40 dark:text-orange-200">
        <span className="h-1.5 w-1.5 rounded-full bg-orange-600" />
        Pendiente por aprobacion del abogado
      </span>
    );
  }

  if (s === "pendiente") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-600" />
        Pendiente
      </span>
    );
  }

  if (s === "en_espera_aceptacion") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-600" />
        En espera de aceptacion
      </span>
    );
  }

  if (s === "asignada") {
    if (as === "delivered") {
      return (
        <span className="inline-flex items-center gap-2 rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-600" />
          Caso enviado al abogado
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-200">
        <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
        Aceptada por abogado
      </span>
    );
  }

  if (s === "finalizado") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
        Finalizado
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
    <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
      {status ?? "-"}
    </span>
  );
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

function extractLocationFromText(value: any): string {
  const text = firstText(value);
  if (!text) return "";

  const patterns = [
    /\b(?:live in|vivo en|resido en)\s+([a-zA-Z .'-]+,\s*[a-zA-Z .'-]+)/i,
    /\b(?:from|soy de|de)\s+([a-zA-Z .'-]+,\s*[a-zA-Z .'-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return firstText(match[1]);
  }

  return "";
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
    // Keep the original message when it is not JSON.
  }

  return message;
}

function getCallCity(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};

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
    findByKeyFragments(cad, ["city", "ciudad", "residence", "residencia"]),
    findByKeyFragments(postData, ["city", "ciudad", "residence", "residencia"])
  );
}

function getCallState(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};

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
    findByKeyFragments(cad, ["state", "estado", "province", "provincia"]),
    findByKeyFragments(postData, ["state", "estado", "province", "provincia"])
  );
}

function getCallLocation(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};

  return firstText(
    call?.location,
    call?.analysis?.location,
    call?.analysis?.post_call_data?.location,
    call?.analysis?.custom_analysis_data?.location,
    call?.analysis?.custom_analysis_data?.ubicacion,
    cad?.residencia,
    cad?.residence,
    findByKeyFragments(cad, ["location", "ubicacion", "residence", "residencia"]),
    findByKeyFragments(postData, ["location", "ubicacion", "residence", "residencia"])
  );
}

function getCallLocationLabel(call: any): string {
  const location = getCallLocation(call);
  if (location) return location;

  const city = getCallCity(call);
  const state = getCallState(call);
  if (city && state) return `${city}, ${state}`;

  const inferredFromNotes = firstText(
    extractLocationFromText(call?.transcript),
    extractLocationFromText(call?.analysis?.transcript),
    extractLocationFromText(call?.summary),
    extractLocationFromText(call?.analysis?.call_summary)
  );
  if (inferredFromNotes) return inferredFromNotes;

  return city || state || "Location pending capture";
}

function getCallCaseType(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};

  return firstText(
    call?.caseType,
    call?.case_type,
    call?.analysis?.caseType,
    call?.analysis?.case_type,
    call?.analysis?.post_call_data?.case_type,
    call?.post_call_data?.case_type,
    call?.extracted?.case_type,
    call?.analysis?.custom_analysis_data?.case_type,
    cad?.tipo_caso,
    findByKeyFragments(cad, ["case", "caso", "practice", "matter"]),
    findByKeyFragments(postData, ["case", "caso", "practice", "matter"])
  );
}

function getCallEmail(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};

  return firstText(
    call?.email,
    call?.leadEmail,
    call?.analysis?.email,
    call?.analysis?.post_call_data?.email,
    call?.analysis?.custom_analysis_data?.email,
    call?.analysis?.custom_analysis_data?.correo,
    findByKeyFragments(cad, ["email", "correo"]),
    findByKeyFragments(postData, ["email", "correo"])
  );
}

function getCallAddress(call: any): string {
  const cad = call?.analysis?.custom_analysis_data ?? {};
  const postData = call?.analysis?.post_call_data ?? call?.post_call_data ?? {};

  return firstText(
    call?.address,
    call?.analysis?.address,
    call?.analysis?.post_call_data?.address,
    call?.analysis?.custom_analysis_data?.address,
    call?.analysis?.custom_analysis_data?.direccion,
    findByKeyFragments(cad, ["address", "direccion", "street"]),
    findByKeyFragments(postData, ["address", "direccion", "street"])
  );
}

function getCallCaseNotes(call: any): string {
  return firstText(call?.caseNotes);
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

function getCallPhoneNumber(call: any): string {
  return firstText(
    call?.phoneNumber,
    call?.leadPhone,
    call?.phone,
    call?.from_number,
    call?.analysis?.from_number,
    call?.analysis?.post_call_data?.phone,
    call?.analysis?.custom_analysis_data?.phone
  );
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

function getDisconnectionReason(call: any): string {
  return String(
    call?.analysis?.disconnection_reason ??
    call?.analysis?.call_disconnection_reason ??
    call?.analysis?.call?.disconnection_reason ??
    call?.analysis?.post_call_analysis?.disconnection_reason ??
    call?.analysis?.post_call_analysis?.call_disconnection_reason ??
    ""
  ).trim();
}

function hasMeaningfulText(value: any, minLength = 1): boolean {
  return String(value ?? "").trim().length >= minLength;
}

function getCallCreatedAtMs(call: any): number {
  const raw = call?.createdAt ?? call?.created_at ?? 0;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRetellCallId(call: any): string {
  return firstText(call?.retellCallId, call?.call_id, call?.callId);
}

function isReadyToSendToAttorney(call: any): boolean {
  const status = String(call?.status ?? "").toLowerCase();
  const assignmentStatus = String(call?.assignmentStatus ?? "").toLowerCase();
  return status === "asignada" && assignmentStatus === "accepted";
}

function isCompleteCall(call: any): boolean {
  const summary =
    call?.summary ??
    call?.analysis?.call_summary ??
    call?.analysis?.post_call_analysis?.call_summary ??
    "";
  const transcript = call?.transcript ?? call?.analysis?.transcript ?? "";
  const reason = getDisconnectionReason(call).toLowerCase();
  const status = String(call?.status ?? "").toLowerCase();
  const successful = call?.analysis?.call_successful;

  const reasonText = `${reason} ${String(summary ?? "").toLowerCase()}`;
  const inactivityKeywords = [
    "inactivity",
    "inactive",
    "timeout",
    "no response",
    "no answer",
    "hang up",
    "hung up",
    "inactividad",
    "sin respuesta",
    "colgo",
  ];

  const endedByInactivity = inactivityKeywords.some((k) => reasonText.includes(k));
  const hasSummary = hasMeaningfulText(summary, 10);
  const hasTranscript = hasMeaningfulText(transcript, 20);
  const explicitlyBadStatus = status === "failed" || status === "error";

  if (endedByInactivity || explicitlyBadStatus) return false;
  if (successful === false) return false;
  if (!hasSummary || !hasTranscript) return false;
  return true;
}

type CallCardProps = {
  call: any;
  onView: () => void;
  onAssign?: () => void;
  onSendToAttorney?: () => void;
  sendingToAttorney?: boolean;
  idx?: number;
  toneOffset?: number;
};

function CallCard({
  call,
  onView,
  onAssign,
  onSendToAttorney,
  sendingToAttorney,
  idx = 0,
  toneOffset = 0,
}: CallCardProps) {
  const tinted = (idx + toneOffset) % 2 === 0;
  const cardTone = tinted
    ? "border-sky-200 bg-sky-50/70 hover:bg-sky-100/70"
    : "border-border/60 bg-white hover:bg-slate-50/80";
  const actionButtonClass =
    "inline-flex items-center gap-2 rounded-lg border border-sky-200 bg-white/80 px-3 py-2 text-xs font-semibold text-sky-800 transition-colors duration-200 hover:border-blue-400 hover:bg-blue-600 hover:text-white";

  return (
    <div className={`group rounded-2xl border p-5 shadow-sm transition-colors ${cardTone}`}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-semibold truncate">
              {call.leadName ?? "AI Lead"}
            </span>
            <StatusBadge
              status={call.status ?? "ended"}
              assignmentStatus={call.assignmentStatus}
            />
          </div>
        </div>

        <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2 self-start">
          <button
            type="button"
            onClick={onView}
            className={actionButtonClass}
          >
            Ver detalles
            <ChevronRight className="h-4 w-4" />
          </button>

          {onSendToAttorney ? (
            <button
              type="button"
              disabled={!!sendingToAttorney}
              onClick={onSendToAttorney}
              className={`${actionButtonClass} disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-sky-200 disabled:hover:bg-white/80 disabled:hover:text-sky-800`}
            >
              <Send className="h-4 w-4" />
              {sendingToAttorney ? "Enviando..." : "Enviar a abogado"}
            </button>
          ) : onAssign ? (
            <button
              type="button"
              onClick={onAssign}
              className={actionButtonClass}
            >
              <Gavel className="h-4 w-4" />
              Asignar abogado
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          <Phone className="h-4 w-4 opacity-70" />
          {getCallPhoneNumber(call) || "Sin numero"}
        </span>

        <span className="flex items-center gap-1">
          <MapPin className="h-4 w-4 opacity-70" />
          {getCallLocationLabel(call)}
        </span>

        <span className="flex items-center gap-1">
          <Clock className="h-4 w-4 opacity-70" />
          {formatDuration(call.duration)}
        </span>

      </div>

      <div className="mt-3 text-sm text-foreground/80 leading-relaxed line-clamp-2 min-h-[2.75rem]">
        {String(call?.retellCallId ?? "").startsWith("manual-")
          ? "Haz clic para ver el formulario completo del caso."
          : getCallSummary(call) || "Sin resumen disponible para esta llamada."}
      </div>
    </div>
  );
}
function Field({ label, value }: { label: string; value: any }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value || "-"}</div>
    </div>
  );
}

function BooleanField({ label, value }: { label: string; value: any }) {
  const isTrue = value === true || value === "Yes";
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <span
        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${isTrue
          ? "bg-green-50 text-green-700"
          : "bg-red-50 text-red-700"
          }`}
      >
        {isTrue ? "Yes" : "No"}
      </span>
    </div>
  );
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

export default function CallLogs() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: logs, isLoading, error, refetch: refetchCallLogs } = useCallLogs();


  // Fuente real de query params (no falla)
  const [searchStr, setSearchStr] = useState(() => window.location.search);




  // Actualiza searchStr si cambia la URL (cuando navegas con wouter)



  useEffect(() => {
    const onPop = () => setSearchStr(window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);



  const sp = useMemo(() => new URLSearchParams(searchStr), [searchStr]);

  const phoneFromUrl = sp.get("phone");
  const callIdFromUrl = sp.get("callId");
  const fromUrl = sp.get("from"); // "/leads" o "/dashboard"
  const clearCallQueryParams = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("phone");
    url.searchParams.delete("callId");
    url.searchParams.delete("from");
    const nextSearch = url.searchParams.toString();
    const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}`;
    window.history.replaceState(window.history.state, "", nextUrl);
    setSearchStr(window.location.search);
  }, []);

  // modal detalle
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  // modal asignar abogado
  const [assignOpen, setAssignOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [sendingToAttorneyCallId, setSendingToAttorneyCallId] = useState<string | null>(null);
  const [attorneys, setAttorneys] = useState<any[]>([]);
  const [attorneysLoading, setAttorneysLoading] = useState(false);
  const [attorneysError, setAttorneysError] = useState<string | null>(null);
  const [confirmAssignOpen, setConfirmAssignOpen] = useState(false);
  const [attorneyToAssign, setAttorneyToAssign] = useState<any>(null);
  const [assignmentNotes, setAssignmentNotes] = useState("");
  const [savingCaseDetails, setSavingCaseDetails] = useState(false);
  const [caseDetails, setCaseDetails] = useState({
    email: "",
    address: "",
    city: "",
    stateProvince: "",
    location: "",
    caseType: "",
    caseNotes: "",
  });
  const [extraFields, setExtraFields] = useState<
    { label: string; value: string }[]
  >([]);
  // filtros
  const [cityText, setCityText] = useState("");
  const [caseTypeText, setCaseTypeText] = useState("");
  const [nameOrPhoneText, setNameOrPhoneText] = useState("");

  const [isEditingBasic, setIsEditingBasic] = useState(false);
  const [isEditingExtra, setIsEditingExtra] = useState(false);




  const filteredLogs = useMemo(() => {
    return (logs ?? []).filter((call: any) => {
      const callLocationText = norm(
        [getCallLocation(call), getCallCity(call), getCallState(call)]
          .filter(Boolean)
          .join(" ")
      );



      const callCaseType = norm(getCallCaseType(call));

      const cityMatch = !cityText || callLocationText.includes(norm(cityText));
      const caseMatch = !caseTypeText || callCaseType.includes(norm(caseTypeText));
      const searchQuery = norm(nameOrPhoneText);
      const queryDigits = searchQuery.replace(/\D/g, "");
      const callName = norm(
        call.leadName ??
        call.analysis?.custom_analysis_data?.name ??
        call.analysis?.post_call_data?.name ??
        call.name
      );
      const callPhoneRaw = String(
        call.phoneNumber ??
        call.phone ??
        call.from_number ??
        call.analysis?.from_number ??
        call.analysis?.post_call_data?.phone ??
        ""
      );
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
  }, [logs, cityText, caseTypeText, nameOrPhoneText]);

  // PAGINACION
  const ITEMS_PER_PAGE = 5;
  const [completePage, setCompletePage] = useState(1);
  const [incompletePage, setIncompletePage] = useState(1);
  const [manualPage, setManualPage] = useState(1);
  const [openCompleteSection, setOpenCompleteSection] = useState(false);
  const [openIncompleteSection, setOpenIncompleteSection] = useState(false);
  const [openManualSection, setOpenManualSection] = useState(false);

  // Resetear paginas cuando cambien filtros o datos
  useEffect(() => {
    setCompletePage(1);
    setIncompletePage(1);
    setManualPage(1);
  }, [cityText, caseTypeText, nameOrPhoneText, logs]);

  const { completeLogsAll, incompleteLogsAll, manualLogsAll } = useMemo(() => {
    const sortedLogs = [...filteredLogs].sort(
      (a: any, b: any) => getCallCreatedAtMs(b) - getCallCreatedAtMs(a)
    );

    const complete: any[] = [];
    const incomplete: any[] = [];
    const manual: any[] = [];

    for (const call of sortedLogs) {
      const retellId = String(call.retellCallId ?? "");
      const isManual = retellId.startsWith("manual-");

      if (isManual) {
        manual.push(call);
        continue;
      }

      if (isCompleteCall(call)) {
        complete.push(call);
      } else {
        incomplete.push(call);
      }
    }

    return {
      completeLogsAll: complete,
      incompleteLogsAll: incomplete,
      manualLogsAll: manual,
    };
  }, [filteredLogs]);

  const completeTotalPages = Math.max(
    1,
    Math.ceil(completeLogsAll.length / ITEMS_PER_PAGE)
  );
  const incompleteTotalPages = Math.max(
    1,
    Math.ceil(incompleteLogsAll.length / ITEMS_PER_PAGE)
  );
  const manualTotalPages = Math.max(
    1,
    Math.ceil(manualLogsAll.length / ITEMS_PER_PAGE)
  );

  useEffect(() => {
    setCompletePage((p) => Math.min(p, completeTotalPages));
  }, [completeTotalPages]);

  useEffect(() => {
    setIncompletePage((p) => Math.min(p, incompleteTotalPages));
  }, [incompleteTotalPages]);

  useEffect(() => {
    setManualPage((p) => Math.min(p, manualTotalPages));
  }, [manualTotalPages]);

  const completeLogs = useMemo(() => {
    const start = (completePage - 1) * ITEMS_PER_PAGE;
    return completeLogsAll.slice(start, start + ITEMS_PER_PAGE);
  }, [completeLogsAll, completePage]);

  const incompleteLogs = useMemo(() => {
    const start = (incompletePage - 1) * ITEMS_PER_PAGE;
    return incompleteLogsAll.slice(start, start + ITEMS_PER_PAGE);
  }, [incompleteLogsAll, incompletePage]);

  const manualLogs = useMemo(() => {
    const start = (manualPage - 1) * ITEMS_PER_PAGE;
    return manualLogsAll.slice(start, start + ITEMS_PER_PAGE);
  }, [manualLogsAll, manualPage]);


  // Auto-open por phone

  useEffect(() => {
    if (!phoneFromUrl) return;
    if (!logs?.length) return;
    if (open) return;

    const normalizePhone = (s: string) => (s || "").replace(/[^\d+]/g, "");
    const target = normalizePhone(phoneFromUrl);

    const match = [...logs]
      .sort(
        (a: any, b: any) =>
          (b.createdAt ?? b.created_at ?? 0) - (a.createdAt ?? a.created_at ?? 0)
      )
      .find((l: any) => normalizePhone(l.phoneNumber ?? "") === target);

    if (match) {
      setSelected(match);
      setOpen(true);
    }
  }, [phoneFromUrl, logs, open]);

  // Auto-open por callId
  useEffect(() => {
    if (!callIdFromUrl) return;
    if (!logs?.length) return;
    if (open) return;

    const found = (logs ?? []).find((l: any) => {
      const id = String(l.retellCallId ?? l.call_id ?? l.callId ?? l.id ?? "");
      return id === String(callIdFromUrl);
    });

    if (found) {
      setSelected(found);
      setOpen(true);
    }
  }, [callIdFromUrl, logs, open]);

  // Cargar abogados cuando abres el modal asignar
  useEffect(() => {
    if (!assignOpen) return;

    (async () => {
      setAttorneysLoading(true);
      setAttorneysError(null);
      try {
        const r = await fetch(withApiBase("/api/attorneys"), {
          credentials: "include",
        });
        if (!r.ok) throw new Error(await r.text());
        const data = await r.json();
        setAttorneys(Array.isArray(data) ? data : []);
      } catch (e: any) {
        setAttorneysError(e?.message ?? "Error cargando attorneys");
        setAttorneys([]);
      } finally {
        setAttorneysLoading(false);
      }
    })();
  }, [assignOpen]);

  const getLeadIdFromSelected = (s: any) => {
    const id = Number(s?.leadId ?? s?.lead_id ?? s?.lead?.id ?? 0);
    return Number.isFinite(id) && id > 0 ? id : null;
  };
  const selectedLeadId = selected ? getLeadIdFromSelected(selected) : null;
  const isManual = selected?.retellCallId?.startsWith("manual-");
  const intakeRows = useQuery(
    api.intakes.getByLeadId,
    selectedLeadId && isManual
      ? {
          leadId: selectedLeadId,
        }
      : "skip"
  );
  const intake = useMemo(() => {
    if (!Array.isArray(intakeRows) || intakeRows.length === 0) return null;
    return [...intakeRows].sort(
      (a: any, b: any) =>
        Number(b?.updatedAt ?? b?.createdAt ?? 0) -
        Number(a?.updatedAt ?? a?.createdAt ?? 0)
    )[0];
  }, [intakeRows]);
  const manualIntakeData = useMemo(() => {
    if (!intake || typeof intake?.data !== "object" || intake?.data == null) return {};
    return intake.data as Record<string, any>;
  }, [intake]);
  const clientFieldKeys = useMemo(
    () =>
      new Set(
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
      ),
    []
  );
  const manualClientEntries = useMemo(() => {
    const firstName = getManualValueByKeyCandidates(manualIntakeData, [
      "firstName",
      "first_name",
      "nombre",
    ]);
    const lastName = getManualValueByKeyCandidates(manualIntakeData, [
      "lastName",
      "last_name",
      "surname",
      "apellido",
      "apellidos",
    ]);
    const name = firstText(
      getManualValueByKeyCandidates(manualIntakeData, ["name", "fullName", "clientName"]),
      [firstName, lastName].filter(Boolean).join(" ").trim(),
      firstName
    );
    const phone = getManualValueByKeyCandidates(
      manualIntakeData,
      ["phone", "phoneNumber", "callerPhone", "telefono", "tel", "cell", "cel", "mobile"],
      { requirePhone: true }
    );
    const email = getManualValueByKeyCandidates(manualIntakeData, ["email", "correo"]);
    const address = getManualValueByKeyCandidates(manualIntakeData, ["address", "direccion"]);
    const city = getManualValueByKeyCandidates(manualIntakeData, ["city", "ciudad"]);
    const state = getManualValueByKeyCandidates(manualIntakeData, [
      "stateProvince",
      "state",
      "estado",
    ]);
    const county = getManualValueByKeyCandidates(manualIntakeData, ["county"]);

    return [
      { key: "name", label: "Name", value: formatManualFieldValue(name) },
      { key: "phone", label: "Phone", value: formatManualFieldValue(phone) },
      { key: "email", label: "Email", value: formatManualFieldValue(email) },
      { key: "address", label: "Address", value: formatManualFieldValue(address) },
      { key: "city", label: "City", value: formatManualFieldValue(city) },
      { key: "state", label: "State", value: formatManualFieldValue(state) },
      { key: "county", label: "County", value: formatManualFieldValue(county) },
    ];
  }, [manualIntakeData]);
  const manualCaseEntries = useMemo(() => {
    return Object.entries(manualIntakeData)
      .filter(([key]) => !clientFieldKeys.has(normalizeKey(key)))
      .map(([key, value]) => ({
        key,
        label: formatManualFieldLabel(key),
        value: formatManualFieldValue(value),
      }));
  }, [clientFieldKeys, manualIntakeData]);
  const selectedRetellCallId = String(
    selected?.retellCallId ?? selected?.call_id ?? selected?.callId ?? ""
  );
  const canAssignSelected = Boolean(selectedLeadId || selectedRetellCallId);

  useEffect(() => {
    if (!selected) return;
    setCaseDetails({
      email: getCallEmail(selected),
      address: getCallAddress(selected),
      city: getCallCity(selected),
      stateProvince: getCallState(selected),
      location: getCallLocation(selected),
      caseType: getCallCaseType(selected),
      caseNotes: getCallCaseNotes(selected),
    });
    setExtraFields(selected?.extraFields ?? []);
  }, [selected]);

  useEffect(() => {
    if (!selected || !isManual || !intake) return;

    const fallbackCity = firstText(manualIntakeData?.city, manualIntakeData?.residenceCity);
    const fallbackState = firstText(
      manualIntakeData?.stateProvince,
      manualIntakeData?.state,
      manualIntakeData?.residenceState
    );
    const fallbackLocation = firstText(
      manualIntakeData?.location,
      manualIntakeData?.ubicacion,
      [fallbackCity, fallbackState].filter(Boolean).join(", ")
    );
    const fallbackEmail = firstText(manualIntakeData?.email, manualIntakeData?.correo);
    const fallbackAddress = firstText(manualIntakeData?.address, manualIntakeData?.direccion);

    if (
      !getCallLocation(selected) &&
      (fallbackCity || fallbackState || fallbackLocation || fallbackEmail || fallbackAddress)
    ) {
      setSelected((prev: any) => ({
        ...(prev ?? {}),
        city: prev?.city || fallbackCity || "",
        stateProvince: prev?.stateProvince || fallbackState || "",
        location: prev?.location || fallbackLocation || "",
        email: prev?.email || fallbackEmail || "",
        address: prev?.address || fallbackAddress || "",
      }));
    }
  }, [intake, isManual, manualIntakeData, selected]);

  const attorneyScores = useMemo(() => {
    const scores = new Map<string, number>();
    if (!selected) return scores;

    const callCase = norm(getCallCaseType(selected));
    const callCity = norm(getCallCity(selected));
    const callState = norm(getCallState(selected));
    const callLocation = norm(getCallLocation(selected));
    const hasLocation = Boolean(callCity || callState || callLocation);

    (attorneys ?? []).forEach((a) => {
      const attorneyCity = norm(a.city);
      const attorneyState = norm(a.stateProvince ?? a.state);
      const attorneyLocation = `${attorneyCity} ${attorneyState}`.trim();
      const specs = Array.isArray(a.specialties) ? a.specialties.join(" ") : "";
      const specMatch = callCase && norm(specs).includes(callCase) ? 2 : 0;

      const cityExact = !!callCity && attorneyCity === callCity;
      const cityPartial = !!callCity && attorneyCity.includes(callCity);
      const stateExact = !!callState && attorneyState === callState;
      const statePartial = !!callState && attorneyState.includes(callState);
      const locationIncludes =
        !!callLocation && attorneyLocation.includes(callLocation);
      const locationScore = hasLocation
        ? cityExact || stateExact
          ? 12
          : cityPartial || statePartial || locationIncludes
            ? 10
            : 0
        : 0;

      scores.set(String(a.id), locationScore + specMatch);
    });

    return scores;
  }, [attorneys, selected]);

  const bestAttorneyIds = useMemo(() => {
    const max = Math.max(0, ...Array.from(attorneyScores.values()));
    const set = new Set<string>();
    attorneyScores.forEach((score, id) => {
      if (score === max && max > 0) set.add(id);
    });
    return set;
  }, [attorneyScores]);

  const rankedAttorneys = useMemo(() => {
    return [...(attorneys ?? [])].sort((a, b) => {
      const scoreA = attorneyScores.get(String(a.id)) ?? 0;
      const scoreB = attorneyScores.get(String(b.id)) ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return String(a.name ?? "").localeCompare(String(b.name ?? ""));
    });
  }, [attorneys, attorneyScores]);

  const assignmentPreview = useMemo(() => {
    if (!selected || !attorneyToAssign) return null;
    return {
      attorneyName: String(attorneyToAssign?.name ?? "Abogado"),
      attorneyEmail: String(attorneyToAssign?.email ?? "sin correo"),
      leadName: String(selected?.leadName ?? "Lead"),
      leadPhone: String(getCallPhoneNumber(selected) || "N/A"),
      location: getCallLocationLabel(selected),
      caseType: String(getCallCaseType(selected) || "General"),
      urgency: String(selected?.urgency ?? "Media"),
      summary: String(getCallSummary(selected) || "Sin resumen"),
    };
  }, [selected, attorneyToAssign]);

  const sendToAcceptedAttorney = async (call: any) => {
    const retellCallId = getRetellCallId(call);
    if (!retellCallId) {
      toast({
        title: "No se puede enviar este caso",
        description: "No se encontro callId para esta llamada.",
        className: "border-amber-200 bg-amber-50 text-amber-900",
      });
      return;
    }
    try {
      setSendingToAttorneyCallId(retellCallId);
      const r = await fetch(
        withApiBase(`/api/call-logs/${encodeURIComponent(retellCallId)}/send-to-attorney`),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      toast({
        title: "Caso enviado al abogado",
        description: `Destino: ${String(data?.to ?? "sin correo")}`,
        className: "border-emerald-200 bg-emerald-50 text-emerald-900",
      });
      await refetchCallLogs();
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Error enviando al abogado",
        description: getErrorMessage(e, "No se pudo enviar el caso al abogado"),
      });
    } finally {
      setSendingToAttorneyCallId(null);
    }
  };

  const saveCaseDetails = async () => {
    if (!selectedRetellCallId) return;
    try {
      setSavingCaseDetails(true);
      const payload = {
        email: caseDetails.email.trim(),
        address: caseDetails.address.trim(),
        city: caseDetails.city.trim(),
        stateProvince: caseDetails.stateProvince.trim(),
        location: caseDetails.location.trim(),
        caseType: caseDetails.caseType.trim(),
        caseNotes: caseDetails.caseNotes.trim(),
        extraFields,
      };

      const response = await fetch(
        withApiBase(`/api/call-logs/${encodeURIComponent(selectedRetellCallId)}/details`),
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!response.ok) throw new Error(await response.text());
      const updated = await response.json();
      setSelected((prev: any) => ({ ...(prev ?? {}), ...(updated ?? {}), ...payload }));
      await refetchCallLogs();
      toast({
        title: "Datos actualizados",
        description: "La informacion del caso se guardo correctamente.",
        className: "border-emerald-200 bg-emerald-50 text-emerald-900",
      });
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Error guardando datos",
        description: getErrorMessage(e, "No se pudo guardar la informacion del caso"),
      });
    } finally {
      setSavingCaseDetails(false);
    }
  };


  return (
    <div className="min-h-screen bg-background">
      <Sidebar />

      <div className="md:pl-64">
        <div className="p-8 space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <h1 className="text-3xl font-bold tracking-tight">Call Logs</h1>
              <p className="text-muted-foreground">
                Historial de llamadas con resumen, analisis y transcripcion
              </p>
            </div>
          </div>

          {/* Filters */}
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
                list="us-cities"
                type="text"
                placeholder="Escribe una ciudad..."
                value={cityText}
                onChange={(e) => setCityText(e.target.value)}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />

              <datalist id="us-cities">
                {US_CITIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-gray-700">Tipo de caso</label>

              <input
                list="case-types"
                type="text"
                placeholder="Escribe un tipo de caso..."
                value={caseTypeText}
                onChange={(e) => setCaseTypeText(e.target.value)}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />

              <datalist id="case-types">
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
                Llamadas
              </CardTitle>
            </CardHeader>

            <CardContent className="pt-0">
              {isLoading && <div className="text-muted-foreground">Cargando...</div>}

              {error && (
                <div className="text-destructive">
                  Error cargando call logs: {(error as any)?.message}
                </div>
              )}

              {!isLoading && !error && filteredLogs.length === 0 && (
                <div className="text-muted-foreground">
                  No hay llamadas que coincidan con los filtros.
                </div>
              )}

              <div className="flex flex-col gap-6">
                <div className="space-y-4 rounded-xl border border-border/60 p-4">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setOpenCompleteSection((v) => !v)}
                      className="inline-flex items-center gap-2 text-sm font-semibold text-green-700 dark:text-green-300"
                    >
                      {openCompleteSection ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      Llamadas completas
                    </button>
                    <span className="inline-flex min-w-9 items-center justify-center rounded-full bg-muted px-3 py-1 text-lg font-bold text-foreground">
                      {completeLogsAll.length}
                    </span>
                  </div>

                  {openCompleteSection && (
                    <>
                      {completeLogsAll.length === 0 && (
                        <div className="rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                          No hay llamadas completas.
                        </div>
                      )}

                      {completeLogs.map((l: any, idx: number) => (
                        <CallCard
                          key={l.id}
                          call={l}
                          idx={idx}
                          toneOffset={(completePage - 1) * ITEMS_PER_PAGE}
                          onView={() => {
                            setSelected(l);
                            setOpen(true);
                          }}
                          onAssign={
                            String(l?.status ?? "").toLowerCase() === "asignada"
                              ? undefined
                              : () => {
                                  setSelected(l);
                                  setAssignOpen(true);
                                }
                          }
                          onSendToAttorney={
                            isReadyToSendToAttorney(l)
                              ? () => void sendToAcceptedAttorney(l)
                              : undefined
                          }
                          sendingToAttorney={
                            String(sendingToAttorneyCallId ?? "") === getRetellCallId(l)
                          }
                        />
                      ))}

                      {completeLogsAll.length > 0 && (
                        <div className="flex items-center justify-end gap-3 pt-1">
                          <button
                            type="button"
                            onClick={() => setCompletePage((p) => Math.max(1, p - 1))}
                            disabled={completePage <= 1}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Anterior
                          </button>
                          <span className="text-xs text-muted-foreground">
                            Pagina {completePage} de {completeTotalPages}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setCompletePage((p) => Math.min(completeTotalPages, p + 1))
                            }
                            disabled={completePage >= completeTotalPages}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Siguiente
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="space-y-4 rounded-xl border border-border/60 p-4">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setOpenIncompleteSection((v) => !v)}
                      className="inline-flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300"
                    >
                      {openIncompleteSection ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      Llamadas incompletas / cortadas
                    </button>
                    <span className="inline-flex min-w-9 items-center justify-center rounded-full bg-muted px-3 py-1 text-lg font-bold text-foreground">
                      {incompleteLogsAll.length}
                    </span>
                  </div>

                  {openIncompleteSection && (
                    <>
                      {incompleteLogsAll.length === 0 && (
                        <div className="rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                          No hay llamadas incompletas.
                        </div>
                      )}

                      {incompleteLogs.map((l: any, idx: number) => (
                        <CallCard
                          key={l.id}
                          call={l}
                          idx={idx}
                          toneOffset={(incompletePage - 1) * ITEMS_PER_PAGE}
                          onView={() => {
                            setSelected(l);
                            setOpen(true);
                          }}
                          onAssign={
                            String(l?.status ?? "").toLowerCase() === "asignada"
                              ? undefined
                              : () => {
                                  setSelected(l);
                                  setAssignOpen(true);
                                }
                          }
                          onSendToAttorney={
                            isReadyToSendToAttorney(l)
                              ? () => void sendToAcceptedAttorney(l)
                              : undefined
                          }
                          sendingToAttorney={
                            String(sendingToAttorneyCallId ?? "") === getRetellCallId(l)
                          }
                        />
                      ))}

                      {incompleteLogsAll.length > 0 && (
                        <div className="flex items-center justify-end gap-3 pt-1">
                          <button
                            type="button"
                            onClick={() => setIncompletePage((p) => Math.max(1, p - 1))}
                            disabled={incompletePage <= 1}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Anterior
                          </button>
                          <span className="text-xs text-muted-foreground">
                            Pagina {incompletePage} de {incompleteTotalPages}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setIncompletePage((p) => Math.min(incompleteTotalPages, p + 1))
                            }
                            disabled={incompletePage >= incompleteTotalPages}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Siguiente
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="space-y-4 rounded-xl border border-border/60 p-4">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setOpenManualSection((v) => !v)}
                      className="inline-flex items-center gap-2 text-sm font-semibold text-blue-700 dark:text-blue-300"
                    >
                      {openManualSection ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      Casos manuales
                    </button>
                    <span className="inline-flex min-w-9 items-center justify-center rounded-full bg-muted px-3 py-1 text-lg font-bold text-foreground">
                      {manualLogsAll.length}
                    </span>
                  </div>

                  {openManualSection && (
                    <>
                      {manualLogsAll.length === 0 && (
                        <div className="rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                          No hay casos manuales.
                        </div>
                      )}

                      {manualLogs.map((l: any, idx: number) => (
                        <CallCard
                          key={l.id}
                          call={l}
                          idx={idx}
                          toneOffset={(manualPage - 1) * ITEMS_PER_PAGE}
                          onView={() => {
                            setSelected(l);
                            setOpen(true);
                          }}
                          onAssign={
                            String(l?.status ?? "").toLowerCase() === "asignada"
                              ? undefined
                              : () => {
                                  setSelected(l);
                                  setAssignOpen(true);
                                }
                          }
                          onSendToAttorney={
                            isReadyToSendToAttorney(l)
                              ? () => void sendToAcceptedAttorney(l)
                              : undefined
                          }
                          sendingToAttorney={
                            String(sendingToAttorneyCallId ?? "") === getRetellCallId(l)
                          }
                        />
                      ))}

                      {manualLogsAll.length > 0 && (
                        <div className="flex items-center justify-end gap-3 pt-1">
                          <button
                            type="button"
                            onClick={() => setManualPage((p) => Math.max(1, p - 1))}
                            disabled={manualPage <= 1}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Anterior
                          </button>
                          <span className="text-xs text-muted-foreground">
                            Pagina {manualPage} de {manualTotalPages}
                          </span>
                          <button
                            type="button"
                            onClick={() => setManualPage((p) => Math.min(manualTotalPages, p + 1))}
                            disabled={manualPage >= manualTotalPages}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Siguiente
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* MODAL DETALLE */}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) return;

          setSelected(null);

          // Si venia de una pantalla, volver a esa
          if (fromUrl) {
            setLocation(fromUrl);
            return;
          }

          // Si no hay from, quedarse en /calls limpiando query params
          clearCallQueryParams();


        }}
      >
        <DialogContent className="max-w-4xl p-0">
          <div className="flex max-h-[85vh] flex-col">
            <div className="border-b px-6 py-4">
              <DialogHeader>
                <DialogTitle className="text-xl font-semibold">Detalle de llamada</DialogTitle>
              </DialogHeader>

              {selected && (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                  <StatusBadge
                    status={selected.status ?? "ended"}
                    assignmentStatus={selected.assignmentStatus}
                  />

                  <span className="flex items-center gap-1">
                    <Clock className="h-4 w-4 opacity-60" />
                    {formatDuration(selected.duration)}
                  </span>

                  {selected.phoneNumber && (
                    <span className="flex items-center gap-1">
                      <Phone className="h-4 w-4 opacity-60" />
                      {selected.phoneNumber}
                    </span>
                  )}

                  <span className="flex items-center gap-1">
                    <MapPin className="h-4 w-4 opacity-60" />
                    {getCallLocationLabel(selected)}
                  </span>

                  {selected.leadName && (
                    <span className="font-medium text-foreground">{selected.leadName}</span>
                  )}
                </div>
              )}
            </div>


            <div className="flex-1 overflow-y-auto px-6 py-4">
              {!selected ? (
                <div className="text-muted-foreground">
                  Selecciona una llamada.
                </div>
              ) : isManual ? (
                <Card className="rounded-2xl border-border/60 shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-base">
                      Formulario del caso manual
                    </CardTitle>
                  </CardHeader>

                  <CardContent className="space-y-3 text-sm">
                    {intake && (
                      <div className="rounded-xl border border-border/60 p-4 bg-muted/10 space-y-4">
                        <div className="text-sm font-semibold">Vista completa del formulario</div>

                        <div>
                          <div className="text-xs font-semibold text-muted-foreground mb-2">
                            Informacion del cliente
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
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
                          <div className="text-xs font-semibold text-muted-foreground mb-2">
                            Datos del caso
                          </div>
                          {manualCaseEntries.length === 0 ? (
                            <div className="text-sm text-muted-foreground">
                              No hay datos adicionales en este formulario.
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
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
                    )}

                    {!intake && (
                      <div className="text-muted-foreground">
                        Cargando informacion del formulario...
                      </div>
                    )}

                    {false && intake && (
                      <div className="space-y-6">

                        {/* INFORMACION DEL CLIENTE */}
                        <div className="rounded-xl border border-border/60 p-4 bg-muted/20">
                          <div className="text-sm font-semibold mb-3">
                            Informacion del cliente
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                            <Field label="Nombre" value={intake?.data?.name} />
                            <Field label="Telefono" value={intake?.data?.phone} />
                          </div>
                        </div>

                        {/* DETALLES DEL CASO */}
                        <div className="rounded-xl border border-border/60 p-4 bg-muted/20">
                          <div className="text-sm font-semibold mb-3">
                            Detalles del caso
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                            <Field label="Incident Date" value={intake?.data?.incidentDate} />
                            <Field label="Injuries Brief" value={intake?.data?.injuriesBrief} />
                            <BooleanField label="Medical Treatment" value={intake?.data?.medicalTreatment} />
                            <BooleanField label="Police Report" value={intake?.data?.policeReport} />
                          </div>
                        </div>

                        {/* NARRATIVA */}
                        <div className="rounded-xl border border-border/60 p-4 bg-muted/20">
                          <div className="text-sm font-semibold mb-3">
                            Narrativa
                          </div>

                          <div className="text-sm whitespace-pre-wrap">
                            {intake?.data?.narrative || "-"}
                          </div>
                        </div>

                      </div>
                    )}


                  </CardContent>
                </Card>
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
                    <TabsTrigger
                      value="audio"
                      className="rounded-lg"
                      disabled={!getRecordingUrl(selected)}
                    >
                      Audio
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="resumen" className="mt-4 space-y-4">
                    <Card className="rounded-2xl border-border/60 shadow-sm">
                      <CardHeader>
                        <CardTitle className="text-base">Resumen</CardTitle>
                      </CardHeader>
                      <CardContent className="text-sm text-foreground/80 leading-relaxed">
                        {getCallSummary(selected) || "Sin resumen (aun)."}
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
                            navigator.clipboard.writeText(getCallTranscript(selected));
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          }}
                          disabled={!getCallTranscript(selected)}
                          className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Copy className="h-4 w-4" />
                          {copied ? "Copiado" : "Copiar"}
                        </button>
                      </CardHeader>

                      <CardContent>
                        <div className="rounded-2xl border border-border/60 bg-muted/30 p-4 text-sm whitespace-pre-wrap leading-relaxed">
                          {getCallTranscript(selected) || "Sin transcripcion (aun)."}
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

                        <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                          <div className="space-y-3 text-sm">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                                <div className="text-xs text-muted-foreground">Sentimiento</div>
                                <div className="font-medium">
                                  {getAnalysisSentiment(selected)}
                                </div>
                              </div>

                              <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                                <div className="text-xs text-muted-foreground">Exitosa</div>
                                <div className="font-medium">
                                  {getAnalysisSuccessLabel(selected)}
                                </div>
                              </div>
                            </div>

                            <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                              <div className="text-xs text-muted-foreground mb-2">Resumen IA</div>
                              <div className="leading-relaxed text-foreground/80">
                                {getCallSummary(selected) || "-"}
                              </div>
                            </div>

                            <div className="rounded-2xl border border-border/60 bg-background p-4 space-y-6">

                              <div className="flex items-center justify-between">
                                <div className="text-sm font-semibold">
                                  Datos basicos del caso
                                </div>

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
                                      await saveCaseDetails();
                                      setIsEditingBasic(false);
                                    }}
                                    className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg"
                                  >
                                    Guardar
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
                                      <label className="text-xs text-muted-foreground">
                                        Correo
                                      </label>
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
                                      <label className="text-xs text-muted-foreground">
                                        Direccion
                                      </label>
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
                                    <label className="text-xs text-muted-foreground">
                                      Notas importantes del caso
                                    </label>
                                    <textarea
                                      value={caseDetails.caseNotes}
                                      onChange={(e) =>
                                        setCaseDetails((prev) => ({
                                          ...prev,
                                          caseNotes: e.target.value,
                                        }))
                                      }
                                      className="w-full rounded-md border border-border px-3 py-2 text-sm min-h-[100px]"
                                      placeholder="Detalles importantes para seguimiento..."
                                    />
                                  </div>
                                </>
                              )}

                            </div>
                          </div>
                        </div>
                        <div className="rounded-2xl border border-dashed border-border/70 p-4 space-y-4">

                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold">
                              Informacion adicional
                            </div>

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
                                  await saveCaseDetails();
                                  setIsEditingExtra(false);
                                }}
                                className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg"
                              >
                                Guardar
                              </button>
                            )}
                          </div>

                          {!isEditingExtra ? (
                            <div className="space-y-3 text-sm">
                              {extraFields.length === 0 && (
                                <div className="text-muted-foreground">
                                  No hay informacion adicional.
                                </div>
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
                                onClick={() =>
                                  setExtraFields((prev) => [...prev, { label: "", value: "" }])
                                }
                                className="text-xs bg-muted px-3 py-1.5 rounded-lg hover:bg-muted/70"
                              >
                                + Agregar campo
                              </button>
                            </>
                          )}

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
                        {getRecordingUrl(selected) ? (
                          <audio controls className="w-full">
                            <source src={getRecordingUrl(selected)} />
                          </audio>
                        ) : (
                          <div className="text-sm text-muted-foreground">No hay audio disponible.</div>
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>
                </Tabs>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL ASIGNAR ABOGADO (igual que antes) */}
      <Dialog
        open={assignOpen}
        onOpenChange={(next) => {
          setAssignOpen(next);
          if (!next) {
            setAttorneysError(null);
            setConfirmAssignOpen(false);
            setAttorneyToAssign(null);
            setAssignmentNotes("");
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Asignar abogado</DialogTitle>
          </DialogHeader>

          {!canAssignSelected ? (
            <div className="text-sm text-destructive">
              No pude detectar callId o leadId de esta llamada para asignar abogado.
            </div>
          ) : (
            <>
              {selectedLeadId ? (
                <div className="text-sm text-muted-foreground">
                  Lead ID: <span className="text-foreground font-medium">{String(selectedLeadId)}</span>
                </div>
              ) : null}

              {attorneysLoading && <div className="text-muted-foreground">Cargando...</div>}
              {attorneysError && <div className="text-destructive">Error: {attorneysError}</div>}

              {!attorneysLoading && !attorneysError && attorneys.length === 0 && (
                <div className="text-muted-foreground">No hay abogados registrados.</div>
              )}

              <div className="mt-2 max-h-[55vh] overflow-y-auto rounded-xl border border-border/60">
                {rankedAttorneys.map((attorney) => {
                  const isBest = bestAttorneyIds.has(String(attorney.id));
                  return (
                    <div
                      key={attorney.id}
                      className="flex items-start justify-between gap-4 p-4 border-b last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold truncate">{attorney.name}</div>
                          {isBest && (
                            <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                              Recomendado
                            </span>
                          )}
                        </div>

                        <div className="text-sm text-muted-foreground truncate">{attorney.email}</div>
                      </div>

                      <button
                        type="button"
                        disabled={assigning}
                        onClick={() => {
                          setAttorneyToAssign(attorney);
                          setConfirmAssignOpen(true);
                        }}
                        className="shrink-0 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
                      >
                        Revisar envio
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmAssignOpen}
        onOpenChange={(next) => {
          setConfirmAssignOpen(next);
          if (!next) {
            setAttorneyToAssign(null);
            setAssignmentNotes("");
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirmar datos a enviar al abogado</DialogTitle>
          </DialogHeader>

          {!selected || !attorneyToAssign ? (
            <div className="text-sm text-muted-foreground">
              Selecciona una llamada y un abogado para continuar.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-border/60 bg-muted/20 p-4 text-sm space-y-2">
                <div>
                  <span className="text-muted-foreground">Abogado:</span>{" "}
                  <span className="font-medium">{assignmentPreview?.attorneyName}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Correo:</span>{" "}
                  <span className="font-medium">{assignmentPreview?.attorneyEmail}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Lead:</span>{" "}
                  <span className="font-medium">{assignmentPreview?.leadName}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Telefono:</span>{" "}
                  <span className="font-medium">{assignmentPreview?.leadPhone}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Tipo de caso:</span>{" "}
                  <span className="font-medium">{assignmentPreview?.caseType}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Urgencia:</span>{" "}
                  <span className="font-medium">{assignmentPreview?.urgency}</span>
                </div>
                <div className="pt-1">
                  <span className="text-muted-foreground">Resumen:</span>
                  <div className="mt-1 text-foreground/80">
                    {assignmentPreview?.summary}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Notas adicionales para el correo</label>
                <textarea
                  value={assignmentNotes}
                  onChange={(e) => setAssignmentNotes(e.target.value)}
                  placeholder="Agrega instrucciones o contexto para el abogado..."
                  className="w-full rounded-md border border-border px-3 py-2 text-sm min-h-[96px]"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmAssignOpen(false)}
                  className="rounded-xl px-4 py-2 text-sm font-medium border border-border hover:bg-muted transition"
                >
                  Cancelar
                </button>

                <button
                  type="button"
                  disabled={assigning || !canAssignSelected || !attorneyToAssign}
                  onClick={async () => {
                    try {
                      setAssigning(true);
                      const leadIdForAssign = selectedLeadId ?? 0;
                      const r = await fetch(withApiBase(`/api/leads/${leadIdForAssign}/assign-attorney`), {
                        credentials: "include",
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          attorneyId: attorneyToAssign.id,
                          retellCallId: selectedRetellCallId || undefined,
                          assignmentNotes: assignmentNotes || undefined,
                        }),
                      });
                      if (!r.ok) throw new Error(await r.text());

                      setConfirmAssignOpen(false);
                      setAssignOpen(false);
                      setAttorneyToAssign(null);
                      setAssignmentNotes("");
                      await refetchCallLogs();
                      toast({
                        title: "Solicitud enviada",
                        description: "El caso fue enviado al abogado para su decision.",
                        className: "border-emerald-200 bg-emerald-50 text-emerald-900",
                      });
                    } catch (e: any) {
                      toast({
                        variant: "destructive",
                        title: "Error enviando solicitud",
                        description: getErrorMessage(
                          e,
                          "No se pudo enviar la solicitud al abogado"
                        ),
                      });
                    } finally {
                      setAssigning(false);
                    }
                  }}
                  className="rounded-xl px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {assigning ? "Enviando..." : "Confirmar y enviar"}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>

  );

}

