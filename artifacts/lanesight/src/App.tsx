import { useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Bike, ChevronRight, Clock3, Minus, Navigation, Plus, Search, ShieldCheck, X } from 'lucide-react';

type Destination = { name: string; distance: string; time: string; end: string; landmark: string };
type Feature = { title: string; kind: 'lane' | 'hazard' | 'dock'; kicker: string; details: string[] };

const destinations: Destination[] = [
  { name: 'Ferry Building', distance: '2.1 mi', time: '14 min', end: 'Ferry Building', landmark: 'Ferry Building' },
  { name: 'Oracle Park', distance: '2.4 mi', time: '16 min', end: 'Oracle Park', landmark: 'Oracle Park' },
  { name: 'Painted Ladies', distance: '2.0 mi', time: '15 min', end: 'Painted Ladies', landmark: 'Alamo Square' },
  { name: 'Pier 39', distance: '2.8 mi', time: '19 min', end: 'Pier 39', landmark: 'Pier 39' },
  { name: 'Salesforce Park', distance: '1.2 mi', time: '9 min', end: 'Salesforce Park', landmark: 'Salesforce Park' },
];

const features: Record<string, Feature> = {
  track: { title: 'Two-way protected cycle track', kind: 'lane', kicker: 'Protected lane', details: ['Smooth pavement along the route.', 'Separated from traffic by a raised concrete curb.'] },
  center: { title: 'Center-running bike lane', kind: 'lane', kicker: 'Caution advised', details: ['Lane runs between traffic lanes.', 'Watch for turning vehicles at intersections.'] },
  rough: { title: 'Rough road & construction', kind: 'hazard', kicker: 'Surface hazard', details: ['Active road resurfacing reported.', 'Slow down for loose gravel and uneven pavement.'] },
  civic: { title: 'Civic Center bike dock', kind: 'dock', kicker: 'Sample availability', details: ['12 bikes shown available.', 'Counts are static demo data, not live dock status.'] },
  powell: { title: 'Powell St station dock', kind: 'dock', kicker: 'Sample availability', details: ['8 bikes shown available.', 'Counts are static demo data, not live dock status.'] },
  ferry: { title: 'Ferry Building bike dock', kind: 'dock', kicker: 'Sample availability', details: ['15 bikes shown available.', 'Counts are static demo data, not live dock status.'] },
};

