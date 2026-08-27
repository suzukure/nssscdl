# ADR-001: Single Application Worker for initial release

- Status: Accepted
- Date: 2026-08-27

## Context

The initial release targets a small private lesson reservation service. The platform constraint is Cloudflare Workers + D1 + R2. The basic design must decide whether the web UI, HTTP API, and scheduled processing are deployed as separate Workers or as one deployable Worker.

Separating these concerns into multiple Workers would add deployment units, bindings, inter-Worker communication, CI/CD paths, and operational failure modes. The requirements prioritize minimum operational burden and avoiding unnecessary complexity while preserving clear responsibility boundaries in the codebase.

## Decision

The initial release uses **one Application Worker** as the single application deployment unit.

The Application Worker contains the entry points for:

- Web UI / static asset delivery
- HTTP API
- Authentication and session handling
- Booking and cancellation use cases
- Schedule and school-admin operations
- Notification orchestration
- Scheduled job handlers

D1 remains the primary transactional data store, and R2 remains long-term backup storage. Google authentication, Resend, and Turnstile remain external services.

The Worker is a single deployment unit, but internal source code must remain separated by responsibility. This ADR does not define C4 Level 3 component boundaries; those are decided during detailed design.

## Rationale

- Aligns with POL-001 by minimizing operational and deployment complexity.
- Aligns with POL-002 by reducing unnecessary resource and maintenance overhead without weakening Must requirements.
- Keeps external-provider dependencies localized in accordance with POL-007.
- Does not change the requirement that committed internal business state is authoritative (POL-003) or the concurrency rules in POL-008.
- The current scale does not justify independent Web/API/Batch deployment units.

## Consequences

### Positive

- One application deployment and rollback target.
- No Worker-to-Worker network boundary for ordinary business operations.
- Simpler bindings, secrets, monitoring, and CI/CD.
- Scheduled processing can share the same domain/application logic as request-driven processing.

### Trade-offs

- A deployment affects web, API, and scheduled handlers together.
- Resource isolation between request processing and scheduled work is not provided by separate Workers.
- Internal modularity becomes important to prevent a monolithic code structure.

## Revisit conditions

Reconsider splitting Workers only if concrete operational evidence appears, such as materially different scaling, security/trust boundaries, deployment cadence, failure isolation needs, or platform limits. A hypothetical future need alone is not sufficient.

## Related requirements

- POL-001
- POL-002
- POL-003
- POL-007
- POL-008
- CON-001
