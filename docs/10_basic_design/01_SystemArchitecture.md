# 01. System Architecture

## 1. Purpose

This document defines the C4 Level 2 container architecture for the initial release. It translates the requirements baseline into deployable/runtime boundaries without defining detailed internal components.

## 2. Architecture decision

The initial release uses a **single Application Worker** as the application deployment unit.

Web UI, HTTP API, authentication/session endpoints, booking and cancellation processing, schedule/admin functions, notification orchestration, and scheduled job handlers are deployed together in the same Cloudflare Worker.

This is a deployment-boundary decision only. Internal source code remains separated by responsibility; component-level structure is deferred to detailed design (C4 Level 3).

The decision is recorded in `docs/adr/ADR-001-single-application-worker.md`.

## 3. C4 Level 2 containers

### 3.1 Application Worker

**Technology:** Cloudflare Workers

**Responsibilities:**

- Deliver the student and school-admin web application.
- Accept and validate HTTP requests.
- Execute authentication and session flows.
- Execute booking, cancellation, schedule, profile, and administrative use cases.
- Enforce authorization and business rules before state changes.
- Orchestrate outbound email requests and receive relevant provider callbacks.
- Run scheduled handlers such as reminders, cleanup, holiday-master refresh, and backup-related orchestration where applicable.
- Read and write authoritative business state in D1.

**Not separate containers in the initial release:**

- Frontend Worker
- API Worker
- Authentication Worker
- Batch / Scheduled Job Worker
- Notification Worker

### 3.2 Main Database

**Technology:** Cloudflare D1

**Responsibilities:**

- Store authoritative application business state.
- Store students, authentication linkage data needed by the application, sessions/tokens as designed, schedules/slots, reservations, classifications, notification state, holiday master, and audit information.
- Support consistency controls required to prevent double booking and silent state overwrite.

D1 schema and transaction/concurrency design are separate basic-design topics.

### 3.3 Backup Storage

**Technology:** Cloudflare R2

**Responsibilities:**

- Retain long-term backup artifacts required by the backup/retention requirements.
- Remain logically separate from the production transactional store.

Exact backup generation and restore mechanics are defined in the backup/recovery design.

## 4. External systems

### 4.1 Google Authentication

Provides Google-based user authentication. Google-specific integration is isolated from domain logic so that provider dependencies remain localized.

### 4.2 Resend

Provides outbound email delivery and relevant delivery/failure callbacks. Successful or failed delivery does not replace or roll back committed business state.

### 4.3 Cloudflare Turnstile

Provides bot-abuse mitigation for public authentication-related entry points such as Magic Link issuance.

## 5. Main interaction rules

1. Student and school-admin interactions enter through the Application Worker.
2. The Application Worker validates identity, authorization, request state, and business rules before changing D1.
3. Successfully committed D1 business state is authoritative; external-provider results do not silently reverse it.
4. Operations subject to concurrency rules must revalidate current state at commit time and must not silently overwrite a previously committed conflicting state.
5. Outbound external integrations are invoked only after or around business-state transitions in a way that preserves idempotency and internal-state authority.
6. Scheduled processing executes through handlers in the same Application Worker; it is not a separate deployment unit in the initial release.

## 6. Deployment and failure boundary

The Application Worker is one deployment and rollback unit. Therefore a Worker deployment can affect web requests, API requests, and scheduled handlers at the same time.

D1, R2, Google Authentication, Resend, and Turnstile remain separate platform/service boundaries and can fail independently. Their failure handling must follow the requirements for authoritative internal state, external retry, notification failure handling, and availability/recovery.

## 7. Related requirements and policies

- POL-001 Necessary minimum / low operational burden
- POL-002 Free-tier priority without weakening Must requirements
- POL-003 Separation of business state and external integration
- POL-007 Localization of external-provider dependencies
- POL-008 Committed-state priority during conflicts
- CON-001 Cloudflare platform
- CON-002 Email provider
- CON-003 Authentication
- CON-009 Backup mechanism independence

## 8. Diagram

PlantUML source: `docs/diagrams/plantuml/c4-container.puml`

Rendered SVG: `docs/diagrams/rendered/c4-container.svg` (generated automatically)
