// Pure, side-effect-free helpers for authoring After Effects bezier paths
// (shape-layer paths and mask paths - AE uses the same `Shape` object for both).
//
// Everything here runs server-side in Node, NOT in ExtendScript. Two reasons:
// the bridge handler stays a single code path (build a Shape, write it) instead
// of one branch per generator, and this is the only layer of the shape-path work
// that automated tests can reach at all - `tests/` covers `src/lib/*.ts` and
// nothing else.
//
// The validation here is not defensive boilerplate. Verified live against After
// Effects 26.0x67 (see manual-tests/shape-path-probe.mjs, probe P4): AE does NOT
// reject a Shape whose inTangents/outTangents arrays are shorter than its
// vertices array. It silently coerces, zeroing the tangents it was not given, so
// a caller's off-by-one becomes a wrong-looking curve with no error anywhere.
// Length agreement therefore has to be enforced before the data ever reaches AE.

/** A 2D point or tangent handle. */
export type Vec2 = [number, number];

/** Path input as a caller supplies it: tangents and `closed` are optional. */
export interface PathData {
  vertices: Vec2[];
  inTangents?: Vec2[];
  outTangents?: Vec2[];
  closed?: boolean;
}

/** Path with every field resolved, ready to hand to `new Shape()` bridge-side. */
export interface NormalizedPath {
  vertices: Vec2[];
  inTangents: Vec2[];
  outTangents: Vec2[];
  closed: boolean;
}

/**
 * The circle-approximation constant: the fraction of a quarter-arc's radius that
 * a cubic bezier handle must span to match a true circle to within ~0.02%. Used
 * by every rounded corner and elliptical arc below.
 */
export const KAPPA = 0.5522847498307936;

function isVec2(v: unknown): v is Vec2 {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  );
}

function validateVecArray(arr: unknown, label: string): Vec2[] {
  if (!Array.isArray(arr)) {
    throw new Error(`${label} must be an array of [x, y] pairs.`);
  }
  arr.forEach((v, i) => {
    if (!isVec2(v)) {
      throw new Error(
        `${label}[${i}] must be a pair of finite numbers [x, y], got ${JSON.stringify(v)}.`,
      );
    }
  });
  return arr as Vec2[];
}

function zeros(n: number): Vec2[] {
  return Array.from({ length: n }, () => [0, 0] as Vec2);
}

/**
 * Validate a caller-supplied path and fill in its defaults.
 *
 * Omitted tangent arrays become all-zero handles, which is exactly a polyline
 * (straight segments between vertices) - the same shape `set-layer-mask` has
 * always produced, so omitting tangents is the sensible default rather than an
 * error. `closed` defaults to true.
 *
 * Throws with an actionable message rather than returning a partial result: a
 * malformed path that reaches AE fails silently (see the module comment), so
 * failing loudly here is the only place a caller finds out.
 */
export function normalizePath(input: PathData): NormalizedPath {
  if (!input || typeof input !== "object") {
    throw new Error("Path data must be an object with a `vertices` array.");
  }
  const vertices = validateVecArray(input.vertices, "vertices");
  if (vertices.length < 2) {
    throw new Error(
      `A path needs at least 2 vertices, got ${vertices.length}. ` +
        `Use 3 or more for a closed shape with any area.`,
    );
  }

  const n = vertices.length;
  let inTangents: Vec2[];
  if (input.inTangents === undefined || input.inTangents === null) {
    inTangents = zeros(n);
  } else {
    inTangents = validateVecArray(input.inTangents, "inTangents");
    if (inTangents.length !== n) {
      throw new Error(
        `inTangents has ${inTangents.length} entries but there are ${n} vertices. ` +
          `After Effects silently zero-fills the mismatch instead of erroring, so ` +
          `the arrays must agree exactly. Omit inTangents entirely for straight segments.`,
      );
    }
  }

  let outTangents: Vec2[];
  if (input.outTangents === undefined || input.outTangents === null) {
    outTangents = zeros(n);
  } else {
    outTangents = validateVecArray(input.outTangents, "outTangents");
    if (outTangents.length !== n) {
      throw new Error(
        `outTangents has ${outTangents.length} entries but there are ${n} vertices. ` +
          `After Effects silently zero-fills the mismatch instead of erroring, so ` +
          `the arrays must agree exactly. Omit outTangents entirely for straight segments.`,
      );
    }
  }

  return {
    vertices,
    inTangents,
    outTangents,
    closed: input.closed === undefined ? true : !!input.closed,
  };
}

