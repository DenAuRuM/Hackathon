import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, baselinePlan, comparePlans, replan, parseTime, validateData, haversineKm } from '../src/planner.js';

const p = { lat: 55.75, lon: 37.61 };
const engineer = (id = 'e1', more = {}) => ({ id, name: id, startLocation: p, shiftStart: '09:00', shiftEnd: '18:00', skills: ['Локальные работы'], transport: 'Автомобиль', ...more });
const request = (id = 'r1', more = {}) => ({ id, location: p, durationMinutes: 30, windowStart: '09:00', windowEnd: '17:30', priority: 'Обычная', requiredSkill: 'Локальные работы', ...more });

function assertFeasible(result) {
  const data = result.input;
  const seen = new Set();
  for (const route of result.routes) {
    const e = data.engineers.find(e => e.id === route.engineerId);
    let end = parseTime(e.shiftStart);
    let location = e.startLocation;
    let km = 0;
    for (const stop of route.stops) {
      const r = data.requests.find(r => r.id === stop.requestId);
      assert(!seen.has(r.id)); seen.add(r.id);
      assert(e.skills.includes(r.requiredSkill));
      assert(!r.requiredTransport || r.requiredTransport === e.transport);
      const distance = haversineKm(location, r.location) * result.options.roadFactor;
      const travel = Math.ceil(distance / result.options.speeds[e.transport] * 60);
      assert(stop.departureMinute >= end);
      assert(stop.arrivalMinute >= end + travel);
      assert(stop.startMinute >= stop.arrivalMinute);
      assert(stop.startMinute >= parseTime(r.windowStart));
      assert(stop.startMinute <= parseTime(r.windowEnd));
      assert.equal(stop.endMinute, stop.startMinute + r.durationMinutes);
      assert(stop.endMinute <= parseTime(e.shiftEnd));
      if (!stop.locked) assert(stop.departureMinute >= result.planningTime);
      km += distance; location = r.location; end = stop.endMinute;
    }
    assert(Math.abs(km - route.distanceKm) <= 0.00501);
  }
  assert.equal(seen.size, result.metrics.assignedRequests);
  assert.equal(seen.size + result.unassigned.length, data.requests.length);
  for (const u of result.unassigned) { assert(!seen.has(u.requestId)); assert(u.reason.text); }
}

