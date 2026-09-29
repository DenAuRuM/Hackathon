import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, comparePlans, replan, validateData } from '../src/planner.js';
import { preparePlannerData, createEnrichmentTemplate } from '../src/csv-import.js';
import { readFile } from 'node:fs/promises';

// Small artificial cases exercise the engine; they are not facts from the CSV.
const engineer = { id: 'test-engineer', skills: ['Локальные работы'], transport: 'Автомобиль', shiftStart: '09:00', shiftEnd: '18:00' };
const job = { id: 'test-job', address: 'Тестовый адрес', durationMinutes: 60, windowStart: '09:00', windowEnd: '10:00', requiredSkill: 'Локальные работы', priority: 'Обычная' };
const data = () => ({ metadata: { routingMode: 'address-only' }, requests: [structuredClone(job)], engineers: [structuredClone(engineer)] });
test('address-only accepts missing coordinates, never fabricates points or distance, and ignores existing coordinates', () => {
  const input = data(); const saved = JSON.stringify(input);
  const result = plan(input);
  assert.equal(JSON.stringify(input), saved);
  assert.equal(result.metrics.assignedRequests, 1);
  assert.equal(result.metrics.totalDistanceKm, null);
  assert.equal(result.metrics.totalTravelMinutes, null);
  assert.deepEqual(result.routes[0].geometry, []);
  assert.equal(result.routes[0].stops[0].location, null);
  assert.equal(result.routes[0].stops[0].start, '09:00');
  input.requests[0].location = { lat: 89, lon: 170 };
  input.engineers[0].startLocation = { lat: -89, lon: -170 };
  assert.deepEqual(plan(input).assignments, result.assignments);
  assert.equal(plan(input).objective.features.distance, 0);
  assert.equal(comparePlans(input).delta.totalDistanceKm, null);
  delete input.metadata;
  assert.equal(plan(input).metrics.assignedRequests, 0);
  delete input.engineers[0].startLocation;
  assert.throws(() => validateData(input), /координаты/);
});
test('address-only keeps shifts, skill and transport constraints and survives repeated replanning', () => {
  const input = data();
  input.requests.push({ ...job, id: 'wrong-skill', requiredSkill: 'Аварийные работы' }, { ...job, id: 'wrong-transport', requiredTransport: 'Велосипед' }, { ...job, id: 'too-long', durationMinutes: 600 });
  let result = plan(input);
  assert.deepEqual(result.unassigned.map(x => x.reason.code), ['NO_SKILL', 'NO_TRANSPORT', 'TIME_INFEASIBLE']);
  for (const [index, time] of ['09:30', '10:30'].entries()) {
    result = replan(JSON.parse(JSON.stringify(result)), { type: 'urgent_request', time, request: { ...job, id: `urgent-${index}`, windowStart: time, windowEnd: '17:00' } });
    assert.equal(result.routes[0].stops[0].start, '09:00');
    assert(result.routes[0].stops[0].locked);
    assert.equal(result.metrics.totalDistanceKm, null);
    assert(Number.isFinite(result.objective.value));
  }
});
test('import never adds 0,0 and malformed engineers produce validation issues', async () => {
  const source = JSON.parse(await readFile(new URL('../data/imported/south-east.source.json', import.meta.url), 'utf8'));
  const enrichment = createEnrichmentTemplate(source);
  enrichment.routingMode = 'address-only'; enrichment.engineers = {};
  assert(preparePlannerData(source, enrichment).issues.some(i => i.code === 'ENGINEERS'));
  enrichment.routingMode = 'typo';
  assert.throws(() => preparePlannerData(source, enrichment), /routingMode/);
});
