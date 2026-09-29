import test from 'node:test';
import assert from 'node:assert/strict';
import { MapView, loadYandexApi, yandexCoordinates, mountYandexMap } from '../web/yandex-map.js';

const container = () => ({ textContent: '', replaceChildren() {}, classList: { remove() {}, add() {} } });
test('Yandex uses longitude before latitude; absent key does not contact the API', async () => {
  assert.deepEqual(yandexCoordinates({ lat: 55, lon: 37 }), [37, 55]);
  await assert.rejects(loadYandexApi(''), /нужен API-ключ/);
});
test('failed Yandex loading falls back to OSM and explains failure', async () => {
  let fallback = 0, message;
  const view = new MapView(container(), () => fallback++, text => { message = text; }, async () => { throw new Error('Test error'); });
  await view.render({}, [], 'yandex', 'test-key');
  assert.equal(fallback, 1); assert.match(message, /резервная карта/);
});
test('late API completion cannot replace a new plan or resurrect cleared content', async () => {
  let finish, mounted = 0;
  const view = new MapView(container(), () => {}, () => {}, () => new Promise(resolve => { finish = resolve; }), () => { mounted++; });
  const pending = view.render({}, [], 'yandex', 'test-key');
  view.clear('Waiting for data'); finish({}); await pending;
  assert.equal(mounted, 0); assert.equal(view.container.textContent, 'Waiting for data');
});
test('mounted map is destroyed before switching provider', async () => {
  let destroyed = 0;
  const view = new MapView(container(), () => {}, () => {}, async () => ({}), () => ({ destroy() { destroyed++; } }));
  await view.render({}, [], 'yandex', 'test-key'); await view.render({}, [], 'osm', '');
  assert.equal(destroyed, 1);
});
test('Yandex renderer uses the plan geometry and labels without changing the plan', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {} }) };
  try {
    class Item { constructor(options, label) { this.options = options; this.label = label; } }
    class Map { constructor(container, options, layers) { this.children = layers; this.options = options; } addChild(item) { this.children.push(item); } destroy() {} }
    const api = { YMap: Map, YMapDefaultSchemeLayer: Item, YMapDefaultFeaturesLayer: Item, YMapFeature: Item, YMapMarker: Item };
    const p = { routes: [{ engineerName: 'Test', startLocation: { lat: 55, lon: 37 }, geometry: [{ lat: 55, lon: 37 }, { lat: 56, lon: 38 }], stops: [{ requestId: '<text>', location: { lat: 56, lon: 38 }, start: '10:00' }] }], input: { requests: [] }, unassigned: [] };
    const saved = JSON.stringify(p), map = mountYandexMap(container(), p, ['#123456'], api);
    assert.deepEqual(map.children.find(x => x.options?.geometry).options.geometry.coordinates, [[37, 55], [38, 56]]);
    assert.equal(map.children.filter(x => x.label).length, 2);
    assert.equal(JSON.stringify(p), saved);
  } finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }
});
