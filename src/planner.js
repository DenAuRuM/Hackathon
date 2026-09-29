/** Pure JavaScript, also importable directly from a browser. All times are within one day. */
export const SKILLS = ['Локальные работы', 'Работы на подключение и дозаказы', 'Аварийные работы'];
export const TRANSPORTS = ['Автомобиль', 'Пешеход', 'Велосипед', 'Общественный транспорт'];
export const DEFAULT_WEIGHTS = Object.freeze({
  personnel: 8, distance: 3, travel: 1, waiting: 0.5,
  balance: 0.3, versatility: 0.5, stability: 2,
});
const SPEEDS = { 'Автомобиль': 30, 'Пешеход': 5, 'Велосипед': 15, 'Общественный транспорт': 18 };
const EPS = 1e-9;
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const sum = values => values.reduce((a, b) => a + b, 0);
const round = value => Math.round(value * 100) / 100;

export function parseTime(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`Некорректное время «${value}»: ожидается HH:MM в пределах одного дня.`);
  }
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
export function formatTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
function check(condition, message) { if (!condition) throw new Error(message); }
function point(value, label) {
  check(value && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90 &&
    Number.isFinite(value.lon) && Math.abs(value.lon) <= 180,
  `${label}: нужны координаты { lat, lon }; адрес необходимо предварительно геокодировать.`);
}
export function validateData(data) {
  check(data && Array.isArray(data.requests) && Array.isArray(data.engineers), 'Нужны массивы requests и engineers.');
  check(data.metadata?.routingMode == null || ['geographic', 'address-only'].includes(data.metadata.routingMode), 'Неизвестный режим маршрутизации.');
  const addressOnly = data.metadata?.routingMode === 'address-only';
  for (const [type, items] of Object.entries({ requests: data.requests, engineers: data.engineers })) {
    const ids = new Set();
    for (const item of items) {
      check(item && typeof item.id === 'string' && item.id.trim() && !ids.has(item.id), `${type}: ID должны быть непустыми уникальными строками.`);
      ids.add(item.id);
      if (type === 'requests') {
        if (!addressOnly) point(item.location, `Заявка ${item.id}`);
        check(Number.isInteger(item.durationMinutes) && item.durationMinutes > 0, `${item.id}: длительность — положительное целое число минут.`);
        check(parseTime(item.windowStart) <= parseTime(item.windowEnd), `${item.id}: конец окна раньше начала.`);
        check(SKILLS.includes(item.requiredSkill), `${item.id}: неизвестный навык.`);
        check(item.requiredTransport == null || TRANSPORTS.includes(item.requiredTransport), `${item.id}: неизвестный тип транспорта.`);
        check(['Обычная', 'Срочная'].includes(item.priority), `${item.id}: неизвестный приоритет.`);
      } else {
        if (!addressOnly) point(item.startLocation, `Инженер ${item.id}`);
        check(parseTime(item.shiftStart) < parseTime(item.shiftEnd), `${item.id}: смена должна заканчиваться позже начала в тот же день.`);
        check(Array.isArray(item.skills) && item.skills.length >= 1 && item.skills.length <= 3 &&
          new Set(item.skills).size === item.skills.length && item.skills.every(s => SKILLS.includes(s)), `${item.id}: нужны от 1 до 3 различных навыков из справочника.`);
        check(TRANSPORTS.includes(item.transport), `${item.id}: неизвестный тип транспорта.`);
      }
    }
  }
  return data;
}

export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function context(data, options = {}, frozen = Object.create(null), now = 0, oldAssignments = Object.create(null)) {
  validateData(data);
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  for (const [name, value] of Object.entries(weights)) {
    check(Object.hasOwn(DEFAULT_WEIGHTS, name) && Number.isFinite(value) && value >= 0, `Некорректный вес ${name}.`);
  }
  const roadFactor = options.roadFactor ?? 1.25;
  check(Number.isFinite(roadFactor) && roadFactor >= 1, 'roadFactor должен быть числом не меньше 1.');
  const speeds = { ...SPEEDS, ...options.speeds };
  check(Object.entries(speeds).every(([key, value]) => TRANSPORTS.includes(key) && Number.isFinite(value) && value > 0), 'Скорости должны быть положительными числами для известных типов транспорта.');
  return { data, weights, roadFactor, speeds, frozen, now, oldAssignments,
    requests: new Map(data.requests.map(r => [r.id, r])),
    leg(a, b, engineer) {
      if (data.metadata?.routingMode === 'address-only') return { distanceKm: 0, travelMinutes: 0 };
      const distanceKm = haversineKm(a, b) * roadFactor;
      return { distanceKm, travelMinutes: Math.ceil(distanceKm / speeds[engineer.transport] * 60) };
    },
  };
}
function compatible(request, engineer) {
  return engineer.skills.includes(request.requiredSkill) &&
    (!request.requiredTransport || request.requiredTransport === engineer.transport);
}

