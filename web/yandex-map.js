let apiPromise, apiKey;
export function loadYandexApi(key) {
  if (!key?.trim()) return Promise.reject(new Error('Для Яндекс Карт нужен API-ключ JavaScript API. Введите его и нажмите «Применить карту».'));
  if (apiKey && apiKey !== key) return Promise.reject(new Error('Для смены API-ключа обновите страницу.'));
  if (apiPromise) return apiPromise;
  apiKey = key;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => { clearTimeout(timer); script.remove(); reject(new Error('Яндекс Карты не загрузились. Проверьте сеть, API-ключ и разрешённый Referer; для повторной попытки обновите страницу.')); };
    const timer = setTimeout(fail, 15000);
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=ru_RU`;
    script.onerror = fail;
    script.onload = async () => {
      try { await window.ymaps3.ready; clearTimeout(timer); resolve(window.ymaps3); }
      catch { fail(); }
    };
    document.head.append(script);
  });
  return apiPromise;
}
export function yandexCoordinates(point) { return [point.lon, point.lat]; }
export function mountYandexMap(container, plan, colors, api) {
  const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapFeature, YMapMarker } = api;
  const points = [...plan.routes.flatMap(r => r.geometry), ...plan.input.requests.map(r => r.location)];
  if (!points.length) { container.textContent = 'Нет точек для отображения.'; return null; }
  const lons = points.map(p => p.lon), lats = points.map(p => p.lat);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const location = minLon === maxLon && minLat === maxLat ? { center: [minLon, minLat], zoom: 13 } :
    { bounds: [[minLon - .005, minLat - .005], [maxLon + .005, maxLat + .005]] };
  container.replaceChildren(); container.classList.add('yandex-map');
  const map = new YMap(container, { location }, [new YMapDefaultSchemeLayer({}), new YMapDefaultFeaturesLayer({})]);
  try {
    const marker = (point, text, color) => {
      const label = document.createElement('div'); label.className = 'yandex-marker'; label.textContent = text; label.title = text;
      label.style.background = color;
      map.addChild(new YMapMarker({ coordinates: yandexCoordinates(point) }, label));
    };
    plan.routes.forEach((route, index) => {
      const color = colors[index % colors.length];
      if (route.geometry.length > 1) map.addChild(new YMapFeature({ geometry: { type: 'LineString', coordinates: route.geometry.map(yandexCoordinates) }, style: { stroke: [{ width: 3, color }] } }));
      marker(route.startLocation, `Старт: ${route.engineerName}`, color);
      route.stops.forEach((stop, i) => marker(stop.location, `${i + 1}. ${stop.requestId} · ${stop.start}`, color));
    });
    plan.unassigned.forEach(item => marker(plan.input.requests.find(r => r.id === item.requestId).location, `${item.requestId}: не назначена`, '#b9402e'));
    return map;
  } catch (error) { map.destroy(); throw error; }
}

/** Async provider loads cannot resurrect an old plan after an import or provider switch. */
export class MapView {
  constructor(container, fallback, status, loadApi = loadYandexApi, mount = mountYandexMap) {
    Object.assign(this, { container, fallback, status, loadApi, mount, revision: 0, map: null });
  }
  clear(message = '') {
    this.revision++; this.map?.destroy(); this.map = null;
    this.container.classList.remove('yandex-map'); this.container.replaceChildren(); this.container.textContent = message;
    this.status('');
  }
  async render(plan, colors, provider, key) {
    this.clear(); const revision = this.revision;
    if (provider !== 'yandex') { this.fallback(this.container, plan, colors); return; }
    this.status('Загрузка Яндекс Карт…');
    try {
      const api = await this.loadApi(key);
      if (revision !== this.revision) return;
      this.map = this.mount(this.container, plan, colors, api); this.status('Яндекс Карты. Порядок посещения показан прямыми линиями; дорожное время не рассчитывается.');
    } catch (error) {
      if (revision !== this.revision) return;
      this.container.classList.remove('yandex-map'); this.fallback(this.container, plan, colors);
      this.status(`${error.message} Показана резервная карта OpenStreetMap.`);
    }
  }
}
