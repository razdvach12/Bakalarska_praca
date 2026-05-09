import { z } from "zod";

export const SnapshotPageMetaSchema = z.object({
  modalOpen: z.boolean().optional().default(false),
  cookieLikeOverlay: z.boolean().optional().default(false),
  dropdownOpen: z.boolean().optional().default(false),
  nearBottom: z.boolean().optional().default(false),
});

export const VisionNotesSchema = z.object({
  page: z
    .object({
      type: z.string().default("unknown"),
      heading: z.string().nullable().default(null),
    })
    .default({ type: "unknown", heading: null }),
  overlay: z
    .object({
      present: z.boolean().default(false),
      blocksInteraction: z.boolean().optional(),
      approxAreaPct: z.number().min(0).max(100).optional(),
      type: z.string().default("unknown"),
      acceptText: z.string().nullable().default(null),
      closeVisible: z.boolean().default(false),
    })
    .default({ present: false, type: "unknown", acceptText: null, closeVisible: false }),
  ui: z
    .object({
      cartIconVisible: z.boolean().default(false),
      hamburgerMenuVisible: z.boolean().default(false),
      hamburgerMenuOpen: z.boolean().default(false),
    })
    .default({ cartIconVisible: false, hamburgerMenuVisible: false, hamburgerMenuOpen: false }),
  error: z
    .object({
      present: z.boolean().default(false),
      text: z.string().nullable().default(null),
    })
    .default({ present: false, text: null }),
  hints: z.array(z.string()).max(6).default([]),
});

export const GoalSubtaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  doneWhen: z.string().min(1),
  dependsOn: z.array(z.string()).max(6).default([]),
});

export const PageKindSchema = z.enum([
  "login",
  "inventory",
  "product_detail",
  "cart",
  "checkout_info",
  "checkout_overview",
  "checkout_complete",
  "form",
  "unknown",
]);

export const FinalRequirementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text_visible"),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("text_absent"),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("url_contains"),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("page_kind_is"),
    pageKind: PageKindSchema,
  }),
  z.object({
    kind: z.literal("field_equals"),
    label: z.string().min(1),
    value: z.string().min(1),
  }),
  z.object({
    kind: z.literal("field_filled"),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("answer_visible"),
  }),
  z.object({
    kind: z.literal("answer_contains_email"),
  }),
  z.object({
    kind: z.literal("answer_contains_phone"),
  }),
  z.object({
    kind: z.literal("cart_contains_product"),
    product: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("cart_not_contains_product"),
    product: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("overlay_absent"),
  }),
  z.object({
    kind: z.literal("confirmation_visible"),
    text: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("login_form_absent"),
  }),
  z.object({
    kind: z.literal("error_absent"),
  }),
]);

export const GoalSpecSchema = z.object({
  goal: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).min(1).max(6),
  stopCondition: z.string().min(1),
  assumptions: z.array(z.string()).max(6).default([]),
  constraints: z.array(z.string()).max(6).default([]),
  finalRequirements: z.array(FinalRequirementSchema).max(12).default([]),
  subtasks: z.array(GoalSubtaskSchema).min(1).max(8).default([]),
});

export const CompletionCheckSchema = z.object({
  done: z.boolean(),
  reason: z.string().min(1),
  evidence: z.array(z.string().min(1)).max(6).default([]),
});

const DecisionBaseSchema = z.object({
  done: z.boolean(),
  reason: z.string(),
  activeSubtaskId: z.string().nullable().optional(),
  markSubtasksDone: z.array(z.string()).max(4).optional(),
  progressNote: z.string().optional(),
  needHelp: z.boolean().optional(),
  helpReason: z.string().optional(),
});

export const AgentActionSchema = z.object({
  action: z.enum(["type", "click", "clickByText", "wait", "scroll", "pressKey", "none"]),
  selector: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  reason: z.string().optional(),
  mayNavigate: z.boolean().optional(),
  expectedEffect: z.string().optional(),
  successSignal: z.string().optional(),
  failureSignal: z.string().optional(),
  fallbackHint: z.string().optional(),
});

export const AgentDecisionSingleSchema = DecisionBaseSchema.extend({
  action: z.enum(["type", "click", "clickByText", "wait", "scroll", "pressKey", "none"]),
  selector: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  mayNavigate: z.boolean().optional(),
  expectedEffect: z.string().optional(),
  successSignal: z.string().optional(),
  failureSignal: z.string().optional(),
  fallbackHint: z.string().optional(),
});

export const AgentDecisionBatchSchema = DecisionBaseSchema.extend({
  actions: z.array(AgentActionSchema).min(1).max(5),
});

export const AgentDecisionSchema = z.union([AgentDecisionBatchSchema, AgentDecisionSingleSchema]);

export type SnapshotPageMeta = z.infer<typeof SnapshotPageMetaSchema>;
export type VisionNotes = z.infer<typeof VisionNotesSchema>;
export type GoalSubtask = z.infer<typeof GoalSubtaskSchema>;
export type FinalRequirement = z.infer<typeof FinalRequirementSchema>;
export type GoalSpec = z.infer<typeof GoalSpecSchema>;
export type CompletionCheck = z.infer<typeof CompletionCheckSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
export type AgentDecisionSingle = z.infer<typeof AgentDecisionSingleSchema>;
export type AgentDecisionBatch = z.infer<typeof AgentDecisionBatchSchema>;

export type Tokens = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
};

export type InformationAnswerAssessment = {
  pageRelevant: boolean;
  answerVisible: boolean;
  answer: string;
  evidence: string[];
  missing: string[];
  confidence: "low" | "medium" | "high";
};

export type DeterministicFinalGate = {
  satisfied: boolean;
  finalRequirements: FinalRequirement[];
  fulfilled: string[];
  missing: string[];
  evidence: string[];
  answerAssessment: InformationAnswerAssessment | null;
};

export type EffectVerificationResult = {
  changed: boolean;
  hadExpectation: boolean;
  successMatched: boolean;
  failureMatched: boolean;
  expectationMissed: boolean;
  outcome: "confirmed" | "failed" | "unclear";
  reason: string;
};