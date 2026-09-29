import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { normalizeCSV, createEnrichmentTemplate, preparePlannerData, matchControl } from '../src/csv-import.js';

// Byte-for-byte copies of the six supplied CSV files, not generated fixtures.
const directory = new URL('./fixtures/csv/', import.meta.url);
const names = await readdir(directory);
for (const [id, name, count] of [['east', 'Восток', 66], ['south-east', 'Юго-восток', 83], ['south-center', 'Югоцентр', 56]]) {
  test(`${name}: original CSV -> JSON preserves all requests and control records`, async () => {
    const parsed = {};
    for (const kind of ['synthetic', 'control']) {
      const label = kind === 'synthetic' ? 'Синтетические данные' : 'Контрольное распределение';
      const fileName = names.find(file => file.startsWith(`${name} ${label}`));
      const bytes = await readFile(new URL(fileName, directory));
      parsed[kind] = normalizeCSV(bytes, { fileName, kind, regionId: id, regionName: name });
      const exported = JSON.parse(await readFile(new URL(`../data/imported/${id}.${kind === 'synthetic' ? 'source' : 'control'}.json`, import.meta.url), 'utf8'));
      assert.deepEqual(parsed[kind], exported);
      assert.equal(parsed[kind].requests.length, count);
      assert.equal(parsed[kind].rejectedRows.length, 0);
      for (const request of parsed[kind].requests) {
        assert.equal(request.sourceId, request.source.raw['Заявка']);
        assert.equal(request.address, request.source.raw['Адрес']);
        assert.equal(request.typeHD, request.source.raw['Тип заявки HD']);
        assert.equal(request.location, null);
        assert.equal(request.durationMinutes, null);
      }
    }
    const matching = JSON.parse(await readFile(new URL(`../data/imported/${id}.matching.json`, import.meta.url), 'utf8'));
    assert.deepEqual(matchControl(parsed.synthetic, parsed.control), matching);
    const enrichment = createEnrichmentTemplate(parsed.synthetic);
    const geographic = preparePlannerData(parsed.synthetic, enrichment);
    assert.equal(geographic.ready, false);
    assert.equal(geographic.issues.filter(i => i.code === 'LOCATION').length, count);
    enrichment.routingMode = 'address-only';
    const addressOnly = preparePlannerData(parsed.synthetic, enrichment);
    assert.equal(addressOnly.ready, false);
    assert.equal(addressOnly.data, null);
    assert.equal(addressOnly.issues.filter(i => i.code === 'LOCATION').length, 0);
    assert.equal(addressOnly.issues.filter(i => i.code === 'DURATION').length, count);
    assert(addressOnly.issues.filter(i => i.code === 'DURATION').every(i => i.typeHD && i.message.includes(i.typeHD)));
    assert(addressOnly.issues.some(i => i.code === 'ENGINEERS'));
    assert.deepEqual(enrichment.engineers, []);
  });
}
