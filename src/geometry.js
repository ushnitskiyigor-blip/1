const EPSILON = 1e-8;
const OUTLINE_PADDING = 10;

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const coordinate = (value) => String(Math.round(value * 1000) / 1000);
const pair = (point) => `${coordinate(point.x)} ${coordinate(point.y)}`;

function validPoints(points) {
  return (points || []).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
}

/** A soft quadratic path that preserves the two ends of a stroke. */
export function smoothPath(points) {
  const clean = validPoints(points);
  if (!clean.length) return '';
  if (clean.length === 1) return `M ${pair(clean[0])}`;
  if (clean.length === 2) return `M ${pair(clean[0])} L ${pair(clean[1])}`;

  let path = `M ${pair(clean[0])}`;
  for (let index = 1; index < clean.length - 1; index += 1) {
    const point = clean[index];
    const next = clean[index + 1];
    const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
    path += ` Q ${pair(point)} ${pair(midpoint)}`;
  }
  return `${path} L ${pair(clean.at(-1))}`;
}

export function pathLength(points) {
  const clean = validPoints(points);
  let length = 0;
  for (let index = 1; index < clean.length; index += 1) {
    length += distance(clean[index - 1], clean[index]);
  }
  return length;
}

function distanceToSegmentSquared(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const fraction = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return (point.x - start.x - fraction * dx) ** 2 + (point.y - start.y - fraction * dy) ** 2;
}

/** Iterative Ramer–Douglas–Peucker simplification; endpoints are always retained. */
export function simplifyPoints(points, tolerance = 2) {
  const clean = validPoints(points);
  if (clean.length < 3 || tolerance <= 0) return clean.slice();

  const keep = new Set([0, clean.length - 1]);
  const stack = [[0, clean.length - 1]];
  const threshold = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop();
    let furthest = -1;
    let maximumDistance = threshold;
    for (let index = first + 1; index < last; index += 1) {
      const squared = distanceToSegmentSquared(clean[index], clean[first], clean[last]);
      if (squared > maximumDistance) {
        maximumDistance = squared;
        furthest = index;
      }
    }
    if (furthest !== -1) {
      keep.add(furthest);
      stack.push([first, furthest], [furthest, last]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((index) => clean[index]);
}

function resampleStroke(points, spacing) {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(lengths[index - 1] + distance(points[index - 1], points[index]));
  }
  const total = lengths.at(-1);
  const step = Math.max(spacing, total / 5000);
  const result = [{ ...points[0] }];
  let segment = 1;
  for (let length = step; length < total; length += step) {
    while (segment < points.length - 1 && lengths[segment] < length) segment += 1;
    const start = points[segment - 1];
    const end = points[segment];
    const fraction = (length - lengths[segment - 1]) / (lengths[segment] - lengths[segment - 1]);
    result.push({ x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction });
  }
  result.push({ ...points.at(-1) });
  return result;
}

function smoothingSample(points, index, closed) {
  const last = points.length - 1;
  if (closed) {
    // First and last represent the same place on a closed gesture. Wrapping
    // gives its seam the same smoothing as the rest of the loop.
    return points[((index % last) + last) % last];
  }
  if (index < 0) return {
    x: points[0].x + index * (points[1].x - points[0].x),
    y: points[0].y + index * (points[1].y - points[0].y),
  };
  if (index > last) return {
    x: points[last].x + (index - last) * (points[last].x - points[last - 1].x),
    y: points[last].y + (index - last) * (points[last].y - points[last - 1].y),
  };
  return points[index];
}

/**
 * Stabilize mouse gestures in screen pixels while retaining broad bends.
 * Resampling makes filtering independent of pointer-event frequency. A
 * quadratic Savitzky–Golay window removes jitter without flattening arcs.
 * Use this once for raw preview points and save that same result on release.
 */
export function stabilizeStroke(points) {
  const clean = validPoints(points).filter((point, index, all) => !index || distance(point, all[index - 1]) > EPSILON);
  if (clean.length < 3) return clean.map(point => ({ ...point }));
  let result = resampleStroke(clean, 5);
  const radius = Math.min(5, Math.floor((result.length - 1) / 2));
  const closed = distance(clean[0], clean.at(-1)) < 8 && isClosedLoop(clean);
  if (radius >= 2) {
    const denominator = (2 * radius + 1) * (4 * radius * radius + 4 * radius - 3);
    const weights = Array.from({ length: radius * 2 + 1 }, (_, index) => {
      const offset = index - radius;
      return 3 * (3 * radius * radius + 3 * radius - 1 - 5 * offset * offset) / denominator;
    });
    for (let pass = 0; pass < 3; pass += 1) {
      result = result.map((point, index) => {
        if (!index || index === result.length - 1) return { ...point };
        const smoothed = { x: 0, y: 0 };
        for (let offset = -radius; offset <= radius; offset += 1) {
          const sample = smoothingSample(result, index + offset, closed);
          const weight = weights[offset + radius];
          smoothed.x += sample.x * weight;
          smoothed.y += sample.y * weight;
        }
        return smoothed;
      });
    }
  }
  const first = { ...clean[0] };
  const last = { ...clean.at(-1) };
  result[0] = first;
  result[result.length - 1] = last;
  const chord = distance(first, last);
  const straightTolerance = Math.min(3, Math.max(1.5, chord * 0.008));
  if (!closed && chord > 20 && result.every(point => distanceToSegmentSquared(point, first, last) <= straightTolerance ** 2)) {
    return [first, last];
  }
  return result;
}

/** Liang–Barsky clipping, including sparse strokes that jump across a word. */
function clippedHorizontalInterval(start, end, bounds) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let minimum = 0;
  let maximum = 1;
  const constraints = [
    [-dx, start.x - bounds.left],
    [dx, bounds.right - start.x],
    [-dy, start.y - bounds.top],
    [dy, bounds.bottom - start.y],
  ];
  for (const [slope, offset] of constraints) {
    if (Math.abs(slope) < EPSILON) {
      if (offset < 0) return null;
      continue;
    }
    const fraction = offset / slope;
    if (slope < 0) minimum = Math.max(minimum, fraction);
    else maximum = Math.min(maximum, fraction);
    if (minimum > maximum) return null;
  }
  const from = start.x + minimum * dx;
  const to = start.x + maximum * dx;
  return [Math.min(from, to), Math.max(from, to)];
}

