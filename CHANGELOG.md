# Changelog

## [0.2.0] - 2026-11-13

### Added

- Structured logs for permission checks, allowed and rejected outcomes, interruptions, and sticky circuit-breaker stops.
- Regression coverage for file results, saved-permission isolation, state-restore failures, and intervention logging.
- Real opencode v2.2.7 standalone end-to-end coverage for Signal A and circuit-breaker approval and rejection.

### Changed

- File attachment identity now uses the full URI and MIME type, ignoring the returned file name so renaming alone cannot reset repeat detection.
- Attachment changes participate in Signal B novelty: changed attachments count as new information, while unchanged or renamed attachments do not.
- New Always allow approvals are isolated between Signals A, B, C, and the circuit breaker. Legacy bare-resource approvals remain applied to Signal A.
- Permission-request interruptions are logged at debug level instead of being reported as rejections.

### Fixed

- Different file-only or mixed text-and-file results no longer collapse into an empty output and falsely trigger Signal A.
- File fingerprints remain distinct during volatile-token normalization and use bounded markers without sampling large URIs.
- Malformed non-string attachment metadata no longer throws during result accounting.
- State restoration retains fresh-state fallback for typed failures and defects, with readable warning logs.
- Permission failure logs no longer include free-form correction feedback; typed failures record only the error type.
