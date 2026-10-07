// #610 §2 / #831: identity and authorization are resolved by the Guard only.
export type StudentAccessResult =
  | { readonly status: "authenticated"; readonly studentId: string }
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden" };

export interface StudentAccessGuard {
  // Check the current Session, Student role, access/lifecycle and operation
  // permission for each request. #636 defines the D1 contract in detailed
  // design 02 §8; production implementation/wiring remains a later task.
  authorize(request: Request): Promise<StudentAccessResult>;
}