/**
 * Guard a path morph: every keyframe must have the same vertex count.
 *
 * Verified live (probe P5): AE *accepts* keyframes with differing vertex counts
 * without error, but the in-between frames it interpolates are visually garbage
 * - vertices get matched up arbitrarily and the shape tears. AE gives no signal,
 * so this check is the only warning a caller will get.
 */
export function assertMorphCompatible(paths: NormalizedPath[]): void {
  if (paths.length < 2) return;
  const expected = paths[0].vertices.length;
  for (let i = 1; i < paths.length; i++) {
    const got = paths[i].vertices.length;
    if (got !== expected) {
      throw new Error(
        `Path morph requires the same vertex count in every keyframe: ` +
          `keyframe 1 has ${expected} vertices but keyframe ${i + 1} has ${got}. ` +
          `After Effects accepts this without an error but interpolates it into a ` +
          `torn, unusable shape. Resample the paths to a common vertex count first.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Generators
//
// Coordinate convention matches After Effects: +x is right, +y is DOWN, and the
// origin is the layer's anchor point (NOT the comp's top-left, and not the comp
// centre - verified live in probe P6). All generators are centred on `center`,
// which defaults to the origin, so a generated shape lands on the layer's anchor
// point unless the caller offsets it.
// ---------------------------------------------------------------------------

export interface RoundedRectSpec {
  width: number;
  height: number;
  /** Corner radius; clamped to half the shorter side. 0 gives a plain rectangle. */
  radius?: number;
  center?: Vec2;
}

function requirePositive(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * A rectangle with optionally rounded corners, as an explicit bezier path.
 *
 * A plain rectangle is 4 vertices; a rounded one is 8 (two per corner) with
 * kappa-scaled handles turning each corner into a quarter-arc. `radius` is
 * clamped to `min(width, height) / 2` - beyond that the corner arcs would
 * overlap and AE renders a self-intersecting mess.
 */
export function roundedRect(spec: RoundedRectSpec): NormalizedPath {
  const width = requirePositive(spec.width, "width");
  const height = requirePositive(spec.height, "height");
  const [cx, cy] = spec.center ?? [0, 0];
  const maxRadius = Math.min(width, height) / 2;
  const rawRadius = spec.radius ?? 0;
  if (!Number.isFinite(rawRadius) || rawRadius < 0) {
    throw new Error(`radius must be a non-negative finite number, got ${JSON.stringify(rawRadius)}.`);
  }
  const r = Math.min(rawRadius, maxRadius);

  const hw = width / 2;
  const hh = height / 2;

  if (r === 0) {
    return normalizePath({
      vertices: [
        [cx - hw, cy - hh],
        [cx + hw, cy - hh],
        [cx + hw, cy + hh],
        [cx - hw, cy + hh],
      ],
      closed: true,
    });
  }

  const h = r * KAPPA;
  // Clockwise from the end of the top-left corner arc.
  const vertices: Vec2[] = [
    [cx - hw + r, cy - hh],
    [cx + hw - r, cy - hh],
    [cx + hw, cy - hh + r],
    [cx + hw, cy + hh - r],
    [cx + hw - r, cy + hh],
    [cx - hw + r, cy + hh],
    [cx - hw, cy + hh - r],
    [cx - hw, cy - hh + r],
  ];
  // Handles are zero along the straight edges and kappa-scaled into each corner.
  const inTangents: Vec2[] = [
    [-h, 0],
    [0, 0],
    [0, -h],
    [0, 0],
    [h, 0],
    [0, 0],
    [0, h],
    [0, 0],
  ];
  const outTangents: Vec2[] = [
    [0, 0],
    [h, 0],
    [0, 0],
    [0, h],
    [0, 0],
    [-h, 0],
    [0, 0],
    [0, -h],
  ];
  return normalizePath({ vertices, inTangents, outTangents, closed: true });
}

export interface EllipseSpec {
  width: number;
  height: number;
  center?: Vec2;
}

/**
 * An ellipse as a 4-vertex bezier, the same construction After Effects itself
 * uses when you convert a parametric ellipse to a path.
 */
export function ellipsePath(spec: EllipseSpec): NormalizedPath {
  const width = requirePositive(spec.width, "width");
  const height = requirePositive(spec.height, "height");
  const [cx, cy] = spec.center ?? [0, 0];
  const hw = width / 2;
  const hh = height / 2;
  const hx = hw * KAPPA;
  const hy = hh * KAPPA;

  // Top, right, bottom, left - clockwise in AE's y-down space.
  return normalizePath({
    vertices: [
      [cx, cy - hh],
      [cx + hw, cy],
      [cx, cy + hh],
      [cx - hw, cy],
    ],
    inTangents: [
      [-hx, 0],
      [0, -hy],
      [hx, 0],
      [0, hy],
    ],
    outTangents: [
      [hx, 0],
      [0, hy],
      [-hx, 0],
      [0, -hy],
    ],
    closed: true,
  });
}

export interface PolygonSpec {
  /** Number of sides (>= 3). */
  points: number;
  radius: number;
  center?: Vec2;
  /** Clockwise rotation in degrees. 0 puts the first vertex straight up. */
  rotation?: number;
}

function requireIntAtLeast(value: number, min: number, label: string): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer >= ${min}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * A regular polygon with straight edges (all tangents zero). The first vertex
 * sits at 12 o'clock before `rotation` is applied.
 */
export function regularPolygon(spec: PolygonSpec): NormalizedPath {
  const points = requireIntAtLeast(spec.points, 3, "points");
  const radius = requirePositive(spec.radius, "radius");
  const [cx, cy] = spec.center ?? [0, 0];
  const rot = ((spec.rotation ?? 0) * Math.PI) / 180;

  const vertices: Vec2[] = [];
  for (let i = 0; i < points; i++) {
    // Start at -PI/2 so vertex 0 is at the top, then step clockwise.
    const a = -Math.PI / 2 + rot + (i * 2 * Math.PI) / points;
    vertices.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return normalizePath({ vertices, closed: true });
}

export interface StarSpec {
  /** Number of points on the star (>= 3); the path gets twice this many vertices. */
  points: number;
  outerRadius: number;
  innerRadius: number;
  center?: Vec2;
  /** Clockwise rotation in degrees. 0 puts the first outer point straight up. */
  rotation?: number;
}

/**
 * A star: `points` outer vertices alternating with `points` inner ones, straight
 * edges throughout.
 */
export function starPath(spec: StarSpec): NormalizedPath {
  const points = requireIntAtLeast(spec.points, 3, "points");
  const outerRadius = requirePositive(spec.outerRadius, "outerRadius");
  const innerRadius = requirePositive(spec.innerRadius, "innerRadius");
  if (innerRadius >= outerRadius) {
    throw new Error(
      `innerRadius (${innerRadius}) must be smaller than outerRadius (${outerRadius}); ` +
        `otherwise the star inverts into a polygon.`,
    );
  }
  const [cx, cy] = spec.center ?? [0, 0];
  const rot = ((spec.rotation ?? 0) * Math.PI) / 180;

  const vertices: Vec2[] = [];
  const step = Math.PI / points; // half a full point-to-point step
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const a = -Math.PI / 2 + rot + i * step;
    vertices.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return normalizePath({ vertices, closed: true });
}

/** Discriminated spec for the `generator` parameter of `set-shape-path`. */
export type GeneratorSpec =
  | ({ type: "roundedRect" } & RoundedRectSpec)
  | ({ type: "ellipse" } & EllipseSpec)
  | ({ type: "polygon" } & PolygonSpec)
  | ({ type: "star" } & StarSpec);

/**
 * Dispatch a generator spec to its builder. Keeps the tool handler in index.ts
 * free of per-generator branching.
 */
export function generatePath(spec: GeneratorSpec): NormalizedPath {
  switch (spec.type) {
    case "roundedRect":
      return roundedRect(spec);
    case "ellipse":
      return ellipsePath(spec);
    case "polygon":
      return regularPolygon(spec);
    case "star":
      return starPath(spec);
    default: {
      const bad = spec as { type?: unknown };
      throw new Error(`Unknown generator type: ${JSON.stringify(bad?.type)}.`);
    }
  }
}

/**
 * Resolve the path a caller asked for: either an explicit vertex list or a
 * generator spec, but not both and not neither. Shared by the single-path and
 * per-keyframe code paths so they can never disagree about precedence.
 */
export function resolvePathInput(input: {
  vertices?: Vec2[];
  inTangents?: Vec2[];
  outTangents?: Vec2[];
  closed?: boolean;
  generator?: GeneratorSpec;
}): NormalizedPath {
  const hasVertices = Array.isArray(input?.vertices) && input.vertices.length > 0;
  const hasGenerator = !!input?.generator;
  if (hasVertices && hasGenerator) {
    throw new Error(
      "Provide either `vertices` or `generator`, not both - they describe the same path two different ways.",
    );
  }
  if (!hasVertices && !hasGenerator) {
    throw new Error("Provide a path: either `vertices` (with optional tangents) or a `generator` spec.");
  }
  if (hasGenerator) {
    const generated = generatePath(input.generator as GeneratorSpec);
    // `closed` is the one generator output a caller may sensibly override, e.g.
    // to draw an open arc from an ellipse.
    return input.closed === undefined ? generated : { ...generated, closed: !!input.closed };
  }
  return normalizePath(input as PathData);
}
