import test from 'node:test';
import assert from 'node:assert/strict';
import { geocodeAddress, parseGeocoderResponse } from '../src/geocoder.js';
// Provider-shaped test responses verify parsing, not the location of a real CSV address.
const response = (precision = 'exact', kind = 'house', pos = '37.61 55.75') => ({ response: { GeoObjectCollection: { featureMember: [{ GeoObject: { Point: { pos }, metaDataProperty: { GeocoderMetaData: { precision, kind, text: 'Проверочный адрес' } } } }] } } });
test('geocoder keeps lon/lat order and only exact houses can be applied', () => {
  assert.deepEqual(parseGeocoderResponse(response())[0].location, { lon: 37.61, lat: 55.75 });
  assert(parseGeocoderResponse(response())[0].exactHouse);
  for (const precision of ['street', 'number', 'near', 'range', 'other']) assert.equal(parseGeocoderResponse(response(precision))[0].exactHouse, false);
  assert.equal(parseGeocoderResponse(response('exact', 'street'))[0].exactHouse, false);
  assert.deepEqual(parseGeocoderResponse(response('exact', 'house', 'NaN 90')), []);
  assert.throws(() => parseGeocoderResponse({}), /некорректный/);
});
test('geocoder validates input, uses the original address and reports failures without leaking the key', async () => {
  await assert.rejects(geocodeAddress({ address: 'Дом', key: '' }), /ключ/);
  const result = await geocodeAddress({ address: 'Дом, корпус 1', key: 'test-secret' }, async url => {
    assert.equal(url.origin, 'https://geocode-maps.yandex.ru');
    assert.equal(url.searchParams.get('geocode'), 'Дом, корпус 1');
    return { ok: true, json: async () => response() };
  });
  assert.equal(result.candidates.length, 1);
  for (const status of [403, 429, 500]) await assert.rejects(geocodeAddress({ address: 'Дом', key: 'test-secret' }, async () => ({ ok: false, status })), error => !error.message.includes('test-secret'));
  await assert.rejects(geocodeAddress({ address: 'Дом', key: 'test-secret' }, async () => { throw Error('test-secret'); }), /недоступен/);
});
