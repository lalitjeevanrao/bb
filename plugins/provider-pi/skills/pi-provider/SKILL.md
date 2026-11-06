---
name: pi-provider
description: "Inspect BB Pi provider support for message editing and context compaction."
---

# Pi provider

Pi supports editing and rerunning eligible user messages and compacting idle or
errored threads through the core `bb thread edit-message` and `bb thread compact`
commands. Inspect the thread first and use live command help for arguments.
Provider confirmation determines whether the operation completed.

Use the target host's provider catalog for available models and execution options.

Trusted plugins can contribute `BB_PI_ADDITIONAL_EXTENSIONS` with
`bb.providers.experimental_contributeEnv("pi", ...)`, after staging extension
files on the exact session host through host RPC. See the provider README for
bounds and validation. This per-command JSON path array is not a global Pi
installation or inherited host setting. Missing/empty values remove optional
extensions at the next safe turn or session construction; active turns are not
interrupted. Catalog and fork utility processes do not load them. Invalid paths
are omitted with stderr diagnostics; trusted extension code must handle its own
optional startup failures. Existing environment first-plugin-wins rules apply.
