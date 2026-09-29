import { DEFAULT_WEIGHTS, SKILLS, TRANSPORTS, comparePlans, replan } from '/src/planner.js';
import { drawMap } from '/web/map.js';
import { resolveImport, inspectWorkspace } from '/src/import-session.js';
import { MapView } from '/web/yandex-map.js';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { personnel: 'Меньше исполнителей', distance: 'Меньше километров', travel: 'Меньше времени в пути', waiting: 'Меньше ожидания', balance: 'Равномерная загрузка', versatility: 'Сберечь универсальных инженеров', stability: 'Сохранить назначения при событии' };
const colors = ['#276b55', '#c76c38', '#5669a8', '#a75280', '#a28b24'];
let data, current, comparison, workspace = null, importRevision = 0;
const mapView = new MapView($('map'), drawMap, message => { $('map-status').textContent = message; });
for (const [key, value] of Object.entries(DEFAULT_WEIGHTS)) {
  const wrapper = document.createElement('div'); wrapper.className = 'weight';
  wrapper.innerHTML = `<label for="weight-${key}">${labels[key]}<output id="value-${key}">${value}</output></label><input id="weight-${key}" type="range" min="0" max="20" step="0.1" value="${value}">`;
  $('weights').append(wrapper);
  $(`weight-${key}`).addEventListener('input', e => { $(`value-${key}`).textContent = e.target.value; $('weight-status').textContent = 'Веса изменены. Нажмите «Построить исходный план», чтобы применить их.'; });
}
for (const skill of SKILLS) $('event-skill').add(new Option(skill, skill));
$('event-skill').value = 'Аварийные работы';
for (const transport of TRANSPORTS) $('event-transport').add(new Option(transport, transport));
const weights = () => Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(key => [key, Number($(`weight-${key}`).value)]));
function showError(error) { $('error').textContent = error.message; $('error').hidden = false; }
function guard(action) { return async (...args) => { try { $('error').hidden = true; await action(...args); } catch (error) { showError(error); } }; }
function setPlanningEnabled(enabled) {
  $('build').disabled = !enabled; $('export').disabled = !enabled;
  for (const control of $('urgent-form').elements) control.disabled = !enabled;
}
function clearPlan() {
  data = null; current = null; comparison = null; setPlanningEnabled(false);
  $('metrics').innerHTML = ''; $('comparison').textContent = 'Расчёт появится после заполнения данных.';
  $('routes').textContent = 'Маршруты ещё не рассчитаны.'; $('unassigned').textContent = 'Недостаток исходных данных не означает невыполнимость заявок.';
  $('changes-panel').hidden = true; $('plan-label').textContent = 'Требуется подготовка';
  mapView.clear('Для карты нужны координаты и рассчитанный план.');
  $('objective').textContent = ''; $('weight-status').textContent = '';
}
function build() {
  if (!data) throw new Error('Сначала заполните недостающие данные и нажмите «Проверить и рассчитать».');
  const result = comparePlans(data, { weights: weights() }); comparison = result; current = result.optimized;
  setPlanningEnabled(true); render();
}
async function fetchJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Связанный набор не найден на сервере. Перезапустите npm start и повторите загрузку либо выберите source.json вместе с matching.json.');
  return response.json();
}
const loadRegion = region => fetchJSON(`/data/imported/${region}.source.json`);
function displayWorkspace(result) {
  workspace = result; clearPlan(); $('preparation').hidden = false;
  $('dataset').value = result.source.regionId;
  $('import-origin').textContent = result.origin || 'Рабочий набор из JSON';
  $('source-title').textContent = `${result.source.regionName} · заявок: ${result.source.requests.length}`;
  $('import-note').textContent = result.note || 'Исходные заявки загружены. Заполните недостающие поля для расчёта.';
  $('enrichment-editor').value = JSON.stringify(result.enrichment, null, 2);
  renderPreparation(result);
  const summary = new Map();
  for (const issue of result.issues) {
    const key = issue.code === 'DURATION' ? `${issue.code}:${issue.typeHD}` : issue.code;
    const item = summary.get(key) || { count: 0, message: issue.message }; item.count++; summary.set(key, item);
  }
  $('missing-summary').innerHTML = [...summary.values()].map(item => `<p class="issue">${escape(item.message)} <strong>(${item.count})</strong></p>`).join('');
  $('prep-status').textContent = result.ready ? 'Данные заполнены: план рассчитан ниже.' : 'JSON загружен успешно. Для расчёта нужны дополнительные сведения, которых нет в исходном CSV. Числа в скобках — количество заявок или общих настроек, требующих заполнения.';
  const links = new Map((result.matching?.links || []).map(link => [link.requestId, link.status]));
  const statuses = { 'unique-candidate': 'Один кандидат', ambiguous: 'Неоднозначно', unmatched: 'Нет совпадения' };
  $('source-requests').innerHTML = `<table><thead><tr><th>ID</th><th>Адрес</th><th>Окно</th><th>Навык</th><th>Контроль</th></tr></thead><tbody>${result.source.requests.map(r => `<tr><td>${escape(r.id)}</td><td>${escape(r.address)}</td><td>${escape(r.windowStart)}–${escape(r.windowEnd)}</td><td>${escape(r.requiredSkill ?? 'Не указан')}</td><td>${statuses[links.get(r.id)] || 'Не загружен'}</td></tr>`).join('')}</tbody></table>`;
  if (result.ready) { data = result.data; build(); }
}
function editEnrichment(change) {
  const enrichment = JSON.parse($('enrichment-editor').value);
  change(enrichment);
  $('enrichment-editor').value = JSON.stringify(enrichment, null, 2);
  $('enrichment-editor').oninput();
}
function renderPreparation(result) {
  const e = result.enrichment;
  $('preparation-fields').innerHTML = `<h3>Настройки расчёта</h3><label>Режим<select id="routing-mode"><option value="geographic">С координатами и картой</option><option value="address-only">Только адреса, без переездов</option></select></label><label><input id="confirm-time" type="checkbox"> «Начало/Окончание» задают окно начала работы</label><label><input id="confirm-transport" type="checkbox"> По умолчанию требований к транспорту нет</label><label>Общий приоритет<select id="default-priority"><option value="">Не задан</option><option>Обычная</option><option>Срочная</option></select></label><h3>Длительность работ в минутах</h3><p>Укажите в полях ниже длительность работ (примерное в минутах), исходя из опыта без учета транспорта</p><div id="duration-fields"></div><p>Инженеры задаются в JSON ниже: ID, навыки, смена, транспорт. Для карты можно указать startAddress и найти его координаты через поиск адреса.</p>`;
  $('routing-mode').value = e.routingMode || 'geographic';
  $('confirm-time').checked = e.confirmedTimeWindowSemantics === true;
  $('confirm-transport').checked = e.confirmedNoTransportRequirements === true;
  $('default-priority').value = e.defaults?.priority || '';
  $('routing-mode').onchange = guard(() => editEnrichment(x => { x.routingMode = $('routing-mode').value; }));
  $('confirm-time').onchange = guard(() => editEnrichment(x => { x.confirmedTimeWindowSemantics = $('confirm-time').checked; }));
  $('confirm-transport').onchange = guard(() => editEnrichment(x => { x.confirmedNoTransportRequirements = $('confirm-transport').checked; }));
  $('default-priority').onchange = guard(() => editEnrichment(x => { x.defaults ??= {}; x.defaults.priority = $('default-priority').value || null; }));
  const types = [...new Set(result.source.requests.map(r => r.typeHD))].sort();
  for (const type of types) {
    const label = document.createElement('label');
    label.textContent = `${type} (${result.source.requests.filter(r => r.typeHD === type).length} заявок)`;
    const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.step = '1';
    input.value = e.durationMinutesByTypeHD?.[type] ?? '';
    input.oninput = guard(() => editEnrichment(x => { x.durationMinutesByTypeHD ??= {}; x.durationMinutesByTypeHD[type] = input.value === '' ? null : Number(input.value); }));
    label.append(input); $('duration-fields').append(label);
  }
  const addresses = [...new Set([...result.source.requests.map(r => r.address), ...result.source.offices.map(o => o.address), ...(Array.isArray(e.engineers) ? e.engineers.map(x => x.startAddress).filter(Boolean) : [])])];
  $('geocode-address').replaceChildren(...addresses.map(address => new Option(address, address)));
  $('geocode-results').replaceChildren(); $('geocode-status').textContent = '';
}
$('geocode-search').onclick = guard(async () => {
  const address = $('geocode-address').value, revision = importRevision, source = workspace?.source;
  const key = $('geocoder-key').value.trim();
  if (!key) throw new Error('Введите ключ HTTP API Геокодера Яндекса.');
  $('geocode-search').disabled = true; $('geocode-results').replaceChildren();
  $('geocode-status').textContent = 'Ищем адрес…';
  try {
    const response = await fetch('/api/geocode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, key }) });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Перезапустите сервер: новый поиск адресов ещё не подключён.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось найти адрес.');
    if (revision !== importRevision || source !== workspace?.source) return;
    $('geocode-status').textContent = result.candidates.length ? 'Проверьте полный адрес. Применить можно только результат с точностью до дома.' : 'Адрес не найден. Координаты не изменены.';
    for (const candidate of result.candidates) {
      const row = document.createElement('p'); row.textContent = `${candidate.text} · точность: ${candidate.precision} `;
      const button = document.createElement('button'); button.textContent = 'Применить координаты'; button.disabled = !candidate.exactHouse;
      button.onclick = guard(() => {
        if (source !== workspace?.source) throw new Error('Набор сменился. Повторите поиск.');
        editEnrichment(e => {
          e.locationsByAddress ??= {}; e.locationsByAddress[address] = candidate.location;
          for (const engineer of e.engineers || []) if (engineer.startAddress === address) engineer.startLocation = candidate.location;
        });
        $('geocode-status').textContent = `Координаты внесены для: ${address}. Нажмите «Проверить и рассчитать».`;
        button.disabled = true;
      }); row.append(button); $('geocode-results').append(row);
    }
  } finally { $('geocode-search').disabled = false; }
});
async function importDocuments(documents, revision, origin) {
  const result = await resolveImport(documents, { loadRegion, existing: workspace });
  if (revision !== importRevision) return;
  if (result.kind === 'workspace') { result.origin = origin; displayWorkspace(result); }
  else { workspace = null; $('preparation').hidden = true; clearPlan(); data = result.data; build(); }
}
async function demo() {
  const revision = ++importRevision, loaded = await fetchJSON('/data/demo.json');
  await importDocuments([loaded], revision);
}
$('demo').onclick = guard(demo);
$('build').onclick = guard(build);
$('upload').onchange = guard(async e => {
  const files = [...e.target.files]; if (!files.length) return;
  const revision = ++importRevision;
  try { await importDocuments(await Promise.all(files.map(async f => JSON.parse((await f.text()).replace(/^\uFEFF/, '')))), revision, `Загружены файлы: ${files.map(f => f.name).join(', ')}`); }
  catch (error) {
    if (revision !== importRevision) return;
    throw new Error(`Не удалось открыть ${files.map(f => f.name).join(', ')}. ${error.message} ${workspace ? `На экране остался предыдущий набор: ${workspace.source.regionName}.` : 'Новый набор не загружен.'}`);
  }
  finally { e.target.value = ''; }
});
$('load-dataset').onclick = guard(async () => {
  const revision = ++importRevision;
  const region = $('dataset').value;
  await importDocuments([await loadRegion(region)], revision, `Встроенный набор: ${region}.source.json`);
});
$('enrichment-editor').oninput = () => { if (workspace) { clearPlan(); $('prep-status').textContent = 'Есть изменения. Нажмите «Проверить и рассчитать».'; } };
$('apply-enrichment').onclick = guard(() => {
  ++importRevision;
  if (!workspace) throw new Error('Сначала откройте набор заявок.');
  const result = inspectWorkspace(workspace.source, JSON.parse($('enrichment-editor').value), workspace.matching);
  result.origin = workspace.origin;
  displayWorkspace(result);
});
function downloadJSON(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download-workspace').onclick = guard(() => {
  if (!workspace) throw new Error('Сначала откройте набор.');
  downloadJSON({ schemaVersion: 'dispatcher-workspace-v1', source: workspace.source,
    enrichment: JSON.parse($('enrichment-editor').value), matching: workspace.matching }, `${workspace.source.regionId}.workspace.json`);
});
$('apply-map').onclick = guard(async () => {
  if (!current) { $('map-status').textContent = 'Настройки выбраны. Карта появится после заполнения данных и расчёта плана.'; return; }
  await renderMap();
});
const renderMap = () => {
  if (current?.input?.metadata?.routingMode === 'address-only') {
    mapView.clear('Режим «Только адреса»: карта и географический пробег отключены.');
    $('map-status').textContent = 'План построен по времени, навыкам и транспорту; координаты не используются.';
    return;
  }
  return mapView.render(current, colors, $('map-provider').value, $('yandex-key').value.trim());
};
$('urgent-form').onsubmit = guard(e => {
  e.preventDefault();
  if (!current) throw new Error('Сначала загрузите данные.');
  let number = 1; while (current.input.requests.some(r => r.id === `urgent-${number}`)) number++;
  current = replan(current, { type: 'urgent_request', time: $('event-time').value, request: {
    id: `urgent-${number}`, location: { lat: Number($('event-lat').value), lon: Number($('event-lon').value) },
    durationMinutes: Number($('event-duration').value), windowStart: $('event-time').value, windowEnd: $('event-end').value,
    requiredSkill: $('event-skill').value, requiredTransport: $('event-transport').value || null,
  } }, { weights: weights() });
  render();
});
$('export').onclick = guard(() => {
  if (!current) throw new Error('Сначала постройте план.');
  downloadJSON(current, 'dispatcher-plan.json');
});
function metric(label, value) { return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`; }
function render() {
  const m = current.metrics;
  const addressOnly = current.input.metadata?.routingMode === 'address-only';
  $('weight-status').textContent = addressOnly ? 'Переезды не учтены. Веса расстояния и времени пути отключены. Стабильность влияет только при перепланировании.' : 'Показан план с применёнными весами. Стабильность влияет только при перепланировании.';
  for (const key of ['distance', 'travel']) $(`weight-${key}`).disabled = addressOnly;
  for (const id of ['event-lat', 'event-lon']) { $(id).disabled = addressOnly; $(id).required = !addressOnly; }
  $('objective').innerHTML = `<p>Взвешенная оценка: ${current.objective.value.toFixed(3)}. Среди проверенных планов сначала сравнивается число назначенных заявок, затем оценка (меньше — лучше).</p><table><thead><tr><th>Критерий</th><th>Значение</th><th>Вес</th><th>Вклад</th></tr></thead><tbody>${Object.keys(labels).map(key => `<tr><td>${labels[key]}</td><td>${current.objective.features[key].toFixed(3)}</td><td>${current.options.weights[key]}</td><td>${current.objective.contributions[key].toFixed(3)}</td></tr>`).join('')}</tbody></table><p>Срочные заявки имеют преимущество при перепланировании.</p>`;
  $('metrics').innerHTML = metric('Назначено заявок', `${m.assignedRequests} / ${m.totalRequests}`) + metric('Исполнителей в плане', m.usedEngineers) + metric('Общий пробег, км', m.totalDistanceKm ?? 'Не рассчитан') + metric('Не назначены', m.unassignedRequests);
  $('plan-label').textContent = current.event ? `После события в ${current.event.time}` : 'Исходный план';
  const rows = [['Базовый', comparison.baseline.metrics], ['Эвристики', comparison.optimized.metrics]];
  $('comparison').innerHTML = `<div class="table-scroll"><table><thead><tr><th>Исходный день</th><th>Назначено</th><th>Исполнителей</th><th>Км</th></tr></thead><tbody>${rows.map(([name, x]) => `<tr><td>${name}</td><td>${x.assignedRequests}</td><td>${x.usedEngineers}</td><td>${x.totalDistanceKm}</td></tr>`).join('')}</tbody></table></div>${current.event ? '<p class="small">Сравнение выше относится к исходному набору без новых срочных заявок. Актуальные показатели — в верхних карточках.</p>' : ''}`;
  $('routes').innerHTML = current.routes.map((route, i) => `<div class="route-title" style="color:${colors[i % colors.length]}">${escape(route.engineerName)} · ${escape(route.transport)} · ${route.distanceKm == null ? 'пробег не рассчитан' : `${route.distanceKm} км`}</div><p class="small">${escape(route.explanation)}</p>${route.stops.length ? route.stops.map((s, index) => `<details><summary>${index + 1}. ${escape(s.requestId)} &nbsp; ${s.start}–${s.end} ${s.locked ? '<span class="pill">Зафиксировано</span>' : ''}</summary><p>${escape(s.address || '')}</p><p class="small">${addressOnly ? 'Без учёта времени в пути' : `Прибытие ${s.arrival} · путь ${s.travelMinutes} мин · ${s.distanceKm.toFixed(2)} км от предыдущей точки`} · ожидание ${s.waitingMinutes} мин</p>${s.explanation.map(text => `<p class="explanation">${escape(text)}</p>`).join('')}</details>`).join('') : '<p class="small">Нет назначений</p>'}`).join('');
  $('comparison').innerHTML = $('comparison').innerHTML.replaceAll('<td>null</td>', '<td>—</td>');
  $('unassigned').innerHTML = current.unassigned.length ? current.unassigned.map(u => `<div class="issue"><strong>${escape(u.requestId)}</strong> — ${escape(u.reason.text)}</div>`).join('') : '<p class="muted">Все заявки назначены.</p>';
  $('changes-panel').hidden = !current.event;
  const describe = a => !a ? 'не было в плане' : a.status !== 'assigned' ? 'не назначена' : `${a.engineerId}, позиция ${a.position + 1}, начало ${a.start}`;
  $('changes').innerHTML = (current.changes || []).map(c => `<div class="change"><strong>${escape(c.requestId)}</strong>: ${escape(describe(c.before))} → ${escape(describe(c.after))}</div>`).join('') || '<p>Назначения не изменились.</p>';
  void renderMap();
}
await guard(demo)();
