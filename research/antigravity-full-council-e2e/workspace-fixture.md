# Council Workspace Fixture: Library Checkout System (Synthetic)

This file is the single authoritative workspace source for the
Antigravity full-Council end-to-end acceptance run. It is deterministic,
non-secret, and contains no real personal data.

## Three approaches described by the fixture

- Approach A (paper register): zero new tooling, works during power
  outages, but every checkout is written by hand and the weekly review
  takes a full librarian-hour.
- Approach B (shared spreadsheet): about one hour of setup, supports
  instant lookups, but only one librarian can edit it at a time without
  creating version conflicts.
- Approach C (small internal web app): about two working days of setup,
  records every checkout automatically, but requires a designated
  maintainer that the three-person staff does not currently have.

## Principal tradeoff stated by the fixture

The fixture states one explicit tradeoff: each step of automation reduces
manual recording effort but increases setup time and the need for an
ongoing maintainer.

## Recommendation question for the Council

Given only the facts above, which single approach should the three-person
library staff adopt first, and which tradeoff from this fixture most
directly justifies that choice?
