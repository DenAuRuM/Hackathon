import { validateData } from './planner.js';
import { createEnrichmentTemplate, preparePlannerData } from './csv-import.js';

export const REGIONS = Object.freeze({ east: 'Восток', 'south-east': 'Юго-восток', 'south-center': 'Югоцентр' });
const check = (value, message) => { if (!value) throw new Error(message); };
export function identifyJSON(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  if (value.schemaVersion === 'dispatcher-workspace-v1') return 'workspace';
  if (value.schemaVersion === 'dispatcher-source-v1') return value.kind === 'synthetic' ? 'source' : 'control';
  if (value.schemaVersion === 'dispatcher-enrichment-v1') return 'enrichment';
  if (Array.isArray(value.links) && Array.isArray(value.controlWithoutUniqueMatch)) return 'matching';
  if (value.input && Array.isArray(value.routes) && value.metrics) return 'saved-plan';
  if (Array.isArray(value.requests) && Array.isArray(value.engineers)) return 'planner';
  return 'unknown';
}
function matchingRegion(matching) {
  check(matching.links.length > 0, 'В файле соответствий нет заявок. Загрузите source.json вместе с ним.');
  const regions = new Set(matching.links.map(link => typeof link.requestId === 'string' ? link.requestId.split(':')[0] : null));
  check(regions.size === 1, 'Файл соответствий содержит несколько районов или некорректные ID.');
  const regionId = [...regions][0];
  check(!matching.regionId || matching.regionId === regionId, 'Район в файле соответствий не совпадает с ID заявок.');
  return regionId;
}
export function inspectWorkspace(source, enrichment, matching = null) {
  check(source?.schemaVersion === 'dispatcher-source-v1' && source.kind === 'synthetic' && Array.isArray(source.requests) &&
    Array.isArray(source.rejectedRows) && Array.isArray(source.offices), 'Некорректный source.json: нужен набор синтетических заявок с offices и rejectedRows.');
  check(enrichment?.regionId === source.regionId, 'Набор заявок и дополнение относятся к разным районам.');
  if (matching) {
    check(matchingRegion(matching) === source.regionId, 'Файл соответствий относится к другому району.');
    const ids = new Set(source.requests.map(r => r.id));
    check(matching.links.length === ids.size && new Set(matching.links.map(l => l.requestId)).size === ids.size &&
      matching.links.every(l => ids.has(l.requestId) && ['unique-candidate', 'ambiguous', 'unmatched'].includes(l.status) && Array.isArray(l.controlRequestIds)),
    'Файл соответствий не совпадает с составом заявок source.json. Загрузите связанные файлы одного экспорта.');
  }
  const prepared = preparePlannerData(source, enrichment);
  return { kind: 'workspace', source, enrichment, matching, ...prepared };
}

/** Resolve legacy matching files via a bounded local lookup, never via a path from JSON. */
export async function resolveImport(documents, { loadRegion, existing = null } = {}) {
  check(Array.isArray(documents) && documents.length > 0, 'Выберите JSON-файл.');
  const docs = documents.map(d => ({ value: d, kind: identifyJSON(d) }));
  check(!docs.some(d => d.kind === 'unknown'), 'Неизвестный JSON. Поддерживаются source, matching, enrichment, сохранённый рабочий набор и готовый планировочный набор.');
  if (docs.length === 1 && ['planner', 'saved-plan'].includes(docs[0].kind)) {
    const data = docs[0].kind === 'planner' ? docs[0].value : docs[0].value.input;
    validateData(data);
    return { kind: 'planner', data, ready: true, issues: [], note: docs[0].kind === 'saved-plan' ? 'Загружен исходный набор сохранённого плана; расписание будет рассчитано заново.' : '' };
  }
  if (docs.length === 1 && docs[0].kind === 'workspace') {
    const { source, enrichment, matching } = docs[0].value;
    return inspectWorkspace(source, enrichment, matching);
  }
  check(docs.every(d => ['source', 'matching', 'enrichment', 'control'].includes(d.kind)), 'Загружайте готовый набор отдельно от вспомогательных файлов.');
  const get = kind => {
    const found = docs.filter(d => d.kind === kind);
    check(found.length <= 1, `Выбрано несколько файлов типа ${kind}. Выберите один район.`);
    return found[0]?.value;
  };
  let source = get('source');
  const matching = get('matching'), control = get('control');
  let enrichment = get('enrichment');
  const regions = new Set([source?.regionId, enrichment?.regionId, control?.regionId, matching && matchingRegion(matching)].filter(Boolean));
  check(regions.size === 1, 'Выбраны файлы разных районов. Загрузите один район за раз.');
  const regionId = [...regions][0];
  if (!source && existing?.source?.regionId === regionId) source = existing.source;
  if (!source) {
    check(Object.hasOwn(REGIONS, regionId) && loadRegion, 'Не найден исходный набор. Выберите source.json вместе с файлом соответствий или дополнением.');
    source = await loadRegion(regionId);
    check(source.regionId === regionId, 'Сервер вернул набор другого района.');
  }
  enrichment ??= existing?.source === source ? existing.enrichment : createEnrichmentTemplate(source);
  const workspace = inspectWorkspace(source, enrichment, matching ?? (existing?.source === source ? existing.matching : null));
  workspace.note = matching ? 'Файл соответствий распознан. Загружены связанные заявки; контрольные назначения не используются как готовый план.' :
    control ? 'Открыт синтетический набор района. Контрольные назначения и статусы не перенесены в расчёт.' : '';
  return workspace;
}
