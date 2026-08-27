# Basic design

Basic design documents live here. This phase uses C4 Level 2 (Container) as the primary architecture view.

## Documents

- `01_SystemArchitecture.md` — C4 Level 2 container architecture and deployment boundaries
- `02_DataModel.md` — conceptual/logical data model and data ownership/query principles
- `03_ScheduleModel.md` — monthly publication, concrete lesson-slot date/time, and slot availability model
- `04_ReservationModel.md` — reservation history, current slot occupancy, cancellation, and rebooking model

## Planned topics

- Continue data model: reservation classification/counting, remaining entities, and D1 physical details
- Reservation consistency / transaction design
- API overview
- Authentication and session design
- Schedule generation and change design, including disabled reasons and admin workflow
- Notifications and scheduled jobs
- Backup / recovery
- Deployment and environment design

Open design decisions from this phase are managed as GitHub Issues using the `OI-BD-xxx` identifier scheme. Final decisions are reflected back into these design documents or ADRs before the Issue is closed.
