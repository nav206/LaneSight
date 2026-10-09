import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, GeoJSON, MapContainer, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import type { BikeLaneSegment, BikeRouteResponse, StreetClosure, StreetReport } from '@workspace/api-client-react';
import { getGetBikeStationsQueryKey, getGetStreetConditionsQueryKey, useGetBikeNetwork, useGetBikeStations, useGetStreetConditions, usePlanBikeRoute } from '@workspace/api-client-react';
import { ArrowRight, Bike, Clock3, MapPin, Navigation, RotateCw, Search, ShieldCheck } from 'lucide-react';
import type { LatLngBoundsExpression, LatLngExpression, PathOptions } from 'leaflet';

const DEFAULT_ORIGIN = 'Civic Center, San Francisco';
const DEFAULT_DESTINATION = 'Ferry Building, San Francisco';
const SF_CENTER: LatLngExpression = [37.767, -122.433];

function coordinatePairs(coords: number[][]): LatLngExpression[] {
  return coords.filter((point) => point.length >= 2).map(([lng, lat]) => [lat, lng] as LatLngExpression);
}

function routeCoordinates(route: BikeRouteResponse): LatLngExpression[] {
  return coordinatePairs(route.coordinates as number[][]);
}

function ZoomToRoute({ route }: { route?: BikeRouteResponse }) {
  const map = useMap();
  useEffect(() => {
    if (!route?.coordinates?.length) {
      map.setView(SF_CENTER, 13);
      return;
    }
    const points = routeCoordinates(route);
    if (points.length) map.fitBounds(points as LatLngBoundsExpression, { padding: [48, 48], maxZoom: 15, animate: true });
  }, [map, route]);
  return null;
}

function MapZoomButtons() {
  const map = useMap();
  return <div className="ls-map-controls" aria-label="Map zoom controls">
    <button type="button" aria-label="Zoom in" data-testid="button-zoom-in" onClick={() => map.zoomIn()}><span aria-hidden="true">+</span></button>
    <button type="button" aria-label="Zoom out" data-testid="button-zoom-out" onClick={() => map.zoomOut()}><span aria-hidden="true">−</span></button>
  </div>;
}

function facilityStyle(segment: BikeLaneSegment): PathOptions {
  const kind = `${segment.facilityType} ${segment.symbology}`.toLowerCase();
  const color = segment.raised || /protected|cycle track|separated/.test(kind) ? '#187b60'
    : segment.buffered || /buffer/.test(kind) ? '#34a382'
      : segment.sharrow || /sharrow|shared/.test(kind) ? '#d49b38' : '#567889';
  return { color, weight: segment.raised ? 6 : 4, opacity: 0.86, lineCap: 'round', lineJoin: 'round' };
}

function segmentDescription(segment: BikeLaneSegment): string {
  return [segment.facilityType, segment.raised && 'raised', segment.buffered && 'buffered', segment.sharrow && 'shared-lane marking', segment.contraflow && 'contraflow'].filter(Boolean).join(' · ');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'error' in error) return String((error as { error: unknown }).error);
  return 'The request could not be completed. Please try again.';
}

function formatDate(value?: string) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

