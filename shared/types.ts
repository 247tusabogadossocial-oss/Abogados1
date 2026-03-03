export interface Lead {
  id: number;
  name: string;
  phone: string;
  caseType?: string;
  urgency?: string;
  status: string;
  attorneyId?: string;
  retellCallId?: string;
  retellAgentId?: string;
  summary?: string;
  transcript?: string;
  lastContactedAt?: Date | null;
  createdAt: Date | null;
}

export type InsertLead = Omit<Lead, "id" | "createdAt" | "lastContactedAt">;

export type UpdateLeadRequest = Partial<InsertLead>;

export interface CallLog {
  id: number;
  leadId?: number;
  retellCallId: string;
  agentId?: string;
  phoneNumber?: string;
  status?: string;
  direction?: string;
  duration?: number;
  recordingUrl?: string;
  summary?: string;
  transcript?: string;
  sentiment?: string;
  city?: string;
  stateProvince?: string;
  location?: string;
  email?: string;
  address?: string;
  caseType?: string;
  caseNotes?: string;
  analysis?: any;
  pendingAttorneyId?: string;
  assignmentStatus?: string;
  assignmentNotes?: string;
  assignmentRequestedAt?: number;
  assignmentDecisionAt?: number;
  assignmentDecisionByAttorneyId?: string;
  assignmentDecisionNotes?: string;
  assignmentDeliveredAt?: number;
  assignmentDeliveredByUserId?: string;
  newCallAlertSentAt?: number;
  createdAt: Date | null;
}

export type InsertCallLog = Omit<CallLog, "id" | "createdAt">;

export interface Attorney {
  id: string;
  name: string;
  email: string;
  phone?: string;
  city?: string;
  stateProvince?: string;
  notes?: string;
  specialties: string[];
  createdAt: Date | null;
}

export type InsertAttorney = Omit<Attorney, "createdAt">;

export interface DashboardStats {
  totalLeads: number;
  qualifiedLeads: number;
  convertedLeads: number;
  avgResponseTimeMinutes: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "agent" | "abogado";
  isActive: number;
  createdAt: number;
  updatedAt: number;
}