/** Re-simulates the WHOLE suffix, so insertion can never silently make later work late. */
function simulate(ctx, engineer, ids) {
  const stops = (ctx.frozen[engineer.id] ?? []).map(clone);
  let time = Math.max(ctx.now, stops.at(-1)?.endMinute ?? parseTime(engineer.shiftStart));
  let location = stops.length ? ctx.requests.get(stops.at(-1).requestId).location : engineer.startLocation;
  const shiftEnd = parseTime(engineer.shiftEnd);
  for (const requestId of ids) {
    const request = ctx.requests.get(requestId);
    if (!compatible(request, engineer)) return null;
    const leg = ctx.leg(location, request.location, engineer);
    const arrivalMinute = time + leg.travelMinutes;
    const startMinute = Math.max(arrivalMinute, parseTime(request.windowStart));
    const endMinute = startMinute + request.durationMinutes;
    if (startMinute > parseTime(request.windowEnd) || endMinute > shiftEnd) return null;
    stops.push({ requestId, departureMinute: time, arrivalMinute, startMinute, endMinute,
      waitingMinutes: startMinute - arrivalMinute, ...leg, locked: false });
    location = request.location;
    time = endMinute;
  }
  return { engineerId: engineer.id, stops };
}

function features(ctx, routes) {
  const stops = routes.flatMap(route => route.stops);
  let changes = 0;
  for (const route of routes) route.stops.forEach((stop, index) => {
    const old = Object.hasOwn(ctx.oldAssignments, stop.requestId) ? ctx.oldAssignments[stop.requestId] : undefined;
    if (old && (old.engineerId !== route.engineerId || old.position !== index)) changes++;
  });
  for (const id of Object.keys(ctx.oldAssignments)) if (!stops.some(s => s.requestId === id)) changes++;
  return {
    personnel: routes.filter(r => r.stops.length).length,
    distance: sum(stops.map(s => s.distanceKm)) / 10,
    travel: sum(stops.map(s => s.travelMinutes)) / 60,
    waiting: sum(stops.map(s => s.waitingMinutes)) / 60,
    balance: sum(routes.map((route, i) => (sum(route.stops.map(s =>
      s.travelMinutes + s.waitingMinutes + ctx.requests.get(s.requestId).durationMinutes)) /
      (parseTime(ctx.data.engineers[i].shiftEnd) - parseTime(ctx.data.engineers[i].shiftStart))) ** 2)),
    versatility: sum(routes.map((route, i) => route.stops.length * (ctx.data.engineers[i].skills.length - 1))),
    stability: changes,
  };
}
function evaluate(ctx, routes) {
  const values = features(ctx, routes);
  const contributions = Object.fromEntries(Object.keys(values).map(key => [key, values[key] * ctx.weights[key]]));
  return { value: sum(Object.values(contributions)), features: values, contributions };
}
function quality(ctx, routes) {
  const stops = routes.flatMap(r => r.stops);
  return { urgent: stops.filter(s => ctx.requests.get(s.requestId).priority === 'Срочная').length,
    assigned: stops.length, score: evaluate(ctx, routes).value };
}
function better(a, b, replanning) {
  if (replanning && a.urgent !== b.urgent) return a.urgent > b.urgent;
  if (a.assigned !== b.assigned) return a.assigned > b.assigned;
  if (a.urgent !== b.urgent) return a.urgent > b.urgent;
  return a.score < b.score - EPS;
}
function emptyState(ctx) {
  return { ids: ctx.data.engineers.map(() => []), routes: ctx.data.engineers.map(e => simulate(ctx, e, [])), decisions: Object.create(null) };
}
function candidates(ctx, state, request, appendOnly = false) {
  const found = [];
  ctx.data.engineers.forEach((engineer, i) => {
    if (!compatible(request, engineer)) return;
    const positions = appendOnly ? [state.ids[i].length] : Array.from({ length: state.ids[i].length + 1 }, (_, j) => j);
    for (const position of positions) {
      const ids = [...state.ids[i]];
      ids.splice(position, 0, request.id);
      const route = simulate(ctx, engineer, ids);
      if (!route) continue;
      const routes = state.routes.map((r, j) => i === j ? route : r);
      found.push({ i, position, ids, route, score: evaluate(ctx, routes).value });
    }
  });
  return found;
}
function place(ctx, state, request, baseline = false) {
  const choices = candidates(ctx, state, request, baseline);
  if (!choices.length) return;
  if (!baseline) choices.sort((a, b) => a.score - b.score || a.i - b.i || a.position - b.position);
  const choice = choices[0];
  const before = evaluate(ctx, state.routes);
  state.ids[choice.i] = choice.ids;
  state.routes[choice.i] = choice.route;
  const after = evaluate(ctx, state.routes);
  state.decisions[request.id] = { feasibleInsertions: choices.length,
    feasibleEngineers: new Set(choices.map(c => c.i)).size, insertionScoreDelta: choice.score - before.value,
    contributions: Object.fromEntries(Object.keys(ctx.weights).map(key => [key, after.contributions[key] - before.contributions[key]])) };
}
function pending(ctx) {
  const locked = new Set(Object.values(ctx.frozen).flat().map(s => s.requestId));
  return ctx.data.requests.filter(r => !locked.has(r.id));
}
function ordered(ctx, requests, strategy) {
  const count = r => ctx.data.engineers.filter(e => compatible(r, e)).length;
  const copy = [...requests];
  if (strategy === 'arrival') return copy;
  return copy.sort((a, b) => {
    const urgent = Number(b.priority === 'Срочная') - Number(a.priority === 'Срочная');
    if (urgent) return urgent;
    if (strategy === 'scarce') return count(a) - count(b) || parseTime(a.windowEnd) - parseTime(b.windowEnd);
    if (strategy === 'short') return a.durationMinutes - b.durationMinutes || parseTime(a.windowEnd) - parseTime(b.windowEnd);
    return parseTime(a.windowEnd) - parseTime(b.windowEnd) || count(a) - count(b);
  });
}
function reason(ctx, state, request) {
  const skilled = ctx.data.engineers.filter(e => e.skills.includes(request.requiredSkill));
  if (!skilled.length) return { code: 'NO_SKILL', text: `Нет инженера с навыком «${request.requiredSkill}».` };
  const eligible = skilled.filter(e => compatible(request, e));
  if (!eligible.length) return { code: 'NO_TRANSPORT', text: `Среди инженеров с нужным навыком нет транспорта «${request.requiredTransport}».` };
  const alone = eligible.some(e => simulate(ctx, e, [request.id]));
  if (!alone) return { code: 'TIME_INFEASIBLE', text: 'С учётом пути, текущего времени и уже начатых выездов работа не укладывается в окно начала или смену даже без остальных будущих заявок.' };
  if (candidates(ctx, state, request).length) return { code: 'PRIORITY_TRADEOFF', text: 'Заявка не вошла в выбранный вариант; другое распределение может позволить её выполнить.' };
  return { code: 'NO_CAPACITY', text: 'В выбранном плане подходящие инженеры заняты: вставка заявки нарушает окно начала или конец смены. Другое распределение может дать иной результат.' };
}
function finish(ctx, state, algorithm, alternatives = []) {
  const addressOnly = ctx.data.metadata?.routingMode === 'address-only';
  const assignments = Object.create(null);
  const routes = state.routes.map((route, i) => {
    const engineer = ctx.data.engineers[i];
    const stops = route.stops.map((stop, position) => {
      const request = ctx.requests.get(stop.requestId);
      const decision = state.decisions[request.id];
      const explanation = [
        `${engineer.name || engineer.id}: есть навык «${request.requiredSkill}».`,
        request.requiredTransport ? `Транспорт «${engineer.transport}» соответствует требованию.` : 'Ограничений по транспорту нет.',
        `Начало ${formatTime(stop.startMinute)} в окне ${request.windowStart}–${request.windowEnd}; окончание ${formatTime(stop.endMinute)} до конца смены ${engineer.shiftEnd}.`,
        stop.locked ? 'Выезд уже начат к моменту события: назначение и время сохранены.' :
          algorithm === 'baseline' ? 'Первый подходящий инженер во входном списке; заявка добавлена в конец маршрута.' :
            `При вставке было допустимо вариантов: ${decision?.feasibleInsertions ?? 1}. Выбран вариант с наименьшей взвешенной оценкой среди проверенных вставок.`,
      ];
      assignments[request.id] = { status: 'assigned', engineerId: engineer.id, position, explanation };
      if (decision && !stop.locked && algorithm !== 'baseline') {
        explanation.push(`Проверено инженеров: ${decision.feasibleEngineers}. Изменение оценки при вставке: ${round(decision.insertionScoreDelta)}; вклад числа исполнителей ${round(decision.contributions.personnel)}, расстояния ${round(decision.contributions.distance)}, времени пути ${round(decision.contributions.travel)}. Меньшая оценка предпочтительнее.`);
      }
      return { ...stop, distanceKm: addressOnly ? null : stop.distanceKm,
        address: request.address ?? '', decision: stop.locked ? stop.decision : decision, location: addressOnly ? null : clone(request.location),
        arrival: formatTime(stop.arrivalMinute), start: formatTime(stop.startMinute), end: formatTime(stop.endMinute), explanation };
    });
    const distanceKm = sum(route.stops.map(s => s.distanceKm));
    return { engineerId: engineer.id, engineerName: engineer.name || engineer.id, transport: engineer.transport,
      startLocation: addressOnly ? null : clone(engineer.startLocation), stops, distanceKm: addressOnly ? null : round(distanceKm),
      travelMinutes: sum(stops.map(s => s.travelMinutes)),
      geometry: addressOnly ? [] : [clone(engineer.startLocation), ...stops.map(s => s.location)],
      explanation: `${addressOnly ? 'Расписание без учёта переездов; выполнимость с реальным временем пути не проверена.' : 'Порядок проверен с учётом пути, ожидания, длительности работ и смены. Возврат на базу не требуется.'} ${algorithm === 'baseline' ? 'Использован порядок назначения.' : 'Сравнивались допустимые позиции вставки и несколько порядков обработки заявок.'}` };
  });
  const unassigned = ctx.data.requests.filter(r => !assignments[r.id]).map(r => {
    const why = reason(ctx, state, r);
    assignments[r.id] = { status: 'unassigned', reason: why };
    return { requestId: r.id, reason: why };
  });
  const objective = evaluate(ctx, state.routes);
  return { algorithm, planningTime: ctx.now, input: clone(ctx.data),
    options: { weights: { ...ctx.weights }, speeds: { ...ctx.speeds }, roadFactor: ctx.roadFactor },
    routes, assignments, unassigned, alternatives,
    metrics: { totalRequests: ctx.data.requests.length, assignedRequests: ctx.data.requests.length - unassigned.length,
      unassignedRequests: unassigned.length, usedEngineers: routes.filter(r => r.stops.length).length,
      totalDistanceKm: addressOnly ? null : round(sum(state.routes.flatMap(r => r.stops.map(s => s.distanceKm)))),
      totalTravelMinutes: addressOnly ? null : sum(routes.map(r => r.travelMinutes)),
      distanceByEngineer: Object.fromEntries(routes.map(r => [r.engineerId, r.distanceKm])) },
    objective, assumptions: ['Время в пределах одного дня; окно ограничивает начало, а не окончание работы.',
      addressOnly ? 'Режим без координат: переезды не учтены в расписании, расстояния неизвестны. Веса расстояния и времени пути не влияют на результат.' : 'Расстояние оценено по координатам с коэффициентом пути; дорожная сеть, пробки и расписания транспорта не учитываются.',
      'Время пути округлено вверх до минуты. Возврат на базу не требуется.',
      'Эвристика не гарантирует глобальный оптимум. При перепланировании сначала сравнивается число срочных, затем общее число назначенных заявок.'],
  };
}
function solve(ctx, baseline = false) {
  const requests = pending(ctx);
  if (baseline) {
    const state = emptyState(ctx);
    requests.forEach(r => place(ctx, state, r, true));
    return finish(ctx, state, 'baseline');
  }
  const variants = ['scarce', 'deadline', 'short', 'arrival'].map(strategy => {
    const state = emptyState(ctx);
    ordered(ctx, requests, strategy).forEach(r => place(ctx, state, r));
    return { strategy, state, quality: quality(ctx, state.routes) };
  });
  // Include the prescribed baseline: a heuristic candidate must earn its advantage.
  const base = emptyState(ctx);
  requests.forEach(r => place(ctx, base, r, true));
  variants.push({ strategy: 'baseline', state: base, quality: quality(ctx, base.routes) });
  const best = variants.reduce((a, b) => better(b.quality, a.quality, ctx.replanning) ? b : a);
  const result = finish(ctx, best.state, best.strategy === 'baseline' ? 'baseline' : 'weighted-insertion',
    variants.map(v => ({ strategy: v.strategy, ...v.quality, selected: v === best })));
  result.selectedStrategy = best.strategy;
  return result;
}

