import { SKILLS, TRANSPORTS, validateData } from './planner.js';

export const SKILL_BY_BK = Object.freeze({
  'Подключение': 'Работы на подключение и дозаказы',
  'Дозаказ': 'Работы на подключение и дозаказы',
  'Локальная заявка': 'Локальные работы',
  'Глобальная проблема': 'Аварийные работы',
});
const REQUIRED_COLUMNS = ['Заявка', 'Тип заявки BK', 'Тип заявки HD', 'Начало', 'Окончание', 'Район', 'Адрес'];
const copy = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.hasOwn(value, key);
const check = (condition, message) => { if (!condition) throw new Error(message); };

/** Prefer valid UTF-8, otherwise decode the supplied legacy Windows-1251 export. */
export function decodeCSV(bytes, encoding = 'auto') {
  check(['auto', 'utf-8', 'windows-1251'].includes(encoding), 'Кодировка: auto, utf-8 или windows-1251.');
  if (encoding === 'auto') {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
    catch { encoding = 'windows-1251'; }
  }
  return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding };
}

/** Semicolon CSV with quoted delimiters, escaped quotes, multiline cells and source lines. */
export function parseCSV(text, delimiter = ';') {
  check(typeof text === 'string', 'Ожидается текст CSV.');
  check(typeof delimiter === 'string' && delimiter.length === 1 && !/["\r\n]/.test(delimiter), 'Некорректный разделитель.');
  text = text.replace(/^\uFEFF/, '');
  const records = [];
  let cells = [], field = '', quoted = false, closed = false, line = 1, recordLine = 1;
  const finishCell = () => { cells.push(field); field = ''; closed = false; };
  const finishRecord = () => { finishCell(); records.push({ line: recordLine, cells }); cells = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        field += '\n'; line++;
      } else field += char;
    } else if (char === delimiter) finishCell();
    else if (char === '\r' || char === '\n') {
      finishRecord();
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++; recordLine = line;
    } else if (char === '"') {
      check(!field && !closed, `Строка ${line}: кавычка внутри некавыченного поля.`);
      quoted = true;
    } else {
      check(!closed || /[ \t]/.test(char), `Строка ${line}: символы после закрывающей кавычки.`);
      if (!closed) field += char;
    }
  }
  check(!quoted, `Строка ${recordLine}: незакрытые кавычки.`);
  if (field || cells.length || closed) finishRecord();
  return records;
}

