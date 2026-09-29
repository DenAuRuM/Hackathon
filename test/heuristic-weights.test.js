import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, replan, DEFAULT_WEIGHTS, SKILLS } from '../src/planner.js';
// Deliberately small artificial alternatives: isolates each weight's causal effect.
const zero = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(k => [k, 0]));
const p = { lat: 55.75, lon: 37.61 };
const engineer = (id, more = {}) => ({ id, startLocation: p, skills: [SKILLS[0]], transport: 'Автомобиль', shiftStart: '09:00', shiftEnd: '18:00', ...more });
const job = (id, more = {}) => ({ id, location: p, requiredSkill: SKILLS[0], priority: 'Обычная', durationMinutes: 60, windowStart: '09:00', windowEnd: '17:00', ...more });
const weighted = (data, weights) => {
  const result = plan(data, { weights: { ...zero, ...weights } });
  const total = Object.values(result.objective.contributions).reduce((a, b) => a + b, 0);
  assert.equal(result.objective.value, total);
  return result;
};
test('within UI range: personnel concentrates work, balance spreads it without losing requests', () => {
  const data = { engineers: [engineer('a'), engineer('b')], requests: [job('one'), job('two')] };
  const compact = weighted(data, { personnel: 20 });
  const balanced = weighted(data, { balance: 20 });
  assert.equal(compact.metrics.assignedRequests, 2); assert.equal(balanced.metrics.assignedRequests, 2);
  assert.equal(compact.metrics.usedEngineers, 1); assert.equal(balanced.metrics.usedEngineers, 2);
  assert(balanced.objective.features.balance < compact.objective.features.balance);
});
test('waiting chooses a shift closer to the window and versatility preserves multi-skilled staff', () => {
  const data = { engineers: [engineer('early'), engineer('late', { shiftStart: '10:00' })], requests: [job('one', { windowStart: '10:00' })] };
  assert.equal(weighted(data, {}).assignments.one.engineerId, 'early');
  assert.equal(weighted(data, { waiting: 20 }).assignments.one.engineerId, 'late');
  data.engineers = [engineer('universal', { skills: SKILLS }), engineer('specialist')];
  assert.equal(weighted(data, {}).assignments.one.engineerId, 'universal');
  assert.equal(weighted(data, { versatility: 20 }).assignments.one.engineerId, 'specialist');
});
test('distance chooses nearby start and travel chooses faster transport at equal distance', () => {
  const data = { engineers: [engineer('far', { startLocation: { lat: 55.8, lon: 37.8 } }), engineer('near')], requests: [job('one')] };
  assert.equal(weighted(data, {}).assignments.one.engineerId, 'far');
  assert.equal(weighted(data, { distance: 20 }).assignments.one.engineerId, 'near');
  data.engineers = [engineer('walk', { transport: 'Пешеход' }), engineer('car')];
  data.requests[0].location = { lat: 55.76, lon: 37.63 };
  assert.equal(weighted(data, {}).assignments.one.engineerId, 'walk');
  assert.equal(weighted(data, { travel: 20 }).assignments.one.engineerId, 'car');
});
test('stability preserves future assignments when an urgent request arrives', () => {
  const data = { engineers: [engineer('universal', { skills: SKILLS }), engineer('specialist')], requests: [job('one')] };
  const previous = weighted(data, { versatility: 20 });
  const event = { type: 'urgent_request', time: '08:00', request: job('urgent') };
  const changed = replan(previous, event, { weights: zero });
  const stable = replan(previous, event, { weights: { ...zero, stability: 20 } });
  assert.equal(changed.assignments.one.engineerId, 'universal');
  assert.equal(stable.assignments.one.engineerId, 'specialist');
  assert(stable.objective.features.stability < changed.objective.features.stability);
  assert.equal(stable.metrics.assignedRequests, changed.metrics.assignedRequests);
});
