import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { normalizeCSV, createEnrichmentTemplate, matchControl, preparePlannerData } from '../src/csv-import.js';

const inputDirectory = resolve(process.argv[2] || '../Обезличивание');
const outputDirectory = resolve(process.argv[3] || 'data/imported');
const regions = [
  { id: 'east', name: 'Восток' },
  { id: 'south-east', name: 'Юго-восток' },
  { id: 'south-center', name: 'Югоцентр' },
];
const countBy = (rows, key) => {
  const counts = new Map();
  for (const row of rows) { const value = key(row) ?? '(не указано)'; counts.set(value, (counts.get(value) ?? 0) + 1); }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b, 'ru')));
};
const writeJSON = async (name, value) => writeFile(join(outputDirectory, name), JSON.stringify(value, null, 2) + '\n', 'utf8');

try {
  const names = await readdir(inputDirectory);
  const results = [];
  for (const region of regions) {
    const sources = {};
    for (const kind of ['synthetic', 'control']) {
      const label = kind === 'synthetic' ? 'Синтетические данные' : 'Контрольное распределение';
      const matches = names.filter(name => name.startsWith(`${region.name} ${label}`) && name.toLowerCase().endsWith('.csv'));
      if (matches.length !== 1) throw new Error(`${region.name}: ожидался один файл «${label}», найдено ${matches.length}.`);
      const name = matches[0];
      sources[kind] = normalizeCSV(await readFile(join(inputDirectory, name)), {
        fileName: name, regionId: region.id, regionName: region.name, kind,
      });
    }
    const template = createEnrichmentTemplate(sources.synthetic);
    const matching = matchControl(sources.synthetic, sources.control);
    const readiness = preparePlannerData(sources.synthetic, template);
    results.push({ region, ...sources, template, matching, readiness });
  }
  // All files have been read before creating output. The originals are never written.
  await mkdir(outputDirectory, { recursive: true });
  await writeJSON('engineer.template.json', {
    id: null, name: null, startLocation: { lat: null, lon: null }, shiftStart: null, shiftEnd: null,
    skills: [], transport: null,
  });
  const summary = { schemaVersion: 'dispatcher-import-report-v1',
    totalSyntheticRequests: 0, totalControlRequests: 0, totalRejectedRows: 0,
    notes: [
      'Синтетические заявки — вход для будущего планирования. Контроль — отдельный источник сравнения.',
      'В контрольных файлах сохранены все статусы, в том числе Выполнена и Отменена; они не переносятся в синтетический сценарий.',
      'ID синтетических и контрольных заявок отличаются. Сопоставление выполняется по признакам, не по номеру строки.',
      'Бригада в контрольном файле не доказывает число людей, их квалификацию, транспорт, смену или доступность.',
      'Временные окна — трактовка адаптера, которую необходимо подтвердить. Длительность не вычисляется из размера окна.',
      'Подключение FMC и гигабитный признак сохранены; они не превращаются в ограничения транспорта или оборудования.',
      'Входные CSV и исходные значения сохранены без изменений. Исходные поля каждой заявки доступны в source.raw.',
    ], regions: [] };
  for (const result of results) {
    const { region, synthetic, control, template, matching, readiness } = result;
    await writeJSON(`${region.id}.source.json`, synthetic);
    await writeJSON(`${region.id}.control.json`, control);
    await writeJSON(`${region.id}.enrichment.template.json`, template);
    await writeJSON(`${region.id}.matching.json`, matching);
    const counts = countBy(matching.links, r => r.status);
    const detail = {
      regionId: region.id, regionName: region.name, syntheticRequests: synthetic.requests.length,
      controlRequests: control.requests.length,
      files: [synthetic, control].map(s => ({ file: s.source.file, encoding: s.source.encoding,
        requestRows: s.requests.length, officeRows: s.offices.length, skippedBlankRows: s.skippedBlankLines.length,
        rejectedRows: s.rejectedRows.length, warnings: s.warnings.length })),
      dates: [...new Set(synthetic.requests.map(r => r.date))],
      officeAddresses: synthetic.offices.map(o => o.address), uniqueRequestAddresses: new Set(synthetic.requests.map(r => r.address)).size,
      requestsByTypeBK: countBy(synthetic.requests, r => r.typeBK),
      requestsByTypeHD: countBy(synthetic.requests, r => r.typeHD),
      windows: countBy(synthetic.requests, r => `${r.windowStart}–${r.windowEnd}`),
      controlStatuses: countBy(control.requests, r => r.control.status),
      controlDistinctCrewLabels: new Set(control.requests.map(r => r.control.crew).filter(Boolean)).size,
      controlWithoutCrew: control.requests.filter(r => !r.control.crew).length,
      repeatedControlIds: Object.entries(countBy(control.requests, r => r.sourceId)).filter(([, count]) => count > 1).map(([sourceId, count]) => ({ sourceId, count })),
      matching: counts, readyForPlanning: readiness.ready, missingByCode: countBy(readiness.issues, r => r.code),
    };
    summary.regions.push(detail);
    summary.totalSyntheticRequests += synthetic.requests.length;
    summary.totalControlRequests += control.requests.length;
    summary.totalRejectedRows += synthetic.rejectedRows.length + control.rejectedRows.length;
    console.log(`${region.name}: ${synthetic.requests.length} заявок, контроль ${control.requests.length}, однозначных кандидатов ${counts['unique-candidate'] ?? 0}, отклонённых строк ${synthetic.rejectedRows.length + control.rejectedRows.length}.`);
  }
  await writeJSON('import-report.json', summary);
  const markdown = [
    '# Подготовка CSV к планированию', '',
    `Перенесено ${summary.totalSyntheticRequests} синтетических заявок и ${summary.totalControlRequests} контрольных записей. Отклонено строк: ${summary.totalRejectedRows}.`, '',
    '| Район | Заявки | Контроль | Однозначные кандидаты соответствия | Различных подписей бригад |',
    '|---|---:|---:|---:|---:|',
    ...summary.regions.map(r => `| ${r.regionName} | ${r.syntheticRequests} | ${r.controlRequests} | ${r.matching['unique-candidate'] ?? 0} | ${r.controlDistinctCrewLabels} |`), '',
    '## Как использовать JSON', '',
    '1. `*.source.json` — нормализованные заявки с исходными значениями в `source.raw`. Поля, которых нет в CSV, оставлены null.',
    '2. Скопируйте `*.enrichment.template.json` в `*.enrichment.json`. Заполните координаты адресов и офисов, длительности по типу HD, приоритеты и список инженеров. У отдельных заявок значения можно задать через `requestOverrides` по полному ID.',
    '3. Подтвердите смысл временных окон (`confirmedTimeWindowSemantics`) и отсутствие ограничений транспорта по умолчанию (`confirmedNoTransportRequirements`) либо задайте транспорт каждой заявке.',
    '4. Запустите `npm run prepare:data -- data/imported/east.source.json data/imported/east.enrichment.json data/imported/east.planner.json` из репозитория. При незаполненных полях конвертер перечислит проблемы и не создаст готовый планировочный JSON.',
    '5. Загрузите готовый `*.planner.json` кнопкой «Загрузить JSON» в прототипе. Промежуточный `source.json` напрямую не подходит.', '',
    '`engineer.template.json` — заготовка одного инженера. Заполните её и добавьте в массив engineers своего файла дополнения; повторите для остальных исполнителей. Смена — HH:MM, координаты — числа, skills — от 1 до 3 навыков, transport — один тип из справочника кейса.', '',
    '## Что не следует считать исходными данными', '',
    ...summary.notes.map(note => `- ${note}`), '',
    'Координаты, длительности, приоритеты и состав инженеров не выдуманы. Без заполнения шаблонов эти данные ещё нельзя использовать для честного расчёта маршрутов.', '',
    'Названия бригад из контроля оставлены только в контрольных JSON. Списки инженеров пусты: бригада не равна автоматически одному исполнителю.', '',
    '## Качество контрольных данных', '',
    ...summary.regions.map(r => `${r.regionName}: повторные ID в контроле — ${r.repeatedControlIds.length ? r.repeatedControlIds.map(x => `${x.sourceId} (${x.count} строки)`).join(', ') : 'нет'}; неоднозначных кандидатов — ${r.matching.ambiguous ?? 0}; без кандидата — ${r.matching.unmatched ?? 0}.`), '',
    'У контрольной записи технический id включает номер строки; исходный ID без изменений хранится в sourceId. Повторные ID не объединяются и не удаляются.', '',
    '## Служебные строки', '',
    'В каждом синтетическом CSV две пустые строки и одна строка адреса офиса. Пустые строки учтены в skippedBlankLines, офис вынесен в offices; они не становятся заявками.', '',
    'В Юго-востоке есть 11 интервалов 00:01–23:59. Время 0:01 нормализовано до 00:01, дата сохранена. Эти интервалы не превращены в длительности 1438 минут.', '',
    '`*.matching.json` содержит только кандидатов соответствия по признакам. Неоднозначные совпадения не разрешаются произвольным выбором. Файл не используется алгоритмом распределения.', '',
    'Повторный импорт перезаписывает source/control/matching и пустые *.template.json. Ваши заполненные *.enrichment.json и готовые *.planner.json не затрагиваются.', '',
  ].join('\n');
  await writeFile(join(outputDirectory, 'README.md'), markdown, 'utf8');
  console.log(`JSON сохранены: ${outputDirectory}`);
  if (summary.totalRejectedRows) process.exitCode = 2;
} catch (error) { console.error(error.message); process.exitCode = 1; }