test('empty input and no engineers produce explicit output', () => {
  assert.equal(plan({ requests: [], engineers: [] }).metrics.usedEngineers, 0);
  assert.equal(plan({ requests: [request()], engineers: [] }).unassigned[0].reason.code, 'NO_SKILL');
});
test('skill and transport constraints have separate explanations', () => {
  const result = plan({ engineers: [engineer()], requests: [
    request('skill', { requiredSkill: 'Аварийные работы' }),
    request('transport', { requiredTransport: 'Пешеход' }),
  ] });
  assert.deepEqual(result.unassigned.map(x => x.reason.code), ['NO_SKILL', 'NO_TRANSPORT']);
});
test('window limits START, exact boundaries are inclusive; return trip is unnecessary', () => {
  const result = plan({ engineers: [engineer()], requests: [request('r', { windowStart: '17:30', windowEnd: '17:30' })] });
  assert.equal(result.routes[0].stops[0].end, '18:00');
  assertFeasible(result);
});
test('travel and duration must fit shift', () => {
  const result = plan({ engineers: [engineer()], requests: [request('late', { durationMinutes: 31, windowStart: '17:30', windowEnd: '17:30' })] });
  assert.equal(result.unassigned[0].reason.code, 'TIME_INFEASIBLE');
  const far = plan({ engineers: [engineer()], requests: [request('far', { location: { lat: 59, lon: 30 }, windowEnd: '09:05' })] });
  assert.equal(far.metrics.assignedRequests, 0);
});
test('baseline follows input order and appends without global optimization', () => {
  const data = { engineers: [engineer('first'), engineer('second')], requests: [
    request('late', { windowStart: '12:00' }), request('early', { windowEnd: '10:00' }),
  ] };
  const base = baselinePlan(data);
  assert.equal(base.assignments.late.engineerId, 'first');
  assert.equal(base.assignments.early.engineerId, 'second');
  const optimized = plan(data);
  assert.equal(optimized.metrics.usedEngineers, 1);
  assert.deepEqual(optimized.routes[0].stops.map(s => s.requestId), ['early', 'late']);
  assertFeasible(optimized);
});
test('inserting work rechecks later deadlines', () => {
  const result = plan({ engineers: [engineer()], requests: [
    request('fixed', { windowStart: '09:30', windowEnd: '09:30' }),
    request('long', { durationMinutes: 90, windowStart: '09:00', windowEnd: '09:00' }),
  ] });
  assert.equal(result.metrics.assignedRequests, 1);
  assertFeasible(result);
});
test('weights really change personnel vs distance tradeoff', () => {
  const east = { lat: 55.75, lon: 37.81 };
  const data = { engineers: [engineer('west'), engineer('east', { startLocation: east })],
    requests: [request('west-job'), request('east-job', { location: east })] };
  const personnel = plan(data, { weights: { personnel: 100, distance: 0, travel: 0, waiting: 0, balance: 0, versatility: 0 } });
  const distance = plan(data, { weights: { personnel: 0, distance: 100, travel: 0, waiting: 0, balance: 0, versatility: 0 } });
  assert.equal(personnel.metrics.usedEngineers, 1);
  assert.equal(distance.metrics.usedEngineers, 2);
  assert(distance.metrics.totalDistanceKm < personnel.metrics.totalDistanceKm);
});
test('urgent event preserves departed legs, rebuilds future, and records changes', () => {
  const data = { engineers: [engineer()], requests: [
    request('in-progress', { durationMinutes: 60, windowEnd: '09:00' }),
    request('future', { windowStart: '10:00' }),
  ] };
  const previous = plan(data);
  const saved = JSON.stringify(previous);
  const updated = replan(previous, { type: 'urgent_request', time: '09:15',
    request: request('urgent', { windowStart: '09:15', windowEnd: '10:00' }) });
  assert.equal(JSON.stringify(previous), saved);
  assert.equal(updated.routes[0].stops[0].requestId, 'in-progress');
  assert.equal(updated.routes[0].stops[0].start, '09:00');
  assert(updated.routes[0].stops[0].locked);
  assert.equal(updated.assignments.urgent.status, 'assigned');
  assert(updated.changes.some(c => c.requestId === 'future' && c.fields.includes('time')));
  assertFeasible(updated);
});
test('engineer travelling at event is committed to destination', () => {
  const previous = plan({ engineers: [engineer()], requests: [request('far', { location: { lat: 55.8, lon: 37.8 } })] });
  const updated = replan(previous, { type: 'urgent_request', time: '09:01', request: request('urgent', { windowEnd: '12:00' }) });
  assert.equal(updated.routes[0].stops[0].requestId, 'far');
  assert(updated.routes[0].stops[0].locked);
  assertFeasible(updated);
});
test('urgent work wins over more ordinary work during replanning', () => {
  const data = { engineers: [engineer('e', { shiftStart: '10:00', shiftEnd: '11:00' })],
    requests: [request('a', { windowStart: '10:00', windowEnd: '10:30' }), request('b', { windowStart: '10:00', windowEnd: '10:30' })] };
  const updated = replan(plan(data), { type: 'urgent_request', time: '09:30',
    request: request('urgent', { durationMinutes: 60, windowStart: '10:00', windowEnd: '10:00' }) });
  assert.equal(updated.assignments.urgent.status, 'assigned');
  assert.equal(updated.metrics.assignedRequests, 1);
  assertFeasible(updated);
});
test('expired urgent request is unassigned instead of causing invalid input', () => {
  const updated = replan(plan({ engineers: [engineer()], requests: [] }), {
    type: 'urgent_request', time: '12:00', request: request('expired', { windowEnd: '11:00' }),
  });
  assert.equal(updated.unassigned[0].reason.code, 'TIME_INFEASIBLE');
});
test('invalid data, weights, duplicate IDs, event type and backwards time are rejected', () => {
  assert.throws(() => parseTime('24:00'));
  assert.throws(() => validateData({ engineers: [engineer()], requests: [request(), request()] }));
  assert.throws(() => plan({ engineers: [engineer()], requests: [] }, { weights: { distance: -1 } }));
  assert.throws(() => plan({ engineers: [engineer()], requests: [request('x', { location: null })] }));
  const initial = plan({ engineers: [engineer()], requests: [] });
  assert.throws(() => replan(initial, { type: 'cancel', time: '10:00' }));
  const updated = replan(initial, { type: 'urgent_request', time: '10:00', request: request() });
  assert.throws(() => replan(updated, { type: 'urgent_request', time: '09:00', request: request('second') }));
});
test('repeat events survive JSON serialization and preserve exact travelled distances', () => {
  const previous = plan({ engineers: [engineer()], requests: [
    request('far', { location: { lat: 55.76, lon: 37.63 }, durationMinutes: 80 }),
  ] });
  const first = replan(JSON.parse(JSON.stringify(previous)), { type: 'urgent_request', time: '09:10', request: request('u1') });
  const second = replan(JSON.parse(JSON.stringify(first)), { type: 'urgent_request', time: '10:00', request: request('u2') });
  assert.equal(second.routes[0].stops[0].distanceKm, previous.routes[0].stops[0].distanceKm);
  assert.equal(second.routes[0].stops[0].endMinute, previous.routes[0].stops[0].endMinute);
  assertFeasible(first); assertFeasible(second);
});
test('arbitrary string IDs cannot interfere with object dictionaries', () => {
  const result = plan({ engineers: [engineer('__proto__')], requests: [request('constructor'), request('__proto__')] });
  assert.equal(result.metrics.assignedRequests, 2);
  const updated = replan(result, { type: 'urgent_request', time: '09:10', request: request('toString') });
  assert.equal(updated.assignments.toString.status, 'assigned');
  assertFeasible(updated);
});
test('waiting is included and event cannot move a free engineer before current time', () => {
  const previous = plan({ engineers: [engineer()], requests: [] });
  const updated = replan(previous, { type: 'urgent_request', time: '12:00', request: request('u', { windowStart: '13:00' }) });
  const stop = updated.routes[0].stops[0];
  assert.equal(stop.departureMinute, 720);
  assert.equal(stop.waitingMinutes, 60);
  assert.equal(stop.start, '13:00');
  assertFeasible(updated);
});
test('deterministic random scenarios: feasibility, accounting, baseline coverage and input immutability', () => {
  let seed = 42;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let iteration = 0; iteration < 40; iteration++) {
    const data = { engineers: [engineer('a'), engineer('b', { transport: 'Велосипед' })],
      requests: Array.from({ length: 12 }, (_, i) => request(`r${i}`, {
        location: { lat: 55.7 + random() * .1, lon: 37.55 + random() * .15 },
        durationMinutes: 10 + Math.floor(random() * 100),
        windowStart: `${String(9 + Math.floor(random() * 4)).padStart(2, '0')}:00`,
        windowEnd: `${14 + Math.floor(random() * 4)}:00`,
      })) };
    const saved = JSON.stringify(data);
    const { optimized, baseline } = comparePlans(data);
    assertFeasible(optimized); assertFeasible(baseline);
    assert(optimized.metrics.assignedRequests >= baseline.metrics.assignedRequests);
    assert.equal(JSON.stringify(data), saved);
    assert.deepEqual(plan(data), optimized);
  }
});
