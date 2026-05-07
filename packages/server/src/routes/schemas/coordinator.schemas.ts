/**
 * Zod wire schemas for coordinator API endpoints (P4-A).
 *
 * Wire-vs-engine date split (mirrors `workflow.schemas.ts:97-113`):
 *   - The engine schemas in `@archon/workflows/schemas/coordinator` use
 *     `z.date()` for timestamp columns (Postgres returns Date, SQLite returns
 *     string).
 *   - At the HTTP wire layer, all timestamps are serialized to ISO strings by
 *     Hono's response writer. So we redefine date fields here as `z.string()`
 *     rather than re-using engine `coordinatorRunSchema.openapi(...)` directly.
 *
 * Schema validates SHAPE only. Cycle detection / dependency-graph validation
 * happens in the route handler — same split as `dagNodeSchema` vs
 * `validateDagStructure` (CLAUDE.md "Zod Schema Conventions").
 *
 * See: docs/adr/0001-multi-root-coordinator-model.md
 */
import { z } from '@hono/zod-openapi';
import {
  coordinatorRunStatusSchema as engineCoordinatorRunStatusSchema,
  coordinatorTaskStateSchema as engineCoordinatorTaskStateSchema,
  claimOutcomeSchema as engineClaimOutcomeSchema,
  evidenceSchema as engineEvidenceSchema,
} from '@archon/workflows/schemas/coordinator';

// =========================================================================
// Status / state / outcome enums (re-exported with .openapi names)
// =========================================================================

export const coordinatorRunStatusSchema =
  engineCoordinatorRunStatusSchema.openapi('CoordinatorRunStatus');

export const coordinatorTaskStateSchema =
  engineCoordinatorTaskStateSchema.openapi('CoordinatorTaskState');

export const claimOutcomeSchema = engineClaimOutcomeSchema.openapi('CoordinatorClaimOutcome');

/**
 * Evidence shape — same as the engine schema. All fields optional.
 * The schema constrains evidence SHAPE; specific fields are gated by the
 * P3-A "real-execution proof" wiring in a future slice.
 */
export const coordinatorEvidenceWireSchema = engineEvidenceSchema.openapi('CoordinatorEvidence');

// =========================================================================
// Wire-shape object schemas (date columns redefined as z.string())
// =========================================================================

/** A coordinator run record at the wire layer. */
export const coordinatorRunWireSchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    codebase_id: z.string(),
    parent_run_id: z.string().nullable(),
    name: z.string(),
    status: coordinatorRunStatusSchema,
    max_parallel_workers: z.number().int().positive(),
    metadata: z.record(z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
    completed_at: z.string().nullable(),
  })
  .openapi('CoordinatorRun');

