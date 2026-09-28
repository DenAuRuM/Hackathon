import { DEFAULT_WEIGHTS, SKILLS, TRANSPORTS, comparePlans, replan, loadJSON } from '/src/planner.js';
import { drawMap } from '/web/map.js';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { personnel: 'Меньше исполнителей', distance: 'Меньше километров', travel: 'Меньше времени в пути', waiting: 'Меньше ожидания', balance: 'Равномерная загрузка', versatility: 'Сберечь универсальных инженеров', stability: 'Сохранить назначения при событии' };
const colors = ['#276b55', '#c76c38', '#5669a8', '#a75280', '#a28b24'];
let data, current, comparison;
for (const [key, value] of Object.entries(DEFAULT_WEIGHTS)) {
  const wrapper = document.createElement('div'); wrapper.className = 'weight';
  wrapper.innerHTML = `<label for="weight-${key}">${labels[key]}<output id="value-${key}">${value}</output></label><input id="weight-${key}" type="range" min="0" max="20" step="0.1" value="${value}">`;
  $('weights').append(wrapper);
  $(`weight-${key}`).addEventListener('input', e => { $(`value-${key}`).textContent = e.target.value; });
}
for (const skill of SKILLS) $('event-skill').add(new Option(skill, skill));
$('event-skill').value = 'Аварийные работы';
for (const transport of TRANSPORTS) $('event-transport').add(new Option(transport, transport));
const weights = () => Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(key => [key, Number($(`weight-${key}`).value)]));
function showError(error) { $('error').textContent = error.message; $('error').hidden = false; }
function guard(action) { return async (...args) => { try { $('error').hidden = true; await action(...args); } catch (error) { showError(error); } }; }
function build() { comparison = comparePlans(data, { weights: weights() }); current = comparison.optimized; render(); }
async function demo() { const response = await fetch('/data/demo.json'); if (!response.ok) throw new Error('Не удалось загрузить демо-данные.'); data = loadJSON(await response.text()); build(); }
$('demo').onclick = guard(demo);
$('build').onclick = guard(build);
$('upload').onchange = guard(async e => { const file = e.target.files[0]; if (!file) return; const parsed = loadJSON(await file.text()); data = parsed; build(); });
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
  const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'dispatcher-plan.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function metric(label, value) { return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`; }
function render() {
  const m = current.metrics;
  $('metrics').innerHTML = metric('Назначено заявок', `${m.assignedRequests} / ${m.totalRequests}`) + metric('Исполнителей в плане', m.usedEngineers) + metric('Общий пробег, км', m.totalDistanceKm) + metric('Не назначены', m.unassignedRequests);
  $('plan-label').textContent = current.event ? `После события в ${current.event.time}` : 'Исходный план';
  const rows = [['Базовый', comparison.baseline.metrics], ['Эвристики', comparison.optimized.metrics]];
  $('comparison').innerHTML = `<div class="table-scroll"><table><thead><tr><th>Исходный день</th><th>Назначено</th><th>Исполнителей</th><th>Км</th></tr></thead><tbody>${rows.map(([name, x]) => `<tr><td>${name}</td><td>${x.assignedRequests}</td><td>${x.usedEngineers}</td><td>${x.totalDistanceKm}</td></tr>`).join('')}</tbody></table></div>${current.event ? '<p class="small">Сравнение выше относится к исходному набору без новых срочных заявок. Актуальные показатели — в верхних карточках.</p>' : ''}`;
  $('routes').innerHTML = current.routes.map((route, i) => `<div class="route-title" style="color:${colors[i % colors.length]}">${escape(route.engineerName)} · ${escape(route.transport)} · ${route.distanceKm} км</div><p class="small">${escape(route.explanation)}</p>${route.stops.length ? route.stops.map((s, index) => `<details><summary>${index + 1}. ${escape(s.requestId)} &nbsp; ${s.start}–${s.end} ${s.locked ? '<span class="pill">Зафиксировано</span>' : ''}</summary><p class="small">Прибытие ${s.arrival} · путь ${s.travelMinutes} мин · ожидание ${s.waitingMinutes} мин · ${s.distanceKm.toFixed(2)} км от предыдущей точки</p>${s.explanation.map(text => `<p class="explanation">${escape(text)}</p>`).join('')}</details>`).join('') : '<p class="small">Нет назначений</p>'}`).join('');
  $('unassigned').innerHTML = current.unassigned.length ? current.unassigned.map(u => `<div class="issue"><strong>${escape(u.requestId)}</strong> — ${escape(u.reason.text)}</div>`).join('') : '<p class="muted">Все заявки назначены.</p>';
  $('changes-panel').hidden = !current.event;
  const describe = a => !a ? 'не было в плане' : a.status !== 'assigned' ? 'не назначена' : `${a.engineerId}, позиция ${a.position + 1}, начало ${a.start}`;
  $('changes').innerHTML = (current.changes || []).map(c => `<div class="change"><strong>${escape(c.requestId)}</strong>: ${escape(describe(c.before))} → ${escape(describe(c.after))}</div>`).join('') || '<p>Назначения не изменились.</p>';
  drawMap($('map'), current, colors);
}
await guard(demo)();