function coveredWidth(intervals) {
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let [left, right] = intervals[0];
  let width = 0;
  for (let index = 1; index < intervals.length; index += 1) {
    const interval = intervals[index];
    if (interval[0] <= right) right = Math.max(right, interval[1]);
    else {
      width += right - left;
      [left, right] = interval;
    }
  }
  return width + right - left;
}

function insidePolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const start = polygon[index];
    const end = polygon[previous];
    if (distanceToSegmentSquared(point, start, end) < EPSILON) return true;
    if ((start.y > point.y) !== (end.y > point.y)
      && point.x < (end.x - start.x) * (point.y - start.y) / (end.y - start.y) + start.x) {
      inside = !inside;
    }
  }
  return inside;
}

function isClosedLoop(points) {
  if (points.length < 4) return false;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const diagonal = Math.hypot(width, height);
  return width > 8 && height > 8
    && pathLength(points) > diagonal * 2
    && distance(points[0], points.at(-1)) <= Math.max(10, Math.min(40, diagonal * 0.2));
}

function enclosedSubstantially(node, points) {
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  if (!insidePolygon(center, points)) return false;
  let inside = 0;
  for (const horizontal of [0, 0.5, 1]) {
    for (const vertical of [0, 0.5, 1]) {
      if (insidePolygon({ x: node.x + node.width * horizontal, y: node.y + node.height * vertical }, points)) inside += 1;
    }
  }
  return inside >= 5;
}

/**
 * A strike or underline must cover 30% of a word's width. Repeated small
 * scribbles cannot inflate the coverage. A loose closed lasso also qualifies.
 */
export function detectStrokeTargets(points, nodes) {
  const clean = validPoints(points);
  if (clean.length < 2) return [];
  const closed = isClosedLoop(clean);
  return (nodes || []).filter((node) => {
    if (!(node.width > 0 && node.height > 0)) return false;
    if (closed && enclosedSubstantially(node, clean)) return true;
    const verticalSlop = Math.min(8, Math.max(4, node.height * 0.25));
    const bounds = {
      left: node.x,
      right: node.x + node.width,
      top: node.y - verticalSlop,
      bottom: node.y + node.height + verticalSlop,
    };
    const intervals = [];
    for (let index = 1; index < clean.length; index += 1) {
      const interval = clippedHorizontalInterval(clean[index - 1], clean[index], bounds);
      if (interval) intervals.push(interval);
    }
    return coveredWidth(intervals) + EPSILON >= node.width * 0.3;
  }).map((node) => node.id);
}