export function parseSourceDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{1,2}):(\d{2})$/.exec(value.trim());
  check(match, `Некорректная дата «${value}».`);
  const [, dd, mm, yyyy, hh, minute] = match;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  check(date.getUTCFullYear() === Number(yyyy) && date.getUTCMonth() + 1 === Number(mm) &&
    date.getUTCDate() === Number(dd) && Number(hh) < 24 && Number(minute) < 60, `Некорректная дата «${value}».`);
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh.padStart(2, '0')}:${minute}` };
}

export function normalizeCSV(bytes, { fileName, regionId, regionName, kind, encoding = 'auto' }) {
  check(['synthetic', 'control'].includes(kind), 'Тип источника: synthetic или control.');
  check(typeof regionId === 'string' && /^[a-z][a-z0-9-]*$/.test(regionId), 'Нужен regionId латиницей.');
  const decoded = decodeCSV(bytes, encoding);
  const records = parseCSV(decoded.text);
  check(records.length, `${fileName}: пустой CSV.`);
  const headers = records.shift().cells.map(x => x.trim());
  check(headers.every(Boolean) && new Set(headers).size === headers.length, `${fileName}: пустые или повторяющиеся заголовки.`);
  check(REQUIRED_COLUMNS.every(name => headers.includes(name)), `${fileName}: не хватает обязательных столбцов.`);
  if (kind === 'control') check(headers.includes('Бригада') && headers.includes('Статус BK'), `${fileName}: не хватает столбцов контроля.`);
  const requests = [], offices = [], rejectedRows = [], skippedBlankLines = [], warnings = [], ids = new Set();
  for (const record of records) {
    if (record.cells.every(x => !x.trim())) { skippedBlankLines.push(record.line); continue; }
    if (record.cells.length !== headers.length) {
      rejectedRows.push({ line: record.line, cells: record.cells, reason: `Ожидалось ${headers.length} полей, получено ${record.cells.length}.` }); continue;
    }
    const raw = Object.fromEntries(headers.map((h, i) => [h, record.cells[i]]));
    const value = key => (raw[key] ?? '').trim();
    if (/^адрес\s+офиса$/i.test(value('Заявка'))) {
      offices.push({ address: value('Тип заявки BK'), location: null, sourceLine: record.line, raw }); continue;
    }
    try {
      const sourceId = value('Заявка');
      check(sourceId, 'Пустой ID заявки.');
      check(kind === 'control' || !ids.has(sourceId), `Повторный ID ${sourceId}.`);
      check(value('Адрес'), 'Отсутствует адрес.');
      const start = parseSourceDate(value('Начало')), end = parseSourceDate(value('Окончание'));
      check(start.date === end.date, 'Окно пересекает дату: ядро поддерживает только один день.');
      check(start.time <= end.time, 'Окончание раньше начала.');
      const typeBK = value('Тип заявки BK'), typeHD = value('Тип заявки HD');
      const requiredSkill = own(SKILL_BY_BK, typeBK) ? SKILL_BY_BK[typeBK] : null;
      const gigabitText = value('Гигабитное подключение');
      check(!gigabitText || ['Да', 'Нет'].includes(gigabitText), 'Неизвестное значение гигабитного подключения.');
      if (ids.has(sourceId)) warnings.push({ sourceId, line: record.line, message: `Повторный ID ${sourceId} в контроле; обе строки сохранены под разными ID записей.` });
      ids.add(sourceId);
      const id = kind === 'control' ? `${regionId}:control:${sourceId}:row-${record.line}` : `${regionId}:${sourceId}`;
      requests.push({
        id, sourceId, date: start.date, address: value('Адрес'), district: value('Район'),
        typeBK, typeHD, windowStart: start.time, windowEnd: end.time,
        location: null, durationMinutes: null, priority: null, requiredSkill, requiredTransport: null,
        connection: value('Подключение') || null, gigabit: gigabitText ? gigabitText === 'Да' : null,
        source: { file: fileName, line: record.line, raw },
        derivations: { requiredSkill: requiredSkill ? `Тип заявки BK «${typeBK}» → «${requiredSkill}»; правило адаптера.` : null,
          timeWindow: 'Начало/Окончание перенесены как предполагаемое окно начала работы; семантика требует подтверждения.' },
        ...(kind === 'control' ? { control: { crew: value('Бригада') || null, status: value('Статус BK') || null } } : {}),
      });
      if (!requiredSkill) warnings.push({ requestId: id, message: `Нет соответствия навыка для «${typeBK}».` });
    } catch (error) { rejectedRows.push({ line: record.line, raw, reason: error.message }); }
  }
  return { schemaVersion: 'dispatcher-source-v1', kind, regionId, regionName,
    source: { file: fileName, encoding: decoded.encoding, delimiter: ';', columns: headers },
    readyForPlanning: false, requests, offices, rejectedRows, skippedBlankLines, warnings,
    missingData: ['Координаты адресов и стартовых точек.', 'Длительности работ.', 'Приоритеты заявок.',
      'Состав исполнителей, навыки, смены и транспорт.', 'Подтверждение семантики временных окон и политики транспорта.'],
  };
}

/** No coordinates, durations, priorities or engineers are invented. */
export function createEnrichmentTemplate(source) {
  check(source.kind === 'synthetic', 'Шаблон планирования создаётся из синтетических заявок.');
  return {
    schemaVersion: 'dispatcher-enrichment-v1', regionId: source.regionId,
    instructions: 'Заполните null фактическими значениями; engineers — полный список по схеме ядра. requestOverrides задаётся по полному id заявки. Исходные строки находятся в source JSON.',
    confirmedTimeWindowSemantics: false,
    confirmedNoTransportRequirements: false,
    routingMode: 'geographic',
    defaults: { priority: null },
    durationMinutesByTypeHD: Object.fromEntries([...new Set(source.requests.map(r => r.typeHD))].sort().map(type => [type, null])),
    locationsByAddress: Object.fromEntries([...new Set([...source.offices.map(o => o.address), ...source.requests.map(r => r.address)])].sort().map(address => [address, null])),
    engineers: [], requestOverrides: {},
  };
}

/** Materialize only a complete, valid single-day input; never drop incomplete requests. */
export function preparePlannerData(source, enrichment) {
  const issues = [];
  check(source?.schemaVersion === 'dispatcher-source-v1' && source.kind === 'synthetic', 'Для планирования нужен синтетический source JSON.');
  check(enrichment?.schemaVersion === 'dispatcher-enrichment-v1' && enrichment.regionId === source.regionId, 'Шаблон дополнения относится к другому набору.');
  if (source.rejectedRows.length) issues.push({ code: 'REJECTED_ROWS', message: 'В исходном импорте есть отклонённые строки; исправьте их перед расчётом.' });
  if (enrichment.confirmedTimeWindowSemantics !== true) issues.push({ code: 'TIME_SEMANTICS', message: 'Подтвердите, что Начало/Окончание — окно начала работы, а не фактическое время выполнения.' });
  if (new Set(source.requests.map(r => r.date)).size > 1) issues.push({ code: 'MULTIPLE_DATES', message: 'В наборе несколько дат; разделите заявки по дням.' });
  const requestIds = new Set(source.requests.map(r => r.id));
  const allowedOverride = new Set(['location', 'durationMinutes', 'priority', 'requiredSkill', 'requiredTransport']);
  for (const [id, override] of Object.entries(enrichment.requestOverrides ?? {})) {
    if (!requestIds.has(id)) issues.push({ requestId: id, code: 'UNKNOWN_ID', message: 'Неизвестный ID в requestOverrides.' });
    if (!override || typeof override !== 'object' || Array.isArray(override) || Object.keys(override).some(k => !allowedOverride.has(k))) {
      issues.push({ requestId: id, code: 'INVALID_OVERRIDE', message: 'Допустимы только location, durationMinutes, priority, requiredSkill, requiredTransport.' });
    }
  }
  const requests = source.requests.map(r => {
    const changes = own(enrichment.requestOverrides ?? {}, r.id) ? enrichment.requestOverrides[r.id] : {};
    const overrides = changes && typeof changes === 'object' ? changes : {};
    const location = own(overrides, 'location') ? overrides.location : enrichment.locationsByAddress?.[r.address];
    const addressOnly = enrichment.routingMode === 'address-only';
    const plannerLocation = addressOnly ? (location ?? { lat: 0, lon: 0 }) : location;
    const durationMinutes = own(overrides, 'durationMinutes') ? overrides.durationMinutes : enrichment.durationMinutesByTypeHD?.[r.typeHD];
    const priority = own(overrides, 'priority') ? overrides.priority : enrichment.defaults?.priority;
    const requiredTransport = own(overrides, 'requiredTransport') ? overrides.requiredTransport : null;
    const result = { id: r.id, address: r.address, location: plannerLocation ?? null, durationMinutes: durationMinutes ?? null,
      windowStart: r.windowStart, windowEnd: r.windowEnd, priority: priority ?? null,
      requiredSkill: own(overrides, 'requiredSkill') ? overrides.requiredSkill : r.requiredSkill, requiredTransport };
    if (!addressOnly && (!location || !Number.isFinite(location.lat) || Math.abs(location.lat) > 90 || !Number.isFinite(location.lon) || Math.abs(location.lon) > 180)) issues.push({ requestId: r.id, code: 'LOCATION', message: 'Нужны корректные координаты адреса.' });
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) issues.push({ requestId: r.id, code: 'DURATION', message: 'Нужна положительная длительность в минутах.' });
    if (!['Обычная', 'Срочная'].includes(priority)) issues.push({ requestId: r.id, code: 'PRIORITY', message: 'Нужно задать приоритет.' });
    if (!SKILLS.includes(result.requiredSkill)) issues.push({ requestId: r.id, code: 'SKILL', message: 'Нужен навык из справочника.' });
    if (!own(overrides, 'requiredTransport') && enrichment.confirmedNoTransportRequirements !== true) issues.push({ requestId: r.id, code: 'TRANSPORT_POLICY', message: 'Укажите requiredTransport для заявки (null — без ограничения) либо подтвердите отсутствие требований по умолчанию.' });
    if (requiredTransport !== null && !TRANSPORTS.includes(requiredTransport)) issues.push({ requestId: r.id, code: 'TRANSPORT', message: 'Неизвестный требуемый транспорт.' });
    return result;
  });
  const engineers = copy(enrichment.engineers ?? []).map(engineer => enrichment.routingMode === 'address-only' && !engineer.startLocation
    ? { ...engineer, startLocation: { lat: 0, lon: 0 } } : engineer);
  if (!Array.isArray(engineers) || !engineers.length) issues.push({ code: 'ENGINEERS', message: 'Нужен список инженеров со стартовыми координатами, навыками, сменами и транспортом.' });
  else {
    try { validateData({ requests: [], engineers }); }
    catch (error) { issues.push({ code: 'ENGINEERS', message: error.message }); }
  }
  if (issues.length) return { ready: false, data: null, issues };
  const data = { requests, engineers, metadata: { regionId: source.regionId, date: source.requests[0]?.date ?? null,
    routingMode: enrichment.routingMode === 'address-only' ? 'address-only' : 'geographic',
    sourceFile: source.source.file, skillMapping: SKILL_BY_BK, timeWindowSemanticsConfirmed: true } };
  validateData(data);
  return { ready: true, data, issues: [] };
}

// Candidate linkage is for audit only: different IDs never imply identity by row order.
export function matchingAddress(address) {
  return address.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/,?\s*кв\.?\s*[^,]*$/u, '')
    .replace(/[\s.,]/g, '');
}
export function matchControl(synthetic, control) {
  check(synthetic.regionId === control.regionId, 'Нельзя сопоставлять разные районы.');
  const signature = r => JSON.stringify([r.date, r.windowStart, r.windowEnd, r.typeBK, r.typeHD, r.district, matchingAddress(r.address), r.connection, r.gigabit]);
  const groups = list => {
    const map = new Map();
    for (const r of list) { const key = signature(r); if (!map.has(key)) map.set(key, []); map.get(key).push(r); }
    return map;
  };
  const left = groups(synthetic.requests), right = groups(control.requests), used = new Set();
  const links = synthetic.requests.map(r => {
    const key = signature(r), candidates = right.get(key) ?? [];
    const unique = candidates.length === 1 && left.get(key).length === 1;
    if (unique) used.add(candidates[0].id);
    return { requestId: r.id, status: unique ? 'unique-candidate' : candidates.length ? 'ambiguous' : 'unmatched',
      controlRequestIds: candidates.map(c => c.id) };
  });
  return { method: 'Совпадение даты, окна, типов, района, адреса без квартиры, подключения и гигабита. Это кандидат соответствия, не доказанная идентичность.',
    links, controlWithoutUniqueMatch: control.requests.filter(r => !used.has(r.id)).map(r => r.id) };
}
