import { describe, it, expect } from "vitest";
import {
  KAPPA,
  normalizePath,
  assertMorphCompatible,
  roundedRect,
  ellipsePath,
  regularPolygon,
  starPath,
  generatePath,
  resolvePathInput,
  type Vec2,
  type NormalizedPath,
} from "../src/lib/shape-path";

/** Sum of segment lengths - a cheap proxy for "is this the shape I expect". */
function perimeter(vertices: Vec2[]): number {
  let total = 0;
  for (let i = 0; i < vertices.length; i++) {
    const [ax, ay] = vertices[i];
    const [bx, by] = vertices[(i + 1) % vertices.length];
    total += Math.hypot(bx - ax, by - ay);
  }
  return total;
}

function distanceFrom(center: Vec2, v: Vec2): number {
  return Math.hypot(v[0] - center[0], v[1] - center[1]);
}

describe("normalizePath", () => {
  it("defaults omitted tangents to zero handles (a polyline)", () => {
    const p = normalizePath({
      vertices: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    });
    expect(p.inTangents).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(p.outTangents).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it("defaults closed to true, and preserves an explicit false", () => {
    const verts: Vec2[] = [
      [0, 0],
      [1, 1],
    ];
    expect(normalizePath({ vertices: verts }).closed).toBe(true);
    expect(normalizePath({ vertices: verts, closed: false }).closed).toBe(false);
  });

  it("preserves supplied tangents verbatim (AE stores them relative to their vertex)", () => {
    const p = normalizePath({
      vertices: [
        [0, 0],
        [100, 0],
      ],
      inTangents: [
        [0, 0],
        [-30, 5],
      ],
      outTangents: [
        [30, -5],
        [0, 0],
      ],
    });
    expect(p.outTangents[0]).toEqual([30, -5]);
    expect(p.inTangents[1]).toEqual([-30, 5]);
  });

  // This is the case AE itself does not catch (probe P4: it silently zero-fills),
  // which is the entire reason this module exists.
  it("rejects a tangent array whose length disagrees with vertices", () => {
    expect(() =>
      normalizePath({
        vertices: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        inTangents: [
          [0, 0],
          [0, 0],
        ],
      }),
    ).toThrow(/inTangents has 2 entries but there are 3 vertices/);
  });

  it("rejects fewer than 2 vertices", () => {
    expect(() => normalizePath({ vertices: [[0, 0]] })).toThrow(/at least 2 vertices/);
  });

  it("rejects non-finite and malformed vertices", () => {
    expect(() =>
      normalizePath({ vertices: [[0, 0], [Number.NaN, 1]] as Vec2[] }),
    ).toThrow(/vertices\[1\] must be a pair of finite numbers/);
    expect(() =>
      normalizePath({ vertices: [[0, 0], [1, 2, 3]] as unknown as Vec2[] }),
    ).toThrow(/vertices\[1\]/);
  });

  it("rejects a missing vertices array", () => {
    expect(() => normalizePath({} as never)).toThrow(/vertices must be an array/);
  });
});

describe("assertMorphCompatible", () => {
  const square = (): NormalizedPath =>
    normalizePath({
      vertices: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    });
  const triangle = (): NormalizedPath =>
    normalizePath({
      vertices: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    });

  it("accepts keyframes that all share a vertex count", () => {
    expect(() => assertMorphCompatible([square(), square(), square()])).not.toThrow();
  });

  it("is a no-op for zero or one keyframe", () => {
    expect(() => assertMorphCompatible([])).not.toThrow();
    expect(() => assertMorphCompatible([triangle()])).not.toThrow();
  });

  it("rejects a mismatched vertex count, naming the offending keyframe", () => {
    expect(() => assertMorphCompatible([square(), triangle()])).toThrow(
      /keyframe 1 has 4 vertices but keyframe 2 has 3/,
    );
  });
});

describe("roundedRect", () => {
  it("produces a plain 4-vertex rectangle when radius is 0 or omitted", () => {
    const p = roundedRect({ width: 200, height: 100 });
    expect(p.vertices).toEqual([
      [-100, -50],
      [100, -50],
      [100, 50],
      [-100, 50],
    ]);
    expect(p.outTangents.every((t) => t[0] === 0 && t[1] === 0)).toBe(true);
    expect(p.closed).toBe(true);
  });

  it("produces 8 vertices with kappa-scaled corner handles when rounded", () => {
    const r = 20;
    const p = roundedRect({ width: 200, height: 100, radius: r });
    expect(p.vertices).toHaveLength(8);
    expect(p.inTangents).toHaveLength(8);
    expect(p.outTangents).toHaveLength(8);
    // Corner handles span exactly r * KAPPA; straight edges carry zero handles.
    const h = r * KAPPA;
    expect(p.outTangents[1]).toEqual([h, 0]);
    expect(p.inTangents[2]).toEqual([0, -h]);
    expect(p.outTangents[0]).toEqual([0, 0]);
  });

  it("clamps radius to half the shorter side so corner arcs cannot overlap", () => {
    const clamped = roundedRect({ width: 100, height: 40, radius: 999 });
    const exact = roundedRect({ width: 100, height: 40, radius: 20 });
    expect(clamped.vertices).toEqual(exact.vertices);
    expect(clamped.outTangents).toEqual(exact.outTangents);
  });

  it("offsets every vertex by center", () => {
    const p = roundedRect({ width: 100, height: 100, center: [50, -25] });
    expect(p.vertices).toEqual([
      [0, -75],
      [100, -75],
      [100, 25],
      [0, 25],
    ]);
  });

  it("rejects a non-positive size and a negative radius", () => {
    expect(() => roundedRect({ width: 0, height: 10 })).toThrow(/width must be a positive/);
    expect(() => roundedRect({ width: 10, height: 10, radius: -1 })).toThrow(
      /radius must be a non-negative/,
    );
  });
});

describe("ellipsePath", () => {
  it("places 4 vertices at top, right, bottom, left", () => {
    const p = ellipsePath({ width: 200, height: 100 });
    expect(p.vertices).toEqual([
      [0, -50],
      [100, 0],
      [0, 50],
      [-100, 0],
    ]);
    expect(p.closed).toBe(true);
  });

  it("scales handles by kappa independently on each axis", () => {
    const p = ellipsePath({ width: 200, height: 100 });
    expect(p.outTangents[0]).toEqual([100 * KAPPA, 0]);
    expect(p.outTangents[1]).toEqual([0, 50 * KAPPA]);
  });

  it("approximates a true circle to within 0.1% at the arc midpoints", () => {
    const radius = 100;
    const p = ellipsePath({ width: radius * 2, height: radius * 2 });
    // Midpoint of the first quarter-arc, evaluated as a cubic bezier.
    const p0 = p.vertices[0];
    const p3 = p.vertices[1];
    const c1: Vec2 = [p0[0] + p.outTangents[0][0], p0[1] + p.outTangents[0][1]];
    const c2: Vec2 = [p3[0] + p.inTangents[1][0], p3[1] + p.inTangents[1][1]];
    const t = 0.5;
    const mt = 1 - t;
    const x =
      mt * mt * mt * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p3[0];
    const y =
      mt * mt * mt * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p3[1];
    expect(Math.hypot(x, y)).toBeCloseTo(radius, 0);
    expect(Math.abs(Math.hypot(x, y) - radius) / radius).toBeLessThan(0.001);
  });
});

describe("regularPolygon", () => {
  it("puts the first vertex straight up and steps clockwise", () => {
    const p = regularPolygon({ points: 4, radius: 100 });
    expect(p.vertices).toHaveLength(4);
    expect(p.vertices[0][0]).toBeCloseTo(0, 6);
    expect(p.vertices[0][1]).toBeCloseTo(-100, 6);
    // Clockwise in AE's y-down space means the next vertex is to the right.
    expect(p.vertices[1][0]).toBeCloseTo(100, 6);
    expect(p.vertices[1][1]).toBeCloseTo(0, 6);
  });

  it("keeps every vertex on the circumscribed circle", () => {
    const p = regularPolygon({ points: 7, radius: 60, center: [10, 20] });
    for (const v of p.vertices) {
      expect(distanceFrom([10, 20], v)).toBeCloseTo(60, 6);
    }
  });

  it("has all-zero tangents (straight edges)", () => {
    const p = regularPolygon({ points: 5, radius: 10 });
    expect(p.inTangents.every((t) => t[0] === 0 && t[1] === 0)).toBe(true);
  });

  it("rotates by degrees", () => {
    const p = regularPolygon({ points: 4, radius: 100, rotation: 90 });
    expect(p.vertices[0][0]).toBeCloseTo(100, 6);
    expect(p.vertices[0][1]).toBeCloseTo(0, 6);
  });

  it("rejects fewer than 3 points and a non-positive radius", () => {
    expect(() => regularPolygon({ points: 2, radius: 10 })).toThrow(/points must be an integer >= 3/);
    expect(() => regularPolygon({ points: 5, radius: 0 })).toThrow(/radius must be a positive/);
  });
});

describe("starPath", () => {
  it("alternates outer and inner radii over 2n vertices", () => {
    const p = starPath({ points: 5, outerRadius: 100, innerRadius: 40 });
    expect(p.vertices).toHaveLength(10);
    p.vertices.forEach((v, i) => {
      expect(distanceFrom([0, 0], v)).toBeCloseTo(i % 2 === 0 ? 100 : 40, 6);
    });
  });

  it("starts the first outer point straight up", () => {
    const p = starPath({ points: 6, outerRadius: 50, innerRadius: 25 });
    expect(p.vertices[0][0]).toBeCloseTo(0, 6);
    expect(p.vertices[0][1]).toBeCloseTo(-50, 6);
  });

  it("rejects an innerRadius that is not smaller than outerRadius", () => {
    expect(() => starPath({ points: 5, outerRadius: 50, innerRadius: 50 })).toThrow(
      /must be smaller than outerRadius/,
    );
  });

  it("is smaller in perimeter than the polygon on its outer radius", () => {
    const star = starPath({ points: 5, outerRadius: 100, innerRadius: 20 });
    const poly = regularPolygon({ points: 5, radius: 100 });
    expect(perimeter(star.vertices)).toBeGreaterThan(perimeter(poly.vertices) * 0.5);
  });
});

describe("generatePath", () => {
  it("dispatches each generator type", () => {
    expect(generatePath({ type: "roundedRect", width: 10, height: 10 }).vertices).toHaveLength(4);
    expect(generatePath({ type: "ellipse", width: 10, height: 10 }).vertices).toHaveLength(4);
    expect(generatePath({ type: "polygon", points: 6, radius: 5 }).vertices).toHaveLength(6);
    expect(
      generatePath({ type: "star", points: 5, outerRadius: 10, innerRadius: 4 }).vertices,
    ).toHaveLength(10);
  });

  it("rejects an unknown type", () => {
    expect(() => generatePath({ type: "hexagram" } as never)).toThrow(/Unknown generator type/);
  });
});

describe("resolvePathInput", () => {
  it("accepts explicit vertices", () => {
    const p = resolvePathInput({
      vertices: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(p.vertices).toHaveLength(2);
  });

  it("accepts a generator spec", () => {
    const p = resolvePathInput({ generator: { type: "polygon", points: 3, radius: 10 } });
    expect(p.vertices).toHaveLength(3);
  });

  it("lets closed override a generator's default", () => {
    const p = resolvePathInput({
      generator: { type: "ellipse", width: 10, height: 10 },
      closed: false,
    });
    expect(p.closed).toBe(false);
  });

  it("rejects supplying both vertices and a generator", () => {
    expect(() =>
      resolvePathInput({
        vertices: [
          [0, 0],
          [1, 1],
        ],
        generator: { type: "polygon", points: 3, radius: 10 },
      }),
    ).toThrow(/not both/);
  });

  it("rejects supplying neither", () => {
    expect(() => resolvePathInput({})).toThrow(/Provide a path/);
  });
});
