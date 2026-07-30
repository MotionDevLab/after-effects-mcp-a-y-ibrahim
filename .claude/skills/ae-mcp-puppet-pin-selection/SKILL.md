---
name: ae-mcp-puppet-pin-selection
description: Use before building a propertyPath to address a specific Puppet pin (via set-effect-property or list-layer-effects) on an After Effects layer in this repo's MCP tools. Every pin on a layer shares the same matchName - selecting by matchName alone silently returns the wrong pin instead of erroring.
---

# Puppet pin selection for this repo's After Effects MCP tools

Animating an existing puppet-pinned layer (one where pins were already
placed by hand via AE's Puppet Pin tool - there's no scripting API to
create the mesh itself) works today through this fork's existing generic
effects tools: `list-layer-effects` to read, `set-effect-property` to
write. No dedicated puppet tool exists or is needed. Verified live
2026-07-30 against a real 6-pin Advanced Puppet mesh.

## The gotcha

Every pin's property group has the **same matchName**,
`"ADBE FreePin3 PosPin Atom"`, regardless of which pin it is. This
codebase's usual advice - "prefer matchName over display name for
reliability" (the norm for effects, e.g. `"ADBE Gaussian Blur 2"`) -
**does not apply to pin selection**. A `propertyPath` segment that matches
by matchName will resolve to whichever pin happens to be found first in
that group, not the one you meant - and this fails silently, not with an
error, exactly like the `compIndex` semantic mismatch documented in
`ae-mcp-compindex-safety`.

**The rule**: select a specific pin by its **display name**
(`"Puppet Pin 1"`, `"Puppet Pin 2"`, ...), as one segment of
`propertyPath`. Every other segment can safely use matchName since those
groups are singletons.

## Working example (verified live)

Reading all pins on layer 2 of "Comp 1":
```
list-layer-effects { compIndex: <comp>, layerIndex: <layer>, includeProperties: true, includeValues: true, maxDepth: 6 }
```
This returns the `Puppet` effect (matchName `"ADBE FreePin3"`) with each
pin nested under `Deform`, each carrying its own `Position` (2D point,
`canSetExpression: true`, `canVaryOverTime: true`), `Scale`, and
`Rotation` - already writable, unlike Layer Styles' hidden properties.

Writing (e.g. keyframing) a specific pin's Position:
```
set-effect-property {
  compIndex: <comp>, layerIndex: <layer>,
  effectMatchName: "ADBE FreePin3",
  propertyPath: [
    "ADBE FreePin3 ARAP Group",
    "ADBE FreePin3 Mesh Group",
    "ADBE FreePin3 Mesh Atom",
    "ADBE FreePin3 PosPins",
    "Puppet Pin 1",                      // <- display name, NOT matchName
    "ADBE FreePin3 PosPin Position"
  ],
  value: [x, y],
  timeInSeconds: <t>
}
```

## What's still not scriptable

Creating the mesh/pins from scratch (placing pins, triangulating) has no
ExtendScript API - that step still requires a human using the Puppet Pin
tool interactively in the AE UI. This skill only covers *animating* a mesh
that already exists.

Full investigation writeup, including why this differs from the blocked
Layer Styles case: `GAPS.md`, item "Puppet pin / mesh deformation."
