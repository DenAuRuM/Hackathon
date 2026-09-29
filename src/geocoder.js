/** Coordinates come only from the provider response; approximate streets are not houses. */
export function parseGeocoderResponse(value) {
  const members = value?.response?.GeoObjectCollection?.featureMember;
  if (!Array.isArray(members)) throw new Error('Геокодер вернул некорректный ответ.');
  return members.flatMap(({ GeoObject: object }) => {
    const metadata = object?.metaDataProperty?.GeocoderMetaData;
    const parts = object?.Point?.pos?.trim().split(/\s+/);
    if (parts?.length !== 2) return [];
    const [lon, lat] = parts.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    return [{ text: metadata?.text || object.name || '', precision: metadata?.precision || 'other',
      exactHouse: metadata?.kind === 'house' && metadata?.precision === 'exact', location: { lat, lon } }];
  });
}
export async function geocodeAddress({ address, key }, fetcher = fetch) {
  if (typeof address !== 'string' || !address.trim() || address.length > 1000) throw new Error('Нужен непустой адрес до 1000 символов.');
  if (typeof key !== 'string' || !key.trim() || key.length > 300) throw new Error('Нужен ключ HTTP API Геокодера Яндекса.');
  const url = new URL('https://geocode-maps.yandex.ru/v1/');
  url.search = new URLSearchParams({ apikey: key, geocode: address, format: 'json', lang: 'ru_RU', results: '5' });
  let response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch { throw new Error('Геокодер недоступен или не ответил за 15 секунд.'); }
  if (!response.ok) throw new Error(response.status === 403 ? 'Геокодер отклонил ключ. Проверьте доступ к HTTP API и ограничения ключа.' : response.status === 429 ? 'Лимит запросов Геокодера исчерпан. Повторите позже.' : 'Ошибка сервиса Геокодера.');
  let body; try { body = await response.json(); } catch { throw new Error('Геокодер вернул некорректный JSON.'); }
  return { candidates: parseGeocoderResponse(body) };
}
