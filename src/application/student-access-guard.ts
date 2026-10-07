// #610 §2 / #831: identity and authorization are resolved by the Guard only.
export type StudentAccessResult =
  | { readonly status: "authenticated"; readonly studentId: string }
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden" };

export interface StudentAccessGuard {
  // Check the current Session, Student role, access/lifecycle and operation
  // permission for each request. #636 defines the D1 contract in detailed
  // design 02 §8; public activation remains a separate decision.
  authorize(request: Request): Promise<StudentAccessResult>;
}

// Server-only, same-request input to a future Transaction Adapter. The Write
// must recheck detailed design 02 §8.3 inside its batch; this is not a ticket.
export interface StudentSessionContext {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly studentId: string;
}

export type StudentSessionResolution =
  | { readonly status: "authenticated"; readonly context: StudentSessionContext }
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden" };

export class StudentAccessError extends Error {
  constructor(readonly code: "SERVICE_UNAVAILABLE" | "INTEGRITY_STATE_UNAVAILABLE") {
    super(code);
    this.name = "StudentAccessError";
  }
}