function formatDistance(meters: number) {
  const miles = meters / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : miles.toFixed(0)} mi`;
}

function closureStyle(): PathOptions {
  return { color: '#b74d3c', weight: 5, opacity: 0.84, dashArray: '7 6', lineCap: 'round' };
}

function ConditionGeometry({ closure, visible }: { closure: StreetClosure; visible: boolean }) {
  if (!visible || !closure.geometry?.coordinates?.length) return null;
  return <GeoJSON key={`closure-${closure.id}`} data={closure.geometry as never} style={closureStyle} eventHandlers={{ click: () => undefined }}>
    <Popup><strong>{closure.name}</strong><br />{closure.type} · {closure.status}<br />{closure.street}{closure.fromStreet ? `, ${closure.fromStreet}` : ''}{closure.toStreet ? ` to ${closure.toStreet}` : ''}<br />{closure.laneImpact}<br />{closure.locationDescription}<br />{formatDate(closure.startAt)} – {formatDate(closure.endAt)}</Popup>
  </GeoJSON>;
}

function ReportMarker({ report }: { report: StreetReport }) {
  return <CircleMarker center={[report.latitude, report.longitude]} radius={6} pathOptions={{ color: '#a95242', weight: 2, fillColor: '#d77b61', fillOpacity: 0.9 }}>
    <Popup><strong>{report.category}</strong><br />{report.address}<br />{report.detail}<br />Status: {report.status}<br />Reported {formatDate(report.reportedAt)}<br /><em>Unverified public 311 report; not a confirmed hazard.</em></Popup>
  </CircleMarker>;
}

function App() {
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState(DEFAULT_DESTINATION);
  const [layers, setLayers] = useState({ network: true, stations: true, closures: true, reports: false });
  const [submittedInputs, setSubmittedInputs] = useState({ origin: DEFAULT_ORIGIN, destination: DEFAULT_DESTINATION });
  const initialRequestStarted = useRef(false);
  const networkQuery = useGetBikeNetwork();
  const stationsQuery = useGetBikeStations({ query: { queryKey: getGetBikeStationsQueryKey(), refetchInterval: 60_000 } });
  const conditionsQuery = useGetStreetConditions({ query: { queryKey: getGetStreetConditionsQueryKey(), refetchInterval: 300_000 } });
  const routeMutation = usePlanBikeRoute();
  const route = routeMutation.data;

  useEffect(() => {
    if (initialRequestStarted.current) return;
    initialRequestStarted.current = true;
    routeMutation.mutate({ data: { origin: DEFAULT_ORIGIN, destination: DEFAULT_DESTINATION } });
  // The initial example route is intentionally requested once on first visit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const segments = networkQuery.data?.segments ?? [];
  const stations = stationsQuery.data?.stations ?? [];
  const closures = conditionsQuery.data?.closures ?? [];
  const reports = conditionsQuery.data?.reports ?? [];
  const facilityKinds = useMemo(() => {
    const kinds = new Map<string, number>();
    segments.forEach((segment) => {
      const label = segment.sharrow ? 'Shared-lane markings' : segment.raised || /protected|cycle track|separated/i.test(`${segment.facilityType} ${segment.symbology}`)
        ? 'Protected / raised' : segment.buffered || /buffer/i.test(`${segment.facilityType} ${segment.symbology}`) ? 'Buffered' : segment.facilityType || segment.symbology || 'Other facilities';
      kinds.set(label, (kinds.get(label) ?? 0) + 1);
    });
    return [...kinds.entries()];
  }, [segments]);

  const submitRoute = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!origin.trim() || !destination.trim()) return;
    setSubmittedInputs({ origin: origin.trim(), destination: destination.trim() });
    routeMutation.mutate({ data: { origin: origin.trim(), destination: destination.trim() } });
  };

  const toggleLayer = (key: keyof typeof layers) => setLayers((current) => ({ ...current, [key]: !current[key] }));
  const routeFailed = routeMutation.isError;
  const stationFresh = stationsQuery.data?.updatedAt;
  const stationAge = stationFresh ? Math.max(0, Math.floor((Date.now() - new Date(stationFresh).getTime()) / 60_000)) : null;

  const searchForm = (mobile = false) => <form className="ls-form-stack" onSubmit={submitRoute} role="search" data-testid={mobile ? 'form-route-mobile' : 'form-route'}>
    {!mobile && <label className="ls-search-label" htmlFor="origin-input">Where are you riding?</label>}
    <div className="ls-searchbox">
      <MapPin size={14} aria-hidden="true" color="#789087" />
      <input id={mobile ? undefined : 'origin-input'} aria-label="Route origin" data-testid={mobile ? 'input-origin-mobile' : 'input-origin'} value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="Origin in San Francisco" />
    </div>
    <div className="ls-searchbox">
      <Search size={14} aria-hidden="true" color="#789087" />
      <input aria-label="Route destination" data-testid={mobile ? 'input-destination-mobile' : 'input-destination'} value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Destination in San Francisco" />
      <button type="submit" aria-label="Plan bicycle route" data-testid={mobile ? 'button-plan-route-mobile' : 'button-plan-route'} disabled={routeMutation.isPending}><ArrowRight size={15} /></button>
    </div>
    {routeFailed && <div className="ls-search-error" role="alert" data-testid="status-route-error">{errorMessage(routeMutation.error)} <button type="button" data-testid="button-retry-route" onClick={() => routeMutation.mutate({ data: submittedInputs })}>Try again</button></div>}
    {routeMutation.isPending && <div className="ls-caption" role="status" data-testid="status-route-loading">Finding a low-traffic route on the OSM street network…</div>}
  </form>;

  const layerButton = (key: keyof typeof layers, title: string, Icon: typeof Bike) => <button type="button" className={`ls-layer-chip ${layers[key] ? 'active' : ''}`} onClick={() => toggleLayer(key)} aria-pressed={layers[key]} data-testid={`toggle-layer-${key}`}><Icon size={13} />{title}</button>;

  return <div className="ls-app">
    <header className="ls-header">
      <div className="ls-brand"><span className="ls-brand-mark"><Bike size={18} strokeWidth={2.2} /></span>LaneSight</div>
      <div className="ls-header-note"><span className="ls-live-dot" />San Francisco, by street and by source</div>
    </header>
    <main className="ls-layout">
      <aside className="ls-sidebar">
        <div className="ls-mobile-heading"><span className="ls-eyebrow">San Francisco · bicycle routing</span><strong>Plan a city ride</strong></div>
        <div className="ls-sheet-handle" />
        <div className="ls-desktop-only">
          <div className="ls-eyebrow">San Francisco · bicycle routing</div>
          <h1 className="ls-title">Know the lane<br />before you ride.</h1>
          <p className="ls-intro">Low-traffic street routing, official bikeway inventory and live Bay Wheels availability in one citywide view.</p>
          <div style={{ marginTop: 17 }}>{searchForm()}</div>
        </div>
        <div className="ls-mobile-search-area">{searchForm(true)}</div>
        <section className="ls-trip-card" data-testid="route-summary">
          <div className="ls-trip-top"><strong>Planned route</strong><span className={`ls-pill ${routeMutation.isPending || (!route && routeMutation.isIdle) ? 'pending' : ''}`} data-testid="status-route-state">{routeMutation.isPending || (!route && routeMutation.isIdle) ? 'Calculating' : route ? 'OSM bike route' : 'No route'}</span></div>
          <div className="ls-places">
            <div className="ls-place-dots"><i /><i /></div>
            <div className="ls-place-lines">
              <div><small>ORIGIN</small><strong data-testid="text-route-origin">{route?.origin.label ?? submittedInputs.origin}</strong></div>
              <div><small>DESTINATION</small><strong data-testid="text-route-destination">{route?.destination.label ?? submittedInputs.destination}</strong></div>
            </div>
          </div>
          {route ? <div className="ls-trip-stats" data-testid="route-metrics">
            <div className="ls-stat"><Navigation size={14} color="#438069" /><div><strong data-testid="text-route-distance">{formatDistance(route.distanceMeters)}</strong><span>street distance</span></div></div>
            <div className="ls-stat"><Clock3 size={14} color="#438069" /><div><strong data-testid="text-route-duration">{formatDuration(route.durationSeconds)}</strong><span>ride estimate</span></div></div>
          </div> : <p className="ls-stat-note" data-testid="text-route-empty">{routeMutation.isPending ? 'Route details will appear when routing completes.' : 'Enter two San Francisco places to plan a route.'}</p>}
          {route && <p className="ls-stat-note" data-testid="text-route-source">Low-traffic OSM bicycle route · {route.profile} · {route.source}</p>}
        </section>

        <section aria-label="Bicycle infrastructure" data-testid="section-network">
          <div className="ls-section-label"><strong>Official bikeway network</strong><span>{networkQuery.data ? `${networkQuery.data.total} segments` : 'City inventory'}</span></div>
          <div className="ls-legend-list">
            <button className={`ls-legend-row ${layers.network ? '' : 'off'}`} type="button" onClick={() => toggleLayer('network')} aria-pressed={layers.network} data-testid="toggle-layer-network-list"><i className="ls-line-swatch protected" /><span>Show SFMTA inventory</span></button>
          </div>
          {networkQuery.isLoading && <div className="ls-loading-line" data-testid="loading-network" />}
          {networkQuery.isError && <p className="ls-search-error" role="status" data-testid="status-network-error">Bikeway inventory unavailable. Map still shows available layers.</p>}
          {networkQuery.data && <><div className="ls-legend-list" data-testid="list-facility-types">
            {facilityKinds.slice(0, 5).map(([label, count]) => <div className="ls-legend-row" key={label} data-testid={`facility-type-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}><i className={`ls-line-swatch ${/shared/i.test(label) ? 'sharrow' : /buffer/i.test(label) ? 'buffered' : /protected|raised/i.test(label) ? 'protected' : 'other'}`} /><span>{label} <small>· {count}</small></span></div>)}
          </div><div className="ls-source-updated" data-testid="text-network-freshness">SFMTA data updated {formatDate(networkQuery.data.sourceUpdatedAt)}</div></>}
        </section>

        <section className="ls-data-section" aria-label="Bay Wheels stations" data-testid="section-stations">
          <div className="ls-section-label"><strong>Bay Wheels</strong><span data-testid="text-stations-freshness">{stationsQuery.isLoading ? 'Loading live feed' : stationAge === null ? 'Live availability' : stationAge < 2 ? 'Updated just now' : `Updated ${stationAge}m ago`}</span></div>
          {stationsQuery.isLoading && <div className="ls-data-list" data-testid="loading-stations"><div className="ls-loading-line" /><div className="ls-loading-line" /></div>}
          {stationsQuery.isError && <p className="ls-search-error" role="status" data-testid="status-stations-error">Station feed unavailable. Other map data remains available.</p>}
          {stationsQuery.data && <div className="ls-data-list" data-testid="list-stations">
            {stations.slice(0, 5).map((station) => <div className="ls-data-row" key={station.id} data-testid={`row-station-${station.id}`}><span className="ls-data-icon"><Bike size={14} /></span><span className="ls-data-name" title={station.name}>{station.shortName || station.name}</span><span className="ls-data-count">{station.isRenting ? `${station.bikesAvailable} bikes` : 'Not renting'}</span></div>)}
            {stations.length === 0 && <p className="ls-empty" data-testid="empty-stations">No Bay Wheels stations were returned.</p>}
          </div>}
          {stationsQuery.data && <p className="ls-caption" data-testid="text-station-refresh">Feed fetched {formatDate(stationsQuery.data.fetchedAt)} · refreshes every {Math.round(stationsQuery.data.ttlSeconds / 60)} min</p>}
        </section>

        <section className="ls-data-section conditions-section" aria-label="Street conditions" data-testid="section-conditions">
          <div className="ls-section-label"><strong>Restrictions & reports</strong><span>Permitted / recent</span></div>
          <div className="ls-data-list">
            {conditionsQuery.isLoading && <><div className="ls-loading-line" /><div className="ls-loading-line" /></>}
            {conditionsQuery.isError && <p className="ls-search-error" role="status" data-testid="status-conditions-error">Street condition data unavailable.</p>}
            {conditionsQuery.data && closures.length === 0 && reports.length === 0 && <p className="ls-empty" data-testid="empty-conditions">No active restrictions or recent open reports returned.</p>}
            {closures.slice(0, 3).map((closure) => <div className="ls-data-row" key={closure.id} data-testid={`row-closure-${closure.id}`}><span className="ls-data-icon" style={{ color: '#ad5847', background: '#f2e5dc' }}><ShieldCheck size={14} /></span><span className="ls-data-name" title={`${closure.street} · ${closure.name}`}>{closure.street} · {closure.type}</span><span className="ls-data-count">Restriction</span></div>)}
            {reports.slice(0, 3).map((report) => <div className="ls-data-row" key={report.id} data-testid={`row-report-${report.id}`}><span className="ls-data-icon" style={{ color: '#ad5847', background: '#f2e5dc' }}><MapPin size={14} /></span><span className="ls-data-name" title={`${report.category}: ${report.detail}`}>{report.category} · unverified</span><span className="ls-data-count">311</span></div>)}
          </div>
          <p className="ls-caption" data-testid="text-reports-disclaimer">311 items are public reports, unverified and not confirmed hazards. Conditions refresh every 5 minutes.</p>
          {conditionsQuery.data && <div className="ls-source-updated" data-testid="text-conditions-freshness">Conditions fetched {formatDate(conditionsQuery.data.fetchedAt)}</div>}
        </section>
      </aside>

      <section className="ls-map-wrap" aria-label="San Francisco bicycle route map" data-testid="map-panel">
        <MapContainer center={SF_CENTER} zoom={13} scrollWheelZoom className="leaflet-container" zoomControl={false} data-testid="street-map">
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
          <ZoomToRoute route={route} />
          {layers.network && segments.map((segment) => <GeoJSON key={segment.id} data={segment.geometry as never} style={() => facilityStyle(segment)}>
            <Popup><strong>{segment.streetName}</strong><br />{segmentDescription(segment)}<br />{segment.fromStreet && segment.toStreet ? `${segment.fromStreet} to ${segment.toStreet}` : ''}<br />SFMTA inventory{segment.dataAsOf ? ` · ${formatDate(segment.dataAsOf)}` : ''}</Popup>
          </GeoJSON>)}
          {layers.stations && stations.map((station) => <CircleMarker key={station.id} center={[station.latitude, station.longitude]} radius={7} pathOptions={{ color: '#286c53', weight: 2, fillColor: '#70a881', fillOpacity: 0.92 }}>
            <Popup><strong>{station.name}</strong><br />{station.bikesAvailable} bikes · {station.ebikesAvailable} e-bikes<br />{station.docksAvailable} docks available<br />{station.isRenting ? 'Rentals available' : 'Not renting'} · {station.isReturning ? 'Returns accepted' : 'Returns unavailable'}<br />Last reported {formatDate(station.lastReported)}</Popup>
          </CircleMarker>)}
          {layers.closures && closures.map((closure) => <ConditionGeometry key={closure.id} closure={closure} visible={layers.closures} />)}
          {layers.reports && reports.map((report) => <ReportMarker key={report.id} report={report} />)}
          {route && routeCoordinates(route).length > 0 && <>
            <Polyline positions={routeCoordinates(route)} pathOptions={{ color: '#fffef8', weight: 10, opacity: 0.92, lineCap: 'round', lineJoin: 'round' }} />
            <Polyline positions={routeCoordinates(route)} pathOptions={{ color: '#267b5b', weight: 6, opacity: 0.96, lineCap: 'round', lineJoin: 'round' }}>
              <Popup><strong>Low-traffic bicycle route</strong><br />Based on the OpenStreetMap street network. Not guaranteed to be protected throughout.</Popup>
            </Polyline>
            <CircleMarker center={[route.origin.latitude, route.origin.longitude]} radius={8} pathOptions={{ color: '#287258', weight: 3, fillColor: '#fffdf5', fillOpacity: 1 }}><Popup><strong>Origin</strong><br />{route.origin.label}</Popup></CircleMarker>
            <CircleMarker center={[route.destination.latitude, route.destination.longitude]} radius={8} pathOptions={{ color: '#fffdf5', weight: 3, fillColor: '#287258', fillOpacity: 1 }}><Popup><strong>Destination</strong><br />{route.destination.label}</Popup></CircleMarker>
          </>}
          <MapZoomButtons />
        </MapContainer>
        <div className="ls-route-label" data-testid="route-map-label"><span className="ls-live-dot" /><div><small>{route ? 'LOW-TRAFFIC OSM BIKE ROUTE' : 'SAN FRANCISCO STREET MAP'}</small><strong>{route ? `${route.origin.label} → ${route.destination.label}` : 'Citywide bicycle infrastructure'}</strong></div></div>
        <div className="ls-map-layers" aria-label="Map layers" data-testid="map-layer-controls">
          {layerButton('network', 'Bike lanes', ShieldCheck)}
          {layerButton('stations', 'Bay Wheels', Bike)}
          {layerButton('closures', 'Restrictions', RotateCw)}
          {layerButton('reports', 'Open 311', MapPin)}
        </div>
        {routeFailed && <div className="ls-map-error" role="alert" data-testid="map-route-error"><strong>Could not plan this route</strong>{errorMessage(routeMutation.error)}<br />Try a different San Francisco origin or destination.</div>}
        <div className="ls-map-attribution" data-testid="text-map-attribution">Map tiles © CARTO · Street data © OpenStreetMap contributors</div>
      </section>
    </main>
  </div>;
}

export default App;