function outlineGeometry(node, padding) {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  let rx = Math.max(1, node.width / 2 + padding);
  let ry = Math.max(1, node.height / 2 + padding);
  if (node.shape === 'square') rx = ry = Math.max(rx, ry);
  return {
    cx, cy, rx, ry,
    triangle: [
      { x: cx, y: cy - 2 * ry },
      { x: cx + 2 * rx, y: cy + ry },
      { x: cx - 2 * rx, y: cy + ry },
    ],
  };
}

export function outlinePath(node, padding = OUTLINE_PADDING) {
  if (node.shape === 'none') return '';
  const { cx, cy, rx, ry, triangle } = outlineGeometry(node, padding);
  if (node.shape === 'rectangle' || node.shape === 'square') {
    return `M ${coordinate(cx - rx)} ${coordinate(cy - ry)} H ${coordinate(cx + rx)} V ${coordinate(cy + ry)} H ${coordinate(cx - rx)} Z`;
  }
  if (node.shape === 'capsule') {
    const radius = Math.min(rx, ry);
    return `M ${coordinate(cx - rx + radius)} ${coordinate(cy - ry)} H ${coordinate(cx + rx - radius)} A ${coordinate(radius)} ${coordinate(radius)} 0 0 1 ${coordinate(cx + rx)} ${coordinate(cy - ry + radius)} V ${coordinate(cy + ry - radius)} A ${coordinate(radius)} ${coordinate(radius)} 0 0 1 ${coordinate(cx + rx - radius)} ${coordinate(cy + ry)} H ${coordinate(cx - rx + radius)} A ${coordinate(radius)} ${coordinate(radius)} 0 0 1 ${coordinate(cx - rx)} ${coordinate(cy + ry - radius)} V ${coordinate(cy - ry + radius)} A ${coordinate(radius)} ${coordinate(radius)} 0 0 1 ${coordinate(cx - rx + radius)} ${coordinate(cy - ry)} Z`;
  }
  if (node.shape === 'triangle') return `M ${triangle.map(pair).join(' L ')} Z`;
  return `M ${coordinate(cx - rx)} ${coordinate(cy)} A ${coordinate(rx)} ${coordinate(ry)} 0 1 0 ${coordinate(cx + rx)} ${coordinate(cy)} A ${coordinate(rx)} ${coordinate(ry)} 0 1 0 ${coordinate(cx - rx)} ${coordinate(cy)} Z`;
}

const cross = (a, b) => a.x * b.y - a.y * b.x;

/** Bounds of the visible outline, or of the text when its outline is hidden. */
export function outlineBounds(node) {
  const shape = node.outlined === false ? 'none' : node.shape || 'none';
  if (shape === 'none') return { x: node.x, y: node.y, width: node.width, height: node.height };
  const { cx, cy, rx, ry } = outlineGeometry(node, OUTLINE_PADDING);
  if (shape === 'triangle') return { x: cx - 2 * rx, y: cy - 2 * ry, width: 4 * rx, height: 3 * ry };
  return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
}

function boundaryPoint(node, toward, fallback) {
  const shape = node.outlined === false ? 'none' : node.shape || 'none';
  const padding = shape === 'none' ? 0 : OUTLINE_PADDING;
  const { cx, cy, rx, ry, triangle } = outlineGeometry({ ...node, shape }, padding);
  let direction = { x: toward.x - cx, y: toward.y - cy };
  if (Math.hypot(direction.x, direction.y) < EPSILON && fallback) {
    direction = { x: fallback.x - cx, y: fallback.y - cy };
  }
  let fraction;
  if (shape === 'ellipse') {
    fraction = 1 / Math.hypot(direction.x / rx, direction.y / ry);
  } else if (shape === 'capsule') {
    const radius = Math.min(rx, ry);
    const innerX = rx - radius;
    const innerY = ry - radius;
    fraction = Math.min(rx / Math.abs(direction.x), ry / Math.abs(direction.y));
    const hitX = Math.abs(direction.x * fraction);
    const hitY = Math.abs(direction.y * fraction);
    if (hitX > innerX + EPSILON && hitY > innerY + EPSILON) {
      const cornerX = Math.sign(direction.x) * innerX;
      const cornerY = Math.sign(direction.y) * innerY;
      const projection = direction.x * cornerX + direction.y * cornerY;
      const lengthSquared = direction.x ** 2 + direction.y ** 2;
      const discriminant = projection ** 2 - lengthSquared * (cornerX ** 2 + cornerY ** 2 - radius ** 2);
      fraction = (projection + Math.sqrt(Math.max(0, discriminant))) / lengthSquared;
    }
  } else if (shape === 'triangle') {
    fraction = Infinity;
    for (let index = 0; index < triangle.length; index += 1) {
      const start = triangle[index];
      const end = triangle[(index + 1) % triangle.length];
      const edge = { x: end.x - start.x, y: end.y - start.y };
      const offset = { x: start.x - cx, y: start.y - cy };
      const denominator = cross(direction, edge);
      if (Math.abs(denominator) < EPSILON) continue;
      const rayFraction = cross(offset, edge) / denominator;
      const edgeFraction = cross(offset, direction) / denominator;
      if (rayFraction >= 0 && edgeFraction >= 0 && edgeFraction <= 1) fraction = Math.min(fraction, rayFraction);
    }
  } else {
    fraction = Math.min(rx / Math.abs(direction.x), ry / Math.abs(direction.y));
  }
  return { x: cx + direction.x * fraction, y: cy + direction.y * fraction };
}