function MapArtwork({ zoom, visible, onFeature, destination }: { zoom: number; visible: Record<string, boolean>; onFeature: (id: string) => void; destination: Destination }) {
  const endpoints: Record<string, { x: number; y: number; labelX: number; labelY: number }> = {
    'Ferry Building': { x: 724, y: 204, labelX: 725, labelY: 164 },
    'Oracle Park': { x: 692, y: 585, labelX: 696, labelY: 617 },
    'Painted Ladies': { x: 95, y: 276, labelX: 35, labelY: 249 },
    'Pier 39': { x: 798, y: 77, labelX: 766, labelY: 49 },
    'Salesforce Park': { x: 594, y: 460, labelX: 600, labelY: 489 },
  };
  const end = endpoints[destination.name] ?? endpoints['Ferry Building'];
  const marker = (id: string, x: number, y: number, label: string, fill: string, symbol: string, size = 31) => (
    <g className="ls-map-pin" role="button" tabIndex={0} aria-label={label} onClick={() => onFeature(id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onFeature(id); }}>
      <title>{label}</title>
      <circle className="pin-shadow" cx={x} cy={y} r={size / 2} fill={fill} stroke="#fffdf5" strokeWidth="3" />
      <text x={x} y={y + 4} textAnchor="middle" fontSize={symbol.length > 1 ? 10 : 13} fontWeight="800" fill="#fffdf5">{symbol}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 900 800" preserveAspectRatio="xMidYMid slice" aria-label="Illustrated San Francisco bicycle route map">
      <defs>
        <pattern id="park-hatch" width="12" height="12" patternTransform="rotate(32)" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#dce7d4" /><path d="M0 0v12" stroke="#d1dfc9" strokeWidth="2" /></pattern>
        <filter id="route-shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      <rect width="900" height="800" fill="#e9ece2" />
      <g className="map-grid" transform={`translate(450 400) scale(${zoom}) translate(-450 -400)`}>
        <path d="M0 0H900V800H0z" fill="#e9ece2" />
        <path d="M76 0h96v132H76zM207 22h118v104H207zM366 0h118v124H366zM521 13h105v113H521zM666 0h105v130H666zM806 0h94v132h-94zM15 176h123v102H15zM181 163h123v121H181zM342 157h105v126H342zM485 165h129v118H485zM650 170h118v110H650zM806 164h94v119h-94zM0 324h139v112H0zM179 313h115v117H179zM333 319h111v110H333zM488 316h114v116H488zM641 312h132v118H641zM806 322h94v110h-94zM13 477h126v111H13zM181 465h122v116H181zM342 466h105v117H342zM493 467h120v118H493zM652 463h115v120H652zM806 469h94v117h-94zM0 632h141v116H0zM180 619h118v124H180zM340 624h111v121H340zM492 621h121v126H492zM650 628h121v119H650zM805 619h95v126h-95z" fill="#f3f1e8" stroke="#e0e1d7" strokeWidth="2" />
        <path d="M355 24h100v108H355zM504 329h128v96H504zM22 487h108v92H22z" fill="url(#park-hatch)" />
        <path d="M103 -30 164 830M267 -30 329 830M430 -30 493 830M594 -30 656 830M756 -30 819 830M-40 145h980M-40 295h980M-40 445h980M-40 595h980M-40 744h980" stroke="#fffdf6" strokeWidth="29" />
        <path d="M103 -30 164 830M267 -30 329 830M430 -30 493 830M594 -30 656 830M756 -30 819 830M-40 145h980M-40 295h980M-40 445h980M-40 595h980M-40 744h980" stroke="#d8d8cd" strokeWidth="1.5" />
        <path d="M80 -20 141 830M246 -20 308 830M409 -20 472 830M574 -20 636 830M739 -20 801 830M-40 130h980M-40 280h980M-40 430h980M-40 580h980M-40 729h980" stroke="#e3e1d8" strokeWidth="1" strokeDasharray="3 7" />
        <path d="M145 652 364 424" fill="none" stroke="#294b4020" strokeWidth="19" strokeLinecap="round" filter="url(#route-shadow)" />
        {visible.safe && <path d="M145 652 364 424" fill="none" stroke="#35886b" strokeWidth="10" strokeLinecap="round" />}
        {visible.caution && <path d="M364 424 566 326" fill="none" stroke="#e4ae3d" strokeWidth="10" strokeLinecap="round" />}
        {visible.hazard && <path d={`M566 326 ${end.x} ${end.y}`} fill="none" stroke="#c95d4a" strokeWidth="10" strokeLinecap="round" />}
        {visible.safe && <path d="M145 652 364 424" fill="none" stroke="#eff6e8" strokeWidth="2" strokeDasharray="3 13" strokeLinecap="round" />}
        {visible.caution && <path d="M364 424 566 326" fill="none" stroke="#fff4d1" strokeWidth="2" strokeDasharray="3 13" strokeLinecap="round" />}
        {visible.hazard && <path d={`M566 326 ${end.x} ${end.y}`} fill="none" stroke="#fce5db" strokeWidth="2" strokeDasharray="3 13" strokeLinecap="round" />}
        <text x="80" y="688" fill="#73847b" fontSize="11" fontWeight="700" letterSpacing="1">CIVIC CENTER</text>
        <text x="300" y="496" fill="#7d8c83" fontSize="10" transform="rotate(-45 300 496)">MARKET ST</text>
        <text x="476" y="398" fill="#7d8c83" fontSize="10" transform="rotate(-25 476 398)">5TH ST</text>
        <text x="648" y="277" fill="#7d8c83" fontSize="10" transform="rotate(-37 648 277)">EMBARCADERO</text>
        <text x={end.labelX} y={end.labelY} fill="#73847b" fontSize="11" fontWeight="700" letterSpacing=".7">{destination.landmark.toUpperCase()}</text>
        <text x="367" y="91" fill="#8c9b90" fontSize="10" letterSpacing="1">UNION SQUARE</text>
        <text x="36" y="544" fill="#829388" fontSize="10" letterSpacing=".8">CIVIC CENTER PLAZA</text>
        <g fill="#dfddd1" fontSize="9" fontWeight="600">
          <text x="192" y="206">TURK ST</text><text x="533" y="204">SUTTER ST</text><text x="202" y="364">MISSION ST</text>
          <text x="690" y="508">HOWARD ST</text><text x="350" y="558">FOLSOM ST</text>
        </g>
        {visible.notes && marker('track', 287, 505, 'Two-way protected cycle track details', '#327b63', '↔')}
        {visible.notes && marker('center', 489, 363, 'Center-running bike lane details', '#327b63', '↑')}
        {visible.notes && marker('rough', 650, 263, 'Rough road and construction hazard', '#c95d4a', '!')}
        {visible.docks && marker('civic', 126, 604, 'Civic Center dock: 12 demo bikes', '#28674f', '12')}
        {visible.docks && marker('powell', 407, 410, 'Powell St dock: 8 demo bikes', '#28674f', '8')}
        {visible.docks && marker('ferry', 749, 214, 'Ferry Building dock: 15 demo bikes', '#28674f', '15')}
        <circle cx="145" cy="652" r="10" fill="#fffdf6" stroke="#327b63" strokeWidth="4" />
        <circle cx={end.x} cy={end.y} r="10" fill="#327b63" stroke="#fffdf6" strokeWidth="4" />
      </g>
    </svg>
  );
}

