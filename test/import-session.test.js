import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveImport, inspectWorkspace, identifyJSON } from '../src/import-session.js';
import { createEnrichmentTemplate } from '../src/csv-import.js';

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

// Full route tests use explicit small fixtures in planner.test.js.
// CSV integration tests never invent missing engineers, durations or coordinates.

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
