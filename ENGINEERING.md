# ENGINEERING.md — Engineering Principles

This document is **normative** for every contributor to this repository — human or AI.
Where it says **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**, those words
carry the meanings given in RFC 2119. When in doubt, the stricter reading wins.

These principles exist so that a human reviewer and an AI contributor share the same
boundaries, the same definition of done, and the same engineering discipline. They are the
rules of the road; [ARCHITECTURE.md](ARCHITECTURE.md) is the map.

## 1. Domain purity

- **MUST NOT** let an external provider's API DTO (request/response shape, field names,
  error codes) become the internal search domain model. The domain model is
  provider-neutral; provider shapes live only inside the provider adapter.
- **MUST** keep the provider adapter the *only* place that knows about a specific
  provider's wire format. If a Google field name appears anywhere outside the adapter,
  that is a boundary violation.
- **SHOULD** treat the DSH web seam types (`WebSearchRequest` / `WebSearchResult` /
  `WebSearchSource`) as the stable contract the adapter implements, and keep the adapter
  thin around them.

## 2. Facts over heuristics; no silent `unknown → false`

- **MUST** prefer explicit, verifiable facts over inferred heuristics when deciding
  behavior.
- **MUST NOT** silently convert an *unknown* or *absent* value into `false` (or any other
  concrete value) when the truth is "we don't know." Distinguish *absent*, *false*, and
  *unknown*.
- **SHOULD** surface uncertainty explicitly (e.g. an optional field left `undefined`, or a
  structured error) rather than guessing.

## 3. Smallest useful release

- **SHOULD** prefer the smallest change that makes the next acceptance criterion true.
- **MUST NOT** add speculative generality — extra providers, extra capabilities, extra
  configuration knobs — that the current issue does not require.
- **SHOULD** leave a clean seam so a later issue can grow the surface without rework, but
  do not build the growth now.

## 4. Credentials and secrets

- **MUST NOT** commit credentials, API keys, or tokens to the repository.
- **MUST NOT** store credentials in ordinary settings files, config defaults, or example
  values that get checked in.
- **MUST** read provider credentials at runtime from **environment variables** (or an
  equivalent out-of-band source), and document the variable names without their values.
- **SHOULD** fail with a clear, structured error when a required credential is missing,
  rather than proceeding with a default or a guess.

## 5. Verification evidence for claims

- **MUST** attach verification evidence to any claim of compatibility, correctness, or
  "it works" (a test, a recorded request/response, a reproducible command, or a link to a
  verified source).
- **MUST NOT** assert that the plugin is compatible with a specific DSH version, Google
  endpoint, or API behavior without evidence.
- **SHOULD** keep the evidence reproducible: the command, the input, and the observed
  output.

## 6. Provider / product choice behind the adapter boundary

- **MUST** keep the choice of concrete Google search API/product an **adapter-layer**
  decision. The Harness-facing search domain contract (the seam types) must not encode a
  specific Google endpoint, parameter set, or wire shape.
- **MUST NOT** require changes to the Harness-facing search domain contract in order to
  migrate to, or add, a different Google search API/product. Such a change is a new or
  re-pointed adapter behind the same `WebSearchProvider` interface.
- **SHOULD** keep the Harness-facing search contract stable across future Google API
  variants when possible; where a variant cannot be expressed without a domain change,
  that trade-off must be called out explicitly in the issue, not done silently.
- **MUST NOT** implement multiple Google APIs or a Google-API abstraction layer in an
  issue that does not require it (see §3 — smallest useful release).

## 7. Error handling

- **MUST** propagate provider failures as **structured errors** with a machine-routable
  code, not as thrown strings or swallowed exceptions.
- **MUST NOT** hide a failure behind a success-shaped result.
- **SHOULD** distinguish *capability unavailable* (no usable provider / missing
  credential) from *request failed* (the provider was reached and returned an error).

## 8. Tests

- **MUST** add or update tests alongside behavior changes; a behavior change with no test
  is incomplete.
- **SHOULD** test the adapter's mapping logic (Google response → normalized result) with
  recorded fixtures, so tests do not depend on live network access.
- **MUST NOT** write tests that require live Google credentials to pass in CI.

## 9. Documentation

- **MUST** keep `README.md`, `ENGINEERING.md`, and `ARCHITECTURE.md` accurate when the
  contracts they describe change.
- **SHOULD** keep documentation short and normative; link to it instead of duplicating it.

## 10. Per-issue working protocol

This protocol is the standing, long-term memory of how work proceeds in this
repository. It is normative for every issue round — human or AI — and
supersedes any earlier instruction to batch several issues in one round.

- **MUST** read `README.md`, `ENGINEERING.md`, and `ARCHITECTURE.md` first, then
  read the current issue. The three documents are the context; the issue text is
  the task.
- **MUST** complete exactly **one** issue per round.
- **MUST NOT** start, scaffold, or partially do the next issue in the same round —
  no "while I'm at it" work beyond the current issue's scope.
- **MUST** report, at the end of the round: the changes made; the Acceptance
  comparison (each acceptance criterion met or not, with evidence); the test
  results; and any uncertain items.

Source (verbatim): "先读 README.md、ENGINEERING.md、ARCHITECTURE.md，再读当前 Issue；
只完成这一个 Issue；禁止顺手做下一个 Issue；结束时报告改动、Acceptance 对照、测试
结果和不确定项。"

## Definition of done (per issue)

An issue is complete only when:

1. Its stated acceptance criteria are each met.
2. The change follows the principles above (especially domain purity, credentials, and
   verification evidence).
3. Tests pass and the evidence for any compatibility/correctness claim is present.
4. The relevant contract documents are still accurate.
