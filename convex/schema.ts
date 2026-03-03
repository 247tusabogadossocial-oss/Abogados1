import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({

  /* ============================= */
  /* COUNTERS (nextId helper)      */
  /* ============================= */

  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

  /* ============================= */
  /* USERS                         */
  /* ============================= */

  users: defineTable({
    id: v.string(),
    email: v.string(),
    name: v.string(),
    role: v.string(),
    passwordHash: v.string(),
    isActive: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_email", ["email"]),

  /* ============================= */
  /* ATTORNEYS                     */
  /* ============================= */

  attorneys: defineTable({
    id: v.string(),
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    city: v.optional(v.string()),
    stateProvince: v.optional(v.string()),
    notes: v.optional(v.string()),
    specialties: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_city", ["city"])
    .index("by_stateProvince", ["stateProvince"])
    .index("by_attorneyId", ["id"]),

  /* ============================= */
  /* LEADS (modelo principal)      */
  /* ============================= */

  leads: defineTable({
    id: v.number(),

    name: v.string(),
    phone: v.string(),

    email: v.optional(v.string()),
    city: v.optional(v.string()),
    age: v.optional(v.number()),

    practiceArea: v.optional(v.string()),
    source: v.optional(v.string()),

    caseType: v.optional(v.string()),
    urgency: v.optional(v.string()),

    status: v.string(),
    attorneyId: v.optional(v.string()),

    // Datos provenientes de IA
    retellCallId: v.optional(v.string()),
    retellAgentId: v.optional(v.string()),
    summary: v.optional(v.string()),
    transcript: v.optional(v.string()),

    lastContactedAt: v.optional(v.number()),

    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_retellCallId", ["retellCallId"])
    .index("by_practiceArea", ["practiceArea"])
    .index("by_attorneyId", ["attorneyId"]),

  /* ============================= */
  /* INTAKES (manual dynamic data) */
  /* ============================= */

  intakes: defineTable({
    leadId: v.number(),
    practiceArea: v.string(),
    version: v.optional(v.number()),
    data: v.any(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_leadId", ["leadId"])
    .index("by_practiceArea", ["practiceArea"])
    .index("by_lead_practice", ["leadId", "practiceArea"]),

  /* ============================= */
  /* CALL LOGS                     */
  /* ============================= */

  callLogs: defineTable({
    id: v.number(),

    leadId: v.optional(v.number()),

    // Para compatibilidad con Retell
    retellCallId: v.string(),

    agentId: v.optional(v.string()),
    phoneNumber: v.optional(v.string()),
    toNumber: v.optional(v.string()),

    status: v.string(),
    direction: v.optional(v.string()),
    sourceEvent: v.optional(v.string()),
    isPlaceholder: v.optional(v.boolean()),
    duration: v.optional(v.number()),
    recordingUrl: v.optional(v.string()),

    summary: v.optional(v.string()),
    transcript: v.optional(v.string()),
    sentiment: v.optional(v.string()),

    city: v.optional(v.string()),
    stateProvince: v.optional(v.string()),
    location: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.optional(v.string()),
    caseType: v.optional(v.string()),
    caseNotes: v.optional(v.string()),

    analysis: v.optional(v.any()),

    extraFields: v.optional(
      v.array(
        v.object({
          label: v.string(),
          value: v.string(),
        })
      )
    ),

    // Flujo de asignación
    pendingAttorneyId: v.optional(v.string()),
    assignmentStatus: v.optional(v.string()),
    assignmentNotes: v.optional(v.string()),
    assignmentRequestedAt: v.optional(v.number()),
    assignmentDecisionAt: v.optional(v.number()),
    assignmentDecisionByAttorneyId: v.optional(v.string()),
    assignmentDecisionNotes: v.optional(v.string()),
    assignmentDeliveredAt: v.optional(v.number()),
    assignmentDeliveredByUserId: v.optional(v.string()),
    newCallAlertSentAt: v.optional(v.number()),

    createdAt: v.number(),
  })
    .index("by_retellCallId", ["retellCallId"])
    .index("by_leadId", ["leadId"])
    .index("by_assignmentStatus", ["assignmentStatus"]),

});