export function plan(data, options = {}) { return solve(context(data, options)); }
export function baselinePlan(data, options = {}) { return solve(context(data, options), true); }
export function comparePlans(data, options = {}) {
  const baseline = baselinePlan(data, options);
  const optimized = plan(data, options);
  return { baseline, optimized, delta: {
    assignedRequests: optimized.metrics.assignedRequests - baseline.metrics.assignedRequests,
    usedEngineers: optimized.metrics.usedEngineers - baseline.metrics.usedEngineers,
    totalDistanceKm: data.metadata?.routingMode === 'address-only' ? null : round(optimized.metrics.totalDistanceKm - baseline.metrics.totalDistanceKm),
  } };
}

/** MVP event: urgent_request. A departed leg and all its work remain committed. */
export function replan(previousPlan, event, options = {}) {
  check(event?.type === 'urgent_request', 'Поддерживается событие urgent_request — новая срочная заявка.');
  const now = parseTime(event.time);
  check(now >= previousPlan.planningTime, 'Событие не может быть раньше предыдущего перепланирования.');
  const data = clone(previousPlan.input);
  const request = { ...clone(event.request ?? {}), priority: 'Срочная' };
  // simulate() enforces now without mutating the original time window.
  data.requests.push(request);
  validateData(data);
  const frozen = Object.create(null);
  for (const route of previousPlan.routes) {
    frozen[route.engineerId] = [];
    for (const stop of route.stops) {
      if (stop.departureMinute >= now) break;
      frozen[route.engineerId].push({ ...clone(stop), locked: true });
    }
  }
  const oldAssignments = Object.fromEntries(Object.entries(previousPlan.assignments).filter(([, a]) => a.status === 'assigned'));
  const ctx = context(data, { ...previousPlan.options, ...options,
    weights: { ...previousPlan.options.weights, ...options.weights },
    speeds: { ...previousPlan.options.speeds, ...options.speeds } }, frozen, now, oldAssignments);
  ctx.replanning = true;
  const result = solve(ctx);
  result.event = clone(event);
  result.changes = data.requests.flatMap(r => {
    const before = Object.hasOwn(previousPlan.assignments, r.id) ? previousPlan.assignments[r.id] : undefined;
    const after = result.assignments[r.id];
    const beforeStop = previousPlan.routes.flatMap(x => x.stops).find(s => s.requestId === r.id);
    const afterStop = result.routes.flatMap(x => x.stops).find(s => s.requestId === r.id);
    const fields = [];
    if (!before) fields.push('new');
    if (before?.status !== after.status) fields.push('status');
    if (before?.engineerId !== after.engineerId) fields.push('engineer');
    if (before?.position !== after.position) fields.push('order');
    if (beforeStop?.startMinute !== afterStop?.startMinute) fields.push('time');
    return fields.length ? [{ requestId: r.id, fields, before: before ? {
      status: before.status, engineerId: before.engineerId, position: before.position, start: beforeStop?.start,
    } : null, after: { status: after.status, engineerId: after.engineerId, position: after.position, start: afterStop?.start } }] : [];
  });
  return result;
}

export function loadJSON(text) { return validateData(JSON.parse(text)); }
