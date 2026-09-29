import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveImport, inspectWorkspace, identifyJSON } from '../src/import-session.js';
import { createEnrichmentTemplate } from '../src/csv-import.js';
import { plan, baselinePlan, replan, parseTime, haversineKm, SKILLS } from '../src/planner.js';

const read = async name => JSON.parse(await readFile(new URL(`../data/imported/${name}`, import.meta.url), 'utf8'));
const source = await read('south-east.source.json');
const matching = await read('south-east.matching.json');
const loadRegion = async region => { assert.equal(region, 'south-east'); return source; };

test('legacy south-east.matching opens 83 real requests and identifies missing data without fabricating a plan', async () => {
  const result = await resolveImport([matching], { loadRegion });
  assert.equal(result.source.requests.length, 83);
  assert.equal(result.matching.links.filter(x => x.status === 'ambiguous').length, 4);
  assert.equal(result.ready, false); assert.equal(result.data, null);
  assert.equal(result.issues.filter(x => x.code === 'LOCATION').length, 83);
  assert.equal(result.issues.filter(x => x.code === 'DURATION').length, 83);
  assert(result.source.requests.every(r => r.location === null && r.durationMinutes === null));
});
test('source and enrichment may be selected together; workspace round-trip keeps all data', async () => {
  const enrichment = createEnrichmentTemplate(source);
  const result = await resolveImport([enrichment, matching, source]);
  const restored = await resolveImport([JSON.parse(JSON.stringify({ schemaVersion: 'dispatcher-workspace-v1', source, matching, enrichment }))]);
  assert.deepEqual(restored.source, result.source);
  assert.deepEqual(restored.issues, result.issues);
  const separately = await resolveImport([enrichment], { existing: result });
  assert.deepEqual(separately.matching, matching);
});
test('mixed regions, duplicate links and unsupported reports are rejected explicitly', async () => {
  const other = await read('east.source.json');
  await assert.rejects(resolveImport([matching, other]), /разных районов/);
  const broken = structuredClone(matching); broken.links[1] = broken.links[0];
  await assert.rejects(resolveImport([broken, source]), /составом заявок/);
  await assert.rejects(resolveImport([{ schemaVersion: 'dispatcher-import-report-v1' }]), /Неизвестный JSON/);
  assert.equal(identifyJSON(null), 'unknown');
});
test('matching from arbitrary paths cannot trigger network lookup outside known regions', async () => {
  let called = false;
  const unknown = { links: [{ requestId: '../../private:1' }], controlWithoutUniqueMatch: [] };
  await assert.rejects(resolveImport([unknown], { loadRegion: () => { called = true; } }), /Не найден/);
  assert.equal(called, false);
});