/** Trim a straight or quadratic connection and expose its editing handles. */
export function connectionGeometry(fromNode, toNode, bend = { x: 0, y: 0 }) {
  const fromCenter = { x: fromNode.x + fromNode.width / 2, y: fromNode.y + fromNode.height / 2 };
  const toCenter = { x: toNode.x + toNode.width / 2, y: toNode.y + toNode.height / 2 };
  const offset = { x: Number.isFinite(bend?.x) ? bend.x : 0, y: Number.isFinite(bend?.y) ? bend.y : 0 };
  const control = { x: (fromCenter.x + toCenter.x) / 2 + offset.x, y: (fromCenter.y + toCenter.y) / 2 + offset.y };
  if (distance(fromCenter, toCenter) < EPSILON) {
    return { start: fromCenter, end: toCenter, control, midpoint: { ...fromCenter }, path: '' };
  }
  const curved = Math.hypot(offset.x, offset.y) > EPSILON;
  const start = boundaryPoint(fromNode, curved ? control : toCenter, toCenter);
  const end = boundaryPoint(toNode, curved ? control : fromCenter, fromCenter);
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const midpoint = curved
    ? { x: start.x / 4 + control.x / 2 + end.x / 4, y: start.y / 4 + control.y / 2 + end.y / 4 }
    : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const path = !curved && (end.x - start.x) * dx + (end.y - start.y) * dy <= 0
    ? ''
    : curved ? `M ${pair(start)} Q ${pair(control)} ${pair(end)}` : `M ${pair(start)} L ${pair(end)}`;
  return { start, end, control, midpoint, path };
}

export function connectorPath(fromNode, toNode, bend) {
  return connectionGeometry(fromNode, toNode, bend).path;
}

function boundsOverlap(a, b, gap) {
  return a.x < b.x + b.width + gap - EPSILON && a.x + a.width + gap > b.x + EPSILON
    && a.y < b.y + b.height + gap - EPSILON && a.y + a.height + gap > b.y + EPSILON;
}

function placeApart(node, obstacles, gap) {
  const original = outlineBounds(node);
  if (!obstacles.some(bounds => boundsOverlap(original, bounds, gap))) return;
  const offsetX = original.x - node.x;
  const offsetY = original.y - node.y;
  const xs = new Set([node.x]);
  const ys = new Set([node.y]);
  for (const bounds of obstacles) {
    xs.add(bounds.x - gap - original.width - offsetX);
    xs.add(bounds.x + bounds.width + gap - offsetX);
    ys.add(bounds.y - gap - original.height - offsetY);
    ys.add(bounds.y + bounds.height + gap - offsetY);
  }
  const sortedX = [...xs].sort((a, b) => Math.abs(a - node.x) - Math.abs(b - node.x) || b - a);
  const sortedY = [...ys].sort((a, b) => Math.abs(a - node.y) - Math.abs(b - node.y) || b - a);
  let best = { x: node.x, y: node.y, squaredDistance: Infinity };
  // Obstacle edge coordinates include a guaranteed free outer placement.
  // Searching them avoids oscillation when two fixed words squeeze a third.
  for (const y of sortedY) {
    const dy = y - node.y;
    if (dy * dy > best.squaredDistance) break;
    for (const x of sortedX) {
      const squaredDistance = (x - node.x) ** 2 + dy * dy;
      if (squaredDistance >= best.squaredDistance - EPSILON) break;
      const bounds = { x: x + offsetX, y: y + offsetY, width: original.width, height: original.height };
      if (!obstacles.some(obstacle => boundsOverlap(bounds, obstacle, gap))) best = { x, y, squaredDistance };
    }
  }
  node.x = best.x;
  node.y = best.y;
}