function App() {
  const [query, setQuery] = useState('Ferry Building, San Francisco');
  const [destination, setDestination] = useState(destinations[0]);
  const [searchError, setSearchError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [visible, setVisible] = useState({ safe: true, caution: true, hazard: true, docks: true, notes: true });

  const selected = selectedFeature ? features[selectedFeature] : null;
  const changeVisibility = (key: keyof typeof visible) => setVisible((current) => ({ ...current, [key]: !current[key] }));
  const setDestinationFromSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = query.toLowerCase().replace(/,?\s*san francisco(,?\s*ca)?/g, '').trim();
    const match = destinations.find((item) => item.name.toLowerCase() === normalized || item.name.toLowerCase().includes(normalized) && normalized.length > 2);
    if (!match) {
      setSearchError('Not in this demo yet. Try Ferry Building, Oracle Park, Painted Ladies, Pier 39, or Salesforce Park.');
      return;
    }
    setDestination(match);
    setQuery(`${match.name}, San Francisco`);
    setSearchError('');
    setZoom(1);
    setSelectedFeature(null);
  };
  const routeInstruction = useMemo(() => destination.name === 'Ferry Building' ? 'Continue on the protected track toward the waterfront.' : `Follow the demo route from Civic Center toward ${destination.name}.`, [destination.name]);

  const searchBox = (mobile = false) => (
    <form className={`ls-searchbox ${mobile ? 'ls-mobile-search' : ''}`} onSubmit={setDestinationFromSearch} role="search">
      <Search size={16} aria-hidden="true" color="#789087" />
      <input id={mobile ? undefined : 'destination-search'} aria-label="Search demo destination" data-testid={mobile ? 'input-destination-mobile' : 'input-destination'} value={query} onChange={(event) => { setQuery(event.target.value); setSearchError(''); }} placeholder="Search a demo destination" />
      <button type="submit" aria-label="Find demo destination" data-testid={mobile ? 'button-search-mobile' : 'button-search'}><ArrowRight size={16} /></button>
    </form>
  );

  const legendToggle = (key: keyof typeof visible, title: string, color: string) => (
    <button className={`ls-legend-row ${visible[key] ? '' : 'off'}`} type="button" onClick={() => changeVisibility(key)} aria-pressed={visible[key]} data-testid={`toggle-${key}`}>
      <i className={`ls-line-swatch ${color}`} /><span>{title}</span>
    </button>
  );

  return (
    <div className="ls-app">
      <header className="ls-header">
        <div className="ls-brand"><span className="ls-brand-mark"><Bike size={19} strokeWidth={2.2} /></span>LaneSight</div>
        <div className="ls-header-note"><span className="ls-live-dot" />A clearer read on your ride</div>
      </header>
      <main className="ls-layout">
        <aside className="ls-sidebar ls-bottom-sheet">
          <div className="ls-mobile-heading"><span className="ls-eyebrow">San Francisco · demo route</span><strong>Plan a safer ride</strong></div>
          <div className="ls-sheet-handle" />
          <div className="ls-desktop-only">
            <div className="ls-eyebrow">San Francisco · demo route</div>
            <h1 className="ls-title">Know the lane<br />before you ride.</h1>
            <p className="ls-intro">A street-level view of protected lanes, surface notes, and bike-share docks.</p>
            <div style={{ marginTop: 20 }}>
              <label className="ls-search-label" htmlFor="destination-search">Where are you riding?</label>
              {searchBox()}
              {searchError && <p className="ls-search-error" role="alert" data-testid="status-search-error">{searchError}</p>}
              <div className="ls-demo-hint">Try Ferry Building, Oracle Park, Pier 39, or Painted Ladies.</div>
            </div>
          </div>
          <div className="ls-mobile-search-area">
            {searchBox(true)}
            {searchError && <p className="ls-search-error" role="alert" data-testid="status-search-error-mobile">{searchError}</p>}
          </div>
          <section className="ls-trip-card" data-testid="route-summary">
            <div className="ls-trip-top"><strong>Your route</strong><span className="ls-demo-tag">Sample trip</span></div>
            <div className="ls-places">
              <div className="ls-place-dots"><i /><i /></div>
              <div className="ls-place-lines">
                <div><small>START</small><strong>Civic Center</strong></div>
                <div><small>DESTINATION</small><strong>{destination.end}</strong></div>
              </div>
            </div>
            <div className="ls-trip-stats">
              <div className="ls-stat"><Navigation size={15} color="#438069" /><div><strong>{destination.distance}</strong><span>route length</span></div></div>
              <div className="ls-stat"><Clock3 size={15} color="#438069" /><div><strong>{destination.time}</strong><span>ride estimate</span></div></div>
            </div>
          </section>
          <section className="ls-legend-section">
            <div className="ls-section-label"><strong>Street conditions</strong><span>Tap to show / hide</span></div>
            <div className="ls-legend-list">
              {legendToggle('safe', 'Protected', '')}
              {legendToggle('caution', 'Caution', 'caution')}
              {legendToggle('hazard', 'Hazard', 'hazard')}
            </div>
          </section>
          <section className="ls-docks">
            <div className="ls-section-label"><strong>Bike-share docks</strong><span>Demo availability</span></div>
            <div className="ls-dock-list">
              {[['Civic Center', '12'], ['Powell St Station', '8'], ['Ferry Building', '15']].map(([name, count]) => (
                <div className="ls-dock-row" key={name}><span className="ls-dock-icon"><Bike size={15} /></span><span className="ls-dock-name">{name}</span><span className="ls-dock-count">{count} open</span></div>
              ))}
            </div>
            <p className="ls-dock-caption">Illustrative counts only. Dock availability is sample data, not live.</p>
          </section>
          <div className="ls-go-wrap">
            <button className="ls-go" type="button" onClick={() => setNavigating((current) => !current)} data-testid="button-navigation">
              {navigating ? <><X size={16} /> Exit mock navigation</> : <><Navigation size={15} /> Start mock navigation <ChevronRight size={16} /></>}
            </button>
            <p className="ls-go-note">Preview only · does not use GPS or provide turn-by-turn guidance</p>
          </div>
        </aside>
        <section className="ls-map-wrap" aria-label="Route map">
          <div className="ls-map"><MapArtwork zoom={zoom} visible={visible} onFeature={setSelectedFeature} destination={destination} /></div>
          <div className="ls-route-label"><span className="ls-live-dot" /><div><small>SAFE ROUTE PREVIEW</small><strong>Civic Center <ArrowRight size={12} style={{ display: 'inline', verticalAlign: '-2px' }} /> {destination.end}</strong></div></div>
          <div className="ls-map-controls" aria-label="Map zoom controls">
            <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.5, +(value + .12).toFixed(2)))} disabled={zoom >= 1.5} data-testid="button-zoom-in"><Plus size={18} /></button>
            <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(.82, +(value - .12).toFixed(2)))} disabled={zoom <= .82} data-testid="button-zoom-out"><Minus size={18} /></button>
          </div>
          <div className="ls-map-layers">
            <button type="button" className={`ls-layer-chip ${visible.notes ? 'active' : ''}`} onClick={() => changeVisibility('notes')} aria-pressed={visible.notes} data-testid="toggle-lane-notes"><ShieldCheck size={13} /> Lane notes</button>
            <button type="button" className={`ls-layer-chip ${visible.docks ? 'active' : ''}`} onClick={() => changeVisibility('docks')} aria-pressed={visible.docks} data-testid="toggle-docks"><Bike size={13} /> Docks</button>
          </div>
          {navigating && <div className="ls-nav-banner" role="status" data-testid="status-navigation"><span className="ls-nav-step">1</span><div><strong>Mock ride preview</strong><span>{routeInstruction}</span></div><button type="button" onClick={() => setNavigating(false)} data-testid="button-exit-navigation">End preview</button></div>}
          {selected && <div className="ls-info-card" role="dialog" aria-label={selected.title} data-testid={`info-${selectedFeature}`}>
            <button className="ls-info-close" type="button" onClick={() => setSelectedFeature(null)} aria-label="Close details"><X size={15} /></button>
            <p className="ls-info-kicker">{selected.kicker}</p><h3>{selected.title}</h3>
            {selected.details.map((detail) => <p key={detail}>{detail}</p>)}
          </div>}
          <div className="ls-map-attribution">Illustrated map · sample route and dock data</div>
        </section>
      </main>
    </div>
  );
}

export default App;