// TEST-ONLY fixtures: these invented fields never leave this test or alter imported JSON.
function completeForTest(input) {
  const enrichment = createEnrichmentTemplate(input);
  enrichment.confirmedTimeWindowSemantics = true;
  enrichment.confirmedNoTransportRequirements = true;
  enrichment.defaults.priority = 'Обычная';
  Object.keys(enrichment.durationMinutesByTypeHD).forEach((key, i) => { enrichment.durationMinutesByTypeHD[key] = 30 + (i % 3) * 30; });
  Object.keys(enrichment.locationsByAddress).forEach((key, i) => { enrichment.locationsByAddress[key] = { lat: 55.6 + (i % 10) * .007, lon: 37.6 + Math.floor(i / 10) * .009 }; });
  enrichment.engineers = Array.from({ length: 12 }, (_, i) => ({ id: `test-only-${i}`, startLocation: { lat: 55.6, lon: 37.6 },
    shiftStart: '09:00', shiftEnd: '23:00', skills: [SKILLS[i % 3]], transport: i % 2 ? 'Автомобиль' : 'Велосипед' }));
  return inspectWorkspace(input, enrichment, matching).data;
}
function verify(result) {
  const byId = new Map(result.input.requests.map(r => [r.id, r]));
  const seen = new Set(); let totalKm = 0, travelSum = 0;
  for (const route of result.routes) {
    const engineer = result.input.engineers.find(e => e.id === route.engineerId);
    let lastEnd = parseTime(engineer.shiftStart), location = engineer.startLocation, km = 0;
    for (const stop of route.stops) {
      assert(!seen.has(stop.requestId)); seen.add(stop.requestId);
      const request = byId.get(stop.requestId); assert(request);
      assert(engineer.skills.includes(request.requiredSkill));
      assert(!request.requiredTransport || request.requiredTransport === engineer.transport);
      const leg = haversineKm(location, request.location) * result.options.roadFactor;
      const minutes = Math.ceil(leg / result.options.speeds[engineer.transport] * 60);
      assert.equal(stop.travelMinutes, minutes);
      assert(stop.departureMinute >= lastEnd);
      if (!stop.locked) assert(stop.departureMinute >= result.planningTime);
      assert.equal(stop.arrivalMinute, stop.departureMinute + minutes);
      assert.equal(stop.startMinute, Math.max(stop.arrivalMinute, parseTime(request.windowStart)));
      assert(stop.startMinute <= parseTime(request.windowEnd));
      assert.equal(stop.endMinute, stop.startMinute + request.durationMinutes);
      assert(stop.endMinute <= parseTime(engineer.shiftEnd));
      assert.equal(result.assignments[request.id].engineerId, engineer.id);
      lastEnd = stop.endMinute; location = request.location; km += leg; travelSum += minutes;
    }
    assert(Math.abs(route.distanceKm - km) <= .00501); totalKm += km;
  }
  assert.equal(seen.size, result.metrics.assignedRequests);
  assert.equal(result.metrics.usedEngineers, result.routes.filter(r => r.stops.length).length);
  assert.equal(result.metrics.totalTravelMinutes, travelSum);
  assert(Math.abs(totalKm - result.metrics.totalDistanceKm) <= .00501);
  for (const item of result.unassigned) { assert(!seen.has(item.requestId)); assert(byId.has(item.requestId)); seen.add(item.requestId); assert(item.reason.text); }
  assert.equal(seen.size, byId.size);
}
test('83 source windows: baseline, weighted plans and repeated urgent replanning satisfy all constraints', () => {
  const input = completeForTest(source); const saved = JSON.stringify(source);
  const baseline = baselinePlan(input); verify(baseline);
  for (const weights of [{}, { personnel: 0, distance: 20 }, { personnel: 20, distance: 0 }]) {
    const result = plan(input, { weights }); verify(result);
    assert(result.metrics.assignedRequests >= baseline.metrics.assignedRequests);
    const urgent = { id: 'test-only-urgent', location: { lat: 55.62, lon: 37.61 }, durationMinutes: 40,
      windowStart: '12:00', windowEnd: '14:00', requiredSkill: SKILLS[2] };
    const updated = replan(result, { type: 'urgent_request', time: '12:00', request: urgent }); verify(updated);
    for (const route of result.routes) for (const stop of route.stops.filter(s => s.departureMinute < 720)) {
      const kept = updated.routes.find(r => r.engineerId === route.engineerId).stops.find(s => s.requestId === stop.requestId);
      assert(kept?.locked); assert.equal(kept.startMinute, stop.startMinute); assert.equal(kept.endMinute, stop.endMinute);
    }
    const second = replan(updated, { type: 'urgent_request', time: '14:00', request: { ...urgent, id: 'test-only-urgent-2', windowStart: '14:00', windowEnd: '16:00' } }); verify(second);
  }
  assert.equal(JSON.stringify(source), saved);
  assert(source.requests.every(r => r.location === null));
});

 test('opening south-east source replaces south-center workspace without retaining matching or fabricating fields', async () => {
 const previous = await resolveImport([await read('south-center.source.json'), await read('south-center.matching.json')]);
 const result = await resolveImport([source], {existing: previous, loadRegion: () => { throw new Error('Source import must not fetch a different dataset'); }});
 assert.equal(result.source.regionId, 'south-east');
 assert.equal(result.source.regionName, 'Юго-восток');
 assert.equal(result.source.requests.length, 83);
 assert.equal(result.matching, null);
 assert.equal(result.note, '');
 assert.equal(result.ready, false);
 for (const code of ['LOCATION', 'DURATION', 'PRIORITY', 'TRANSPORT_POLICY']) assert.equal(result.issues.filter(i => i.code === code).length, 83);
 assert.equal(result.enrichment.engineers.length, 0);
 });