/**
 * Keep moving anchors fixed and place other words at their nearest free
 * positions. Earlier free words act as settled obstacles, cascading pushes
 * without moving a selected group or bouncing between fixed anchors.
 */
export function repelNodes(nodes, movingIds, gap = 18) {
  const result = nodes.map(node => ({ ...node }));
  const anchors = new Set(movingIds || []);
  const spacing = Number.isFinite(gap) ? Math.max(0, gap) : 18;
  const obstacles = result.filter(node => anchors.has(node.id)).map(outlineBounds);
  const moved = new Set();
  for (const node of result) {
    if (anchors.has(node.id)) continue;
    const before = { x: node.x, y: node.y };
    placeApart(node, obstacles, spacing);
    if (node.x !== before.x || node.y !== before.y) moved.add(node.id);
    obstacles.push(outlineBounds(node));
  }
  const guides = [];
  for (let index = 0; index < result.length; index += 1) {
    for (let other = index + 1; other < result.length; other += 1) {
      if (!moved.has(result[index].id) && !moved.has(result[other].id)) continue;
      const a = outlineBounds(result[index]);
      const b = outlineBounds(result[other]);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      if (overlapY > 0 && Math.abs(Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width) - spacing) < 0.01) {
        const y = (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2;
        guides.push({ x1: Math.min(a.x + a.width, b.x + b.width), y1: y, x2: Math.max(a.x, b.x), y2: y });
      } else if (overlapX > 0 && Math.abs(Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height) - spacing) < 0.01) {
        const x = (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2;
        guides.push({ x1: x, y1: Math.min(a.y + a.height, b.y + b.height), x2: x, y2: Math.max(a.y, b.y) });
      }
    }
  }
  return { nodes: result, guides };
}

/** Bend an attached freehand stroke as its word moves, keeping remote ends fixed. */
export function attachedStrokePoints(stroke, node) {
  let points = stroke.points;
  const origin = stroke.attachment?.origin;
  if (!origin || !node || !points.length) return points;
  if (stroke.attachment.nodeId && node.id && stroke.attachment.nodeId !== node.id) return points;
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  if (![origin.x, origin.y, center.x, center.y].every(Number.isFinite)
    || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return points;

  const dx = center.x - origin.x;
  const dy = center.y - origin.y;
  if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return points;

  let closest = 0;
  let closestDistance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const offset = distance(points[index], origin);
    if (offset < closestDistance) {
      closestDistance = offset;
      closest = index;
    }
  }

  // Simplification can leave a word halfway along a two-point stroke. Restore
  // its attachment sample at the nearest segment projection before bending.
  let insertion = null;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentX = end.x - start.x;
    const segmentY = end.y - start.y;
    const squaredLength = segmentX ** 2 + segmentY ** 2;
    if (squaredLength < EPSILON) continue;
    const fraction = ((origin.x - start.x) * segmentX + (origin.y - start.y) * segmentY) / squaredLength;
    if (fraction <= EPSILON || fraction >= 1 - EPSILON) continue;
    const projected = { x: start.x + fraction * segmentX, y: start.y + fraction * segmentY };
    const offset = distance(projected, origin);
    if (offset + EPSILON < closestDistance) {
      closestDistance = offset;
      insertion = { index, point: projected };
    }
  }
  if (insertion) {
    points = [...points.slice(0, insertion.index), insertion.point, ...points.slice(insertion.index)];
    closest = insertion.index;
  }

  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(lengths[index - 1] + distance(points[index - 1], points[index]));
  }

  const last = points.length - 1;
  const beforeLength = lengths[closest];
  const afterLength = lengths[last] - beforeLength;
  return points.map((point, index) => {
    let weight = 1;
    if (index < closest) {
      weight = beforeLength > EPSILON ? lengths[index] / beforeLength : index / closest;
    } else if (index > closest) {
      weight = afterLength > EPSILON ? (lengths[last] - lengths[index]) / afterLength : (last - index) / (last - closest);
    }
    return { ...point, x: point.x + dx * weight, y: point.y + dy * weight };
  });
}
