import { readFile } from 'node:fs/promises';
import { comparePlans, replan } from './src/planner.js';

const data = JSON.parse(await readFile(new URL('./data/demo.json', import.meta.url), 'utf8'));
const comparison = comparePlans(data);
console.log('Базовый план:', comparison.baseline.metrics);
console.log('Взвешенные эвристики:', comparison.optimized.metrics);
console.log('Неназначенные:', comparison.optimized.unassigned);
const updated = replan(comparison.optimized, {
  type: 'urgent_request', time: '10:00',
  request: { id: 'urgent-1', location: { lat: 55.753, lon: 37.63 }, durationMinutes: 40,
    windowStart: '10:00', windowEnd: '11:30', requiredSkill: 'Аварийные работы' },
});
console.log('После срочной заявки:', updated.metrics);
console.log('Изменения:', updated.changes);
