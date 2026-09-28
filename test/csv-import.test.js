import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCSV, parseCSV, parseSourceDate, normalizeCSV, createEnrichmentTemplate, preparePlannerData, matchControl } from '../src/csv-import.js';
import { plan } from '../src/planner.js';

const header = 'Заявка;Тип заявки BK;Тип заявки HD;Начало;Окончание;Район;Адрес;Гигабитное подключение';
const row = '00012;Подключение;Конвергенция абонента;17.08.2026 0:01;17.08.2026 23:59;Район;Адрес дома;Нет';
const config = { fileName: 'sample.csv', regionId: 'east', regionName: 'Восток', kind: 'synthetic' };
const source = (body = `${header}\n${row}`) => normalizeCSV(new TextEncoder().encode(body), config);

test('decode Windows-1251, UTF-8 BOM and explicit encoding', () => {
  const bytes = Uint8Array.from([0xc7, 0xe0, 0xff, 0xe2, 0xea, 0xe0]);
  assert.deepEqual(decodeCSV(bytes), { text: 'Заявка', encoding: 'windows-1251' });
  assert.equal(decodeCSV(new TextEncoder().encode('\uFEFFЗаявка')).text, 'Заявка');
  assert.throws(() => decodeCSV(bytes, 'utf-8'));
});
test('CSV preserves semicolons, multiline quoted values, escaped quotes and line numbers', () => {
  const records = parseCSV('a;b\r\n"x;y";"line1\r\nline2 ""quote"""\r\nlast;value');
  assert.deepEqual(records, [{ line: 1, cells: ['a', 'b'] }, { line: 2, cells: ['x;y', 'line1\nline2 "quote"'] }, { line: 4, cells: ['last', 'value'] }]);
  assert.throws(() => parseCSV('a;"open'));
  assert.throws(() => parseCSV('a;"closed"bad'));
});
test('footer and blank rows never become requests; IDs remain strings', () => {
  const result = source(`${header}\r\n${row}\r\n;;;;;;;\r\n;;;;;;;\r\nАдрес Офиса;Адрес базы;;;;;;\r\n`);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].sourceId, '00012');
  assert.equal(result.requests[0].id, 'east:00012');
  assert.equal(result.offices[0].address, 'Адрес базы');
  assert.equal(result.skippedBlankLines.length, 2);
  assert.equal(result.rejectedRows.length, 0);
  assert.equal(result.requests[0].windowStart, '00:01');
  assert.equal(result.requests[0].durationMinutes, null);
  assert.equal(result.requests[0].priority, null);
  assert.equal(result.requests[0].location, null);
  assert.equal(result.requests[0].source.raw['Начало'], '17.08.2026 0:01');
});
test('bad rows are retained with reasons rather than disappearing', () => {
  const result = source(`${header}\n${row}\n${row}\nbroken;row\n${row.replace('00012', 'other').replace('17.08.2026 0:01', '31.02.2026 0:01')}`);
  assert.equal(result.requests.length, 1);
  assert.equal(result.rejectedRows.length, 3);
  assert.equal(result.rejectedRows[0].raw['Заявка'], '00012');
  assert.throws(() => parseSourceDate('17.08.2026 24:00'));
  assert.throws(() => parseSourceDate('29.02.2025 12:00'));
  assert.equal(parseSourceDate('29.02.2024 12:00').date, '2024-02-29');
});
test('template cannot silently become a runnable scenario', () => {
  const input = source(), template = createEnrichmentTemplate(input);
  const result = preparePlannerData(input, template);
  assert.equal(result.ready, false);
  assert.equal(result.data, null);
  for (const code of ['LOCATION', 'DURATION', 'PRIORITY', 'ENGINEERS', 'TIME_SEMANTICS', 'TRANSPORT_POLICY']) assert(result.issues.some(i => i.code === code));
  assert.deepEqual(template.engineers, []);
});
function completeTemplate(input) {
  const template = createEnrichmentTemplate(input);
  template.confirmedTimeWindowSemantics = true;
  template.confirmedNoTransportRequirements = true;
  template.defaults.priority = 'Обычная';
  template.durationMinutesByTypeHD['Конвергенция абонента'] = 45;
  template.locationsByAddress['Адрес дома'] = { lat: 55.75, lon: 37.61 };
  template.engineers = [{ id: 'test-engineer', startLocation: { lat: 55.75, lon: 37.61 }, shiftStart: '09:00', shiftEnd: '18:00', skills: ['Работы на подключение и дозаказы'], transport: 'Автомобиль' }];
  return template;
}
test('explicit enrichment yields valid planner input without mutating raw source', () => {
  const input = source(), saved = JSON.stringify(input), template = completeTemplate(input);
  const result = preparePlannerData(input, template);
  assert.equal(result.ready, true);
  assert.equal(plan(result.data).metrics.assignedRequests, 1);
  assert.equal(result.data.requests[0].durationMinutes, 45);
  assert.equal(JSON.stringify(input), saved);
});
test('zero duration is not replaced by default; unknown override ID and field are rejected', () => {
  const input = source(), template = completeTemplate(input);
  template.requestOverrides['east:00012'] = { durationMinutes: 0 };
  assert(preparePlannerData(input, template).issues.some(i => i.code === 'DURATION'));
  template.requestOverrides = { missing: { location: {} }, 'east:00012': { windowEnd: '19:00' } };
  const issues = preparePlannerData(input, template).issues;
  assert(issues.some(i => i.code === 'UNKNOWN_ID'));
  assert(issues.some(i => i.code === 'INVALID_OVERRIDE'));
});
test('control linkage uses fields, not row order or input IDs; ambiguity is visible', () => {
  const input = source();
  const control = { ...source(), kind: 'control', requests: [
    { ...source().requests[0], id: 'east:control:123', address: 'Адрес дома, кв. 99' },
  ] };
  assert.equal(matchControl(input, control).links[0].status, 'unique-candidate');
  control.requests.push({ ...control.requests[0], id: 'east:control:456' });
  assert.equal(matchControl(input, control).links[0].status, 'ambiguous');
  assert.throws(() => createEnrichmentTemplate(control));
});
test('unmapped work type and multiple days cannot silently pass preparation', () => {
  const input = source(`${header}\n${row.replace('Подключение', 'Неизвестный тип')}\n${row.replace('00012', '00013').replaceAll('17.08.2026', '18.08.2026')}`);
  assert.equal(input.requests[0].requiredSkill, null);
  const result = preparePlannerData(input, completeTemplate(input));
  assert(result.issues.some(i => i.code === 'MULTIPLE_DATES'));
  assert(result.issues.some(i => i.code === 'SKILL'));
});
test('duplicate control IDs preserve both records with distinct technical IDs', () => {
  const controlHeader = `${header};Бригада;Статус BK`;
  const controlRow = `${row};Бригада 1;Отменена`;
  const result = normalizeCSV(new TextEncoder().encode(`${controlHeader}\n${controlRow}\n${controlRow.replace('Адрес дома', 'Другой адрес')}`), { ...config, kind: 'control' });
  assert.equal(result.requests.length, 2);
  assert.equal(result.rejectedRows.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.notEqual(result.requests[0].id, result.requests[1].id);
  assert.equal(result.requests[0].sourceId, result.requests[1].sourceId);
  assert.equal(result.requests[0].control.status, 'Отменена');
});
