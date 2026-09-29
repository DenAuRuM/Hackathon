// A small dependency-free slippy-tile overview. Routes remain visible without network.
const SIZE = 256;
function project(point, zoom) {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, point.lat)) * Math.PI / 180;
  const scale = SIZE * 2 ** zoom;
  return [(point.lon + 180) / 360 * scale, (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale];
}
const NS = 'http://www.w3.org/2000/svg';
function element(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
export function drawMap(container, plan, colors) {
  const width = 1000, height = 420, margin = 50;
  const all = [...plan.routes.flatMap(r => r.geometry), ...plan.input.requests.map(r => r.location)];
  container.replaceChildren();
  if (!all.length) { container.textContent = 'Нет точек для отображения.'; return; }
  let zoom = 14, coordinates;
  for (; zoom >= 0; zoom--) {
    coordinates = all.map(p => project(p, zoom));
    if (Math.max(...coordinates.map(p => p[0])) - Math.min(...coordinates.map(p => p[0])) <= width - margin * 2 &&
        Math.max(...coordinates.map(p => p[1])) - Math.min(...coordinates.map(p => p[1])) <= height - margin * 2) break;
  }
  zoom = Math.max(0, zoom);
  const xs = coordinates.map(p => p[0]), ys = coordinates.map(p => p[1]);
  const origin = [(Math.min(...xs) + Math.max(...xs) - width) / 2, (Math.min(...ys) + Math.max(...ys) - height) / 2];
  const local = p => project(p, zoom).map((v, i) => v - origin[i]);
  const svg = element('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Карта точек и порядка посещения заявок' });
  svg.append(element('rect', { width, height, fill: '#e7eee6' }));
  for (let x = 0; x < width; x += 50) svg.append(element('path', { d: `M${x},0 V${height}`, stroke: '#d7e1d7', 'stroke-width': 1 }));
  for (let y = 0; y < height; y += 50) svg.append(element('path', { d: `M0,${y} H${width}`, stroke: '#d7e1d7', 'stroke-width': 1 }));
  const n = 2 ** zoom;
  for (let x = Math.floor(origin[0] / SIZE); x <= Math.floor((origin[0] + width) / SIZE); x++) {
    for (let y = Math.floor(origin[1] / SIZE); y <= Math.floor((origin[1] + height) / SIZE); y++) {
      if (y < 0 || y >= n) continue;
      svg.append(element('image', { x: x * SIZE - origin[0], y: y * SIZE - origin[1], width: SIZE, height: SIZE,
        href: `https://tile.openstreetmap.org/${zoom}/${((x % n) + n) % n}/${y}.png` }));
    }
  }
  const marker = (p, color, label, title, start = false) => {
    const [cx, cy] = local(p);
    const group = element('g', { tabindex: 0, role: 'img', 'aria-label': title });
    group.append(element('title', {}, title));
    group.append(element(start ? 'rect' : 'circle', start ? { x: cx - 6, y: cy - 6, width: 12, height: 12, fill: color, stroke: 'white', 'stroke-width': 2 } : { cx, cy, r: 7, fill: color, stroke: 'white', 'stroke-width': 2 }));
    group.append(element('text', { x: cx + 11, y: cy - 10, fill: color, 'font-size': 14, 'font-weight': 700,
      stroke: 'white', 'stroke-width': 3, 'paint-order': 'stroke' }, label));
    svg.append(group);
  };
  plan.routes.forEach((route, i) => {
    const color = colors[i % colors.length];
    const line = element('polyline', { points: route.geometry.map(p => local(p).join(',')).join(' '), fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linejoin': 'round', opacity: .8 });
    line.append(element('title', {}, `${route.engineerName}: ${route.distanceKm} км`)); svg.append(line);
  });
  plan.routes.forEach((route, i) => {
    const color = colors[i % colors.length];
    marker(route.startLocation, color, route.engineerName, `Старт: ${route.engineerName}`, true);
    route.stops.forEach((s, index) => marker(s.location, color, `${index + 1} · ${s.requestId}`, `${route.engineerName}: ${s.requestId}, ${s.start}–${s.end}`));
  });
  plan.unassigned.forEach(u => marker(plan.input.requests.find(r => r.id === u.requestId).location, '#b9402e', u.requestId, u.reason.text));
  container.append(svg);
  const attribution = document.createElement('a');
  attribution.href = 'https://www.openstreetmap.org/copyright'; attribution.textContent = '© OpenStreetMap contributors';
  attribution.className = 'map-attribution'; attribution.target = '_blank'; attribution.rel = 'noopener'; container.append(attribution);
}