/** A coordinator task record at the wire layer. */
export const coordinatorTaskWireSchema = z
  .object({
    id: z.string(),
    coordinator_run_id: z.string(),
    external_key: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    state: coordinatorTaskStateSchema,
    depends_on: z.array(z.string()),
    evidence: coordinatorEvidenceWireSchema,
    metadata: z.record(z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
  })
  .openapi('CoordinatorTask');

/** A coordinator-task claim record at the wire layer. */
export const coordinatorTaskClaimWireSchema = z
  .object({
    id: z.string(),
    task_id: z.string(),
    coordinator_run_id: z.string(),
    worker_run_id: z.string().nullable(),
    worker_label: z.string().nullable(),
    claimed_at: z.string(),
    lease_expires_at: z.string(),
    released_at: z.string().nullable(),
    outcome: claimOutcomeSchema.nullable(),
    metadata: z.record(z.unknown()),
  })
  .openapi('CoordinatorTaskClaim');

// =========================================================================
// Request bodies
// =========================================================================

/** POST /api/coordinators request body. */
export const createCoordinatorRunBodySchema = z
  .object({
    conversation_id: z.string(),
    codebase_id: z.string(),
    name: z.string().min(1).max(255),
    max_parallel_workers: z.number().int().positive().max(50).optional(),
    parent_run_id: z.string().optional(),
  })
  .openapi('CreateCoordinatorRunBody');

/** POST /api/coordinators/{id}/tasks request body. */
export const createCoordinatorTaskBodySchema = z
  .object({
    external_key: z.string().min(1).max(255),
    title: z.string().min(1),
    body: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
  })
  .openapi('CreateCoordinatorTaskBody');

/**
 * PATCH /api/coordinators/{runId}/tasks/{taskId} request body.
 * Either `state` (transition) or `evidence` (merge) — or both.
 */
export const updateCoordinatorTaskStateBodySchema = z
  .object({
    state: coordinatorTaskStateSchema.optional(),
    evidence: coordinatorEvidenceWireSchema.optional(),
  })
  .openapi('UpdateCoordinatorTaskStateBody');

/** POST /api/coordinators/{runId}/tasks/{taskId}/claim request body. */
export const claimCoordinatorTaskBodySchema = z
  .object({
    worker_run_id: z.string().optional(),
    worker_label: z.string().optional(),
    lease_seconds: z.number().int().positive().max(86400).default(900),
  })
  .openapi('ClaimCoordinatorTaskBody');

/** POST /api/coordinators/claims/{claimId}/release request body. */
export const releaseCoordinatorClaimBodySchema = z
  .object({
    outcome: claimOutcomeSchema,
    evidence: coordinatorEvidenceWireSchema.optional(),
  })
  .openapi('ReleaseCoordinatorClaimBody');

/** POST /api/coordinators/claims/{claimId}/heartbeat request body. */
export const heartbeatClaimBodySchema = z
  .object({
    lease_seconds: z.number().int().positive().max(86400).default(900),
  })
  .openapi('HeartbeatCoordinatorClaimBody');

// =========================================================================
// Response shapes
// =========================================================================

/** GET /api/coordinators response. */
export const coordinatorRunListResponseSchema = z
  .object({ runs: z.array(coordinatorRunWireSchema) })
  .openapi('CoordinatorRunListResponse');

/** GET /api/coordinators/{id} response — includes tasks and active claims. */
export const coordinatorRunDetailResponseSchema = z
  .object({
    run: coordinatorRunWireSchema,
    tasks: z.array(coordinatorTaskWireSchema),
    active_claims: z.array(coordinatorTaskClaimWireSchema),
  })
  .openapi('CoordinatorRunDetailResponse');

/** GET /api/coordinators/{id}/ready-tasks response. */
export const coordinatorReadyTasksResponseSchema = z
  .object({ tasks: z.array(coordinatorTaskWireSchema) })
  .openapi('CoordinatorReadyTasksResponse');

/**
 * POST /api/coordinators/{runId}/tasks/{taskId}/claim response.
 *
 * IMPORTANT: when a task is already actively claimed, the response is
 * `200 { claim: null }` — NOT a `409 Conflict`. Workers treat null as
 * "someone else got this; ask for the next ready task."
 */
export const coordinatorClaimResponseSchema = z
  .object({ claim: coordinatorTaskClaimWireSchema.nullable() })
  .openapi('CoordinatorClaimResponse');

/** Single-coordinator-run response wrapper (POST /api/coordinators, etc.). */
export const coordinatorRunResponseSchema = z
  .object({ run: coordinatorRunWireSchema })
  .openapi('CoordinatorRunResponse');

/** Single-task response wrapper (POST/PATCH on tasks). */
export const coordinatorTaskResponseSchema = z
  .object({ task: coordinatorTaskWireSchema })
  .openapi('CoordinatorTaskResponse');

/** Release-claim response — returns the released claim. */
export const coordinatorReleaseClaimResponseSchema = z
  .object({ claim: coordinatorTaskClaimWireSchema })
  .openapi('CoordinatorReleaseClaimResponse');

/** Heartbeat response — boolean indicates whether the lease was extended. */
export const coordinatorHeartbeatResponseSchema = z
  .object({ extended: z.boolean() })
  .openapi('CoordinatorHeartbeatResponse');
