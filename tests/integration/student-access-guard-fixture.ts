import type { StudentAccessGuard, StudentAccessResult } from "../../src/application/student-access-guard";

// Test-only injection. Never reads a header, query, cookie or environment switch.
export class FakeStudentAccessGuard implements StudentAccessGuard {
  readonly requests: Request[] = [];
  constructor(private readonly result: StudentAccessResult, private readonly onAuthorize = () => {}) {}

  async authorize(request: Request): Promise<StudentAccessResult> {
    this.requests.push(request);
    this.onAuthorize();
    return this.result;
  }
}
