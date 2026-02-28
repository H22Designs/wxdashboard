"use strict";

Chart.defaults.color = "#7a90ae";
Chart.defaults.borderColor = "#1e3050";
Chart.defaults.font.family = "'Inter', 'Segoe UI', system-ui, sans-serif";
Chart.defaults.font.size = 11;

// ── State ────────────────────────────────────────────────────────────────────
const charts = {};
let currentStation = "KALMILLP10";
let currentHours = 24;
let customStart = null;
let customEnd = null;
let refreshMs = 30000;
let useCelsius = false;
let refreshTimer = null;
let stationMap = null;
let mapMarker = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
let currentUser = null;
let stationList = [];
const fmt = (v, dec = 1, fb = "—") => v == null ? fb : Number(v).toFixed(dec);
const toC = f => f == null ? null : (f - 32) * 5 / 9;
const tempStr = f => {
    if (f == null) return "—";
    return useCelsius ? toC(f).toFixed(1) + "°C" : Math.round(f) + "°F";
};
const tempVal = f => {
    if (f == null) return "—";
    return useCelsius ? toC(f).toFixed(0) : Math.round(f).toString();
};

const degToCardinal = d => {
    if (d == null) return "—";
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
        "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return dirs[Math.round(d / 22.5) % 16];
};

const uvLabel = v => {
    if (v == null) return ["—", "", ""];
    if (v < 3) return [v.toFixed(1), "uv-low", "Low"];
    if (v < 6) return [v.toFixed(1), "uv-mod", "Moderate"];
    if (v < 8) return [v.toFixed(1), "uv-high", "High"];
    if (v < 11) return [v.toFixed(1), "uv-vhigh", "Very High"];
    return [v.toFixed(1), "uv-ext", "Extreme"];
};

const isNight = timeStr => {
    if (!timeStr) return false;
    const date = new Date(timeStr);
    const h = date.getHours();
    // Heuristic: night is between 7 PM and 6 AM
    return h >= 19 || h < 6;
};

const weatherIcon = (temp, uv, rain, obsTime) => {
    const night = isNight(obsTime);
    if (rain > 0) return "🌧️";
    if (night) {
        if (temp < 32) return "❄️\uFE0E🌙";
        return "🌙";
    }
    if (uv > 6) return "☀️";
    if (uv > 2) return "🌤️";
    if (temp < 32) return "❄️";
    return "⛅";
};

const updateDynamicTheme = (d) => {
    document.body.classList.remove('theme-sunny', 'theme-rainy', 'theme-stormy', 'theme-cold', 'theme-hot');

    if (d.precip_rate_in_hr > 0.1 || d.precip_total_in > 0.5) {
        document.body.classList.add('theme-rainy');
    } else if (d.temp_f > 90) {
        document.body.classList.add('theme-hot');
    } else if (d.temp_f < 32) {
        document.body.classList.add('theme-cold');
    } else if (d.uv_index > 8) {
        document.body.classList.add('theme-sunny');
    } else {
        document.body.classList.add('theme-sunny'); // default
    }
};

const initStationMap = (lat, lon, name) => {
    if (!lat || !lon) return;
    const mapDiv = document.getElementById('station-map');
    if (!mapDiv) return;

    if (typeof L === 'undefined') {
        mapDiv.innerHTML = '<div style="padding:1rem; color:var(--text-muted); text-align:center;">Map library not loaded.</div>';
        return;
    }

    try {
        if (!stationMap) {
            stationMap = L.map('station-map').setView([lat, lon], 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(stationMap);
            mapMarker = L.marker([lat, lon]).addTo(stationMap);
        } else {
            stationMap.setView([lat, lon], 13);
            mapMarker.setLatLng([lat, lon]);
        }
        mapMarker.bindPopup(`<b>${name || currentStation}</b>`).openPopup();
    } catch (e) {
        mapDiv.innerHTML = '<div style="padding:1rem; color:var(--text-muted)">Map Error</div>';
    }
};

const baroTrend = rows => {
    if (!rows || rows.length < 3) return ["→", "steady"];
    const recent = rows.slice(-3).map(r => r.pressure_in).filter(v => v != null);
    if (recent.length < 2) return ["→", "steady"];
    const diff = recent[recent.length - 1] - recent[0];
    if (diff > 0.02) return ["↑", "rising"];
    if (diff < -0.02) return ["↓", "falling"];
    return ["→", "steady"];
};

function setText(id, val) { const el = $(id); if (el) el.textContent = val; }
function setWidth(id, val) { const el = $(id); if (el) el.style.width = val; }
function rotateNeedle(id, deg) { const el = $(id); if (el && deg != null) el.style.transform = `rotate(${deg}deg)`; }

// Min/max helpers from history
const hVals = (rows, key) => (rows || []).map(r => r[key]).filter(v => v != null);
const hMin = (rows, key) => { const v = hVals(rows, key); return v.length ? Math.min(...v) : null; };
const hMax = (rows, key) => { const v = hVals(rows, key); return v.length ? Math.max(...v) : null; };
const hAvg = (rows, key) => { const v = hVals(rows, key); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// ── URL builders ─────────────────────────────────────────────────────────────
function historyUrl() {
    const base = `/api/history?station=${currentStation}`;
    if (customStart && customEnd) {
        const s = new Date(customStart).toISOString();
        const e = new Date(customEnd).toISOString();
        return `${base}&start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}&limit=1000`;
    }
    return `${base}&hours=${currentHours}&limit=500`;
}

const timeframeLabel = () => {
    if (customStart && customEnd) return "Custom";
    if (currentHours <= 6) return "6h";
    if (currentHours <= 24) return "24h";
    if (currentHours <= 48) return "48h";
    return "5d";
};

// ── Settings persistence (localStorage) ──────────────────────────────────────
function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem("wx_settings") || "{}");
        if (s.station) currentStation = s.station;
        if (s.hours) currentHours = s.hours;
        if (s.refreshMs) refreshMs = s.refreshMs;
        if (s.useCelsius != null) useCelsius = s.useCelsius;

        // Card visibility
        if (s.hiddenCards) s.hiddenCards.forEach(id => {
            const cb = document.querySelector(`[data-card="${id}"]`);
            if (cb) cb.checked = false;
            const card = document.querySelector(`[data-card-id="${id}"]`);
            if (card) card.style.display = "none";
        });
        // Chart visibility
        if (s.hiddenCharts) s.hiddenCharts.forEach(id => {
            const cb = document.querySelector(`[data-chart="${id}"]`);
            if (cb) cb.checked = false;
            const card = document.querySelector(`[data-chart-id="${id}"]`);
            if (card) card.style.display = "none";
        });
        // Section toggles
        if (s.hideNearby) { $("toggle-nearby").checked = false; }
        if (s.hideDaily) { $("toggle-daily").checked = false; }
        if (s.hideAlerts) { $("toggle-alerts").checked = false; }
        // Refresh select
        const ri = $("refresh-interval");
        if (ri) ri.value = String(refreshMs / 1000);
        // Temp unit select
        const tu = $("temp-unit");
        if (tu) tu.value = useCelsius ? "c" : "f";
    } catch (e) { }
}

function saveSettings() {
    const hiddenCards = [];
    document.querySelectorAll("#card-toggles input").forEach(cb => {
        if (!cb.checked) hiddenCards.push(cb.dataset.card);
    });
    const hiddenCharts = [];
    document.querySelectorAll("#chart-toggles input").forEach(cb => {
        if (!cb.checked) hiddenCharts.push(cb.dataset.chart);
    });
    localStorage.setItem("wx_settings", JSON.stringify({
        station: currentStation,
        hours: currentHours,
        refreshMs,
        useCelsius,
        hiddenCards,
        hiddenCharts,
        hideNearby: !$("toggle-nearby")?.checked,
        hideDaily: !$("toggle-daily")?.checked,
        hideAlerts: !$("toggle-alerts")?.checked,
    }));
}

// ── Station tabs ─────────────────────────────────────────────────────────────
async function initStationTabs() {
    try {
        const stations = await fetch("/api/stations").then(r => r.json());
        const container = $("station-tabs");
        if (!container) return;
        container.innerHTML = "";
        stations.forEach(s => {
            const btn = document.createElement("button");
            btn.className = "station-tab" + (s.id === currentStation ? " active" : "");
            btn.textContent = s.id;
            btn.title = s.name;
            btn.addEventListener("click", () => {
                currentStation = s.id;
                container.querySelectorAll(".station-tab").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                setText("header-station-name", s.name || s.id);
                saveSettings();
                fetchAll();
            });
            container.appendChild(btn);
        });
        // Set header name for current station
        const cur = stations.find(s => s.id === currentStation);
        if (cur) setText("header-station-name", cur.name || cur.id);
    } catch (e) { }
}

// ── Settings panel wiring ────────────────────────────────────────────────────
function initSettings() {
    const toggle = $("settings-toggle");
    const panel = $("settings-panel");
    const close = $("settings-close");
    if (toggle && panel) {
        toggle.addEventListener("click", () => {
            panel.style.display = panel.style.display === "none" ? "" : "none";
        });
    }
    if (close && panel) {
        close.addEventListener("click", () => panel.style.display = "none");
    }

    // Auth & Station Management
    initAuth();
    initStationManagement();

    // Card toggles
    document.querySelectorAll("#card-toggles input").forEach(cb => {
        cb.addEventListener("change", () => {
            const card = document.querySelector(`[data-card-id="${cb.dataset.card}"]`);
            if (card) card.style.display = cb.checked ? "" : "none";
            saveSettings();
        });
    });

    // Chart toggles
    document.querySelectorAll("#chart-toggles input").forEach(cb => {
        cb.addEventListener("change", () => {
            const card = document.querySelector(`[data-chart-id="${cb.dataset.chart}"]`);
            if (card) card.style.display = cb.checked ? "" : "none";
            saveSettings();
        });
    });

    // Section toggles
    $("toggle-nearby")?.addEventListener("change", e => {
        const sec = $("nearby-section");
        if (sec) sec.style.display = e.target.checked ? "" : "none";
        saveSettings();
    });
    $("toggle-daily")?.addEventListener("change", e => {
        const sec = $("daily-section");
        if (sec) sec.style.display = e.target.checked ? "" : "none";
        saveSettings();
    });
    $("toggle-alerts")?.addEventListener("change", e => {
        const sec = $("alerts-container");
        if (sec) sec.style.display = e.target.checked ? "" : "none";
        saveSettings();
    });

    // Refresh interval
    $("refresh-interval")?.addEventListener("change", e => {
        refreshMs = parseInt(e.target.value) * 1000;
        clearInterval(refreshTimer);
        refreshTimer = setInterval(fetchAll, refreshMs);
        saveSettings();
    });

    // Temp unit
    $("temp-unit")?.addEventListener("change", e => {
        useCelsius = e.target.value === "c";
        setText("temp-unit-label", useCelsius ? "°C" : "°F");
        saveSettings();
        fetchAll();
    });
}

// ── DOM updaters ──────────────────────────────────────────────────────────────
function updateHero(d) {
    if (!d) return;
    setText("temp-val", tempVal(d.temp_f));
    setText("temp-unit-label", useCelsius ? "°C" : "°F");

    const iconEl = $("cond-icon");
    if (iconEl) iconEl.textContent = weatherIcon(d.temp_f, d.uv_index, d.precip_total_in || 0, d.obs_time_utc);

    const feels = d.wind_chill_f ?? d.heat_index_f ?? null;
    setText("feels-like", tempStr(feels));
    setText("dew-point", tempStr(d.dew_point_f));
    setText("humidity-val", d.humidity_pct != null ? Math.round(d.humidity_pct) + "%" : "—");

    const luEl = $("last-update-time");
    const hluEl = $("hero-last-update");
    if (d.obs_time_utc) {
        const dt = new Date(d.obs_time_utc);
        const timeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        if (luEl) luEl.textContent = timeStr;
        if (hluEl) hluEl.textContent = timeStr;
    }

    // Station Info Refinement
    const sid = d.station_id || currentStation;
    const station = stationList.find(s => s.id === sid);
    if (station) {
        setText("header-station-name", station.name);
        setText("header-station-id", `(${sid})`);
        setText("hero-station-id", sid);
        setText("hero-station-loc", d.neighborhood || "—");
    }

    const noData = $("no-data-state");
    const dash = $("dashboard-state");
    if (noData) noData.style.display = "none";
    if (dash) dash.style.display = "block";
}

function updateSummary(histRows) {
    setText("summary-label", timeframeLabel());
    if (!histRows || !histRows.length) return;
    setText("summary-high", tempStr(hMax(histRows, "temp_f")));
    setText("summary-low", tempStr(hMin(histRows, "temp_f")));
    const avgT = hAvg(histRows, "temp_f");
    setText("summary-avg", tempStr(avgT));
    setText("summary-rain", fmt(hMax(histRows, "precip_total_in"), 2) + '"');
    setText("summary-uv", fmt(hMax(histRows, "uv_index"), 0));
    setText("summary-gust", fmt(hMax(histRows, "wind_gust_mph"), 1) + " mph");
}

function updateMetrics(d, histRows) {
    if (!d) return;

    // Wind
    setText("wind-speed", fmt(d.wind_speed_mph, 1));
    setText("wind-gust", fmt(d.wind_gust_mph, 1));
    setText("wind-dir-txt", degToCardinal(d.wind_dir_deg));
    setText("wind-dir-deg", d.wind_dir_deg != null ? d.wind_dir_deg + "°" : "—");
    rotateNeedle("compass-needle-el", d.wind_dir_deg);
    setText("wind-max", fmt(hMax(histRows, "wind_speed_mph"), 1) + " mph");
    setText("gust-max", fmt(hMax(histRows, "wind_gust_mph"), 1) + " mph");

    // Humidity
    setWidth("hum-bar", (d.humidity_pct || 0) + "%");
    setText("hum-val2", fmt(d.humidity_pct, 0) + "%");
    setText("hum-high", fmt(hMax(histRows, "humidity_pct"), 0) + "%");
    setText("hum-low", fmt(hMin(histRows, "humidity_pct"), 0) + "%");

    // Pressure
    setText("baro-val", fmt(d.pressure_in, 2));
    const [tArrow, tClass] = baroTrend(histRows);
    const trendEl = $("baro-trend");
    if (trendEl) { trendEl.textContent = tArrow; trendEl.className = "trend-" + tClass; }
    setText("baro-high", fmt(hMax(histRows, "pressure_in"), 2) + " inHg");
    setText("baro-low", fmt(hMin(histRows, "pressure_in"), 2) + " inHg");
    if (d.pressure_in != null) {
        const dev = (d.pressure_in - 29.92).toFixed(2);
        const devEl = $("baro-dev");
        if (devEl) {
            const sign = dev > 0 ? "+" : "";
            devEl.innerHTML = parseFloat(dev) < 0
                ? `<span class="text-red">${sign}${dev} inHg</span>`
                : `<span class="text-green">${sign}${dev} inHg</span>`;
        }
    }

    // Rain
    setText("rain-rate", fmt(d.precip_rate_in_hr, 2));
    setText("rain-daily", fmt(d.precip_total_in, 2));
    setText("rain-max-rate", fmt(hMax(histRows, "precip_rate_in_hr"), 2) + " in/hr");

    // UV
    const [uvVal, uvCls, uvLbl] = uvLabel(d.uv_index);
    const uvEl = $("uv-val");
    if (uvEl) { uvEl.textContent = uvVal; uvEl.className = "metric-value " + uvCls; }
    setText("uv-label", uvLbl);
    setText("uv-max-val", fmt(hMax(histRows, "uv_index"), 1));

    // Solar
    setText("solar-val", fmt(d.solar_radiation_wm2, 0));
    const solarPct = d.solar_radiation_wm2 ? Math.min(d.solar_radiation_wm2 / 1200 * 100, 100) : 0;
    setWidth("solar-bar", solarPct + "%");

    // Dew Point
    setText("dewpt-val", tempVal(d.dew_point_f));
    if (d.temp_f != null && d.dew_point_f != null) setText("dewpt-spread", (d.temp_f - d.dew_point_f).toFixed(1) + "°");
    setText("dewpt-high", tempStr(hMax(histRows, "dew_point_f")));
    setText("dewpt-low", tempStr(hMin(histRows, "dew_point_f")));

    // Feels Like
    const feelsLike = d.wind_chill_f ?? d.heat_index_f ?? d.temp_f;
    setText("feelslike-val", tempVal(feelsLike));
    setText("heat-index-val", d.heat_index_f != null ? tempStr(d.heat_index_f) : "—");
    setText("wind-chill-val", d.wind_chill_f != null ? tempStr(d.wind_chill_f) : "—");

    // Station
    const station = stationList.find(s => s.id === currentStation);
    const coordsStr = station ? `${station.latitude.toFixed(4)}, ${station.longitude.toFixed(4)}` : "—";
    setText("station-id-display", d.station_id || currentStation);
    setText("station-readings", histRows ? histRows.length + " pts" : "—");
    setText("station-coords", coordsStr);

    if (station) {
        initStationMap(station.latitude, station.longitude, station.name);
    }
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function renderAlerts(alerts) {
    const container = $("alerts-container");
    if (!container) return;

    // Show station label
    setText("alerts-station-label", currentStation);

    // If no alerts, show the all-clear message
    if (!alerts || alerts.length === 0) {
        container.innerHTML = '<div class="alert-none">✅ No active watches or warnings for this area</div>';
        return;
    }

    container.innerHTML = "";
    alerts.forEach(a => {
        const sev = (a.severity || "").toLowerCase();
        let sevClass = "severity-advisory", icon = "⚠️";
        if (sev === "extreme" || sev === "severe") { sevClass = "severity-warning"; icon = "🚨"; }
        else if (sev === "moderate") { sevClass = "severity-watch"; }
        const div = document.createElement("div");
        div.className = `alert-banner ${sevClass}`;
        div.innerHTML = `
            <span class="alert-icon">${icon}</span>
            <div class="alert-content">
                <div class="alert-event">${a.event || "Weather Alert"}</div>
                <div class="alert-headline">${a.headline || ""}</div>
                ${a.expires ? `<div style="font-size:.7rem; color:var(--text-dim); margin-top:.3rem;">Expires: ${new Date(a.expires).toLocaleString()}</div>` : ""}
            </div>
        `;
        container.appendChild(div);
    });
}

// ── Nearby ────────────────────────────────────────────────────────────────────
function renderNearby(stations) {
    const section = $("nearby-section");
    const grid = $("nearby-grid");
    if (!section || !grid) return;
    if (!stations || stations.length === 0) { section.style.display = "none"; return; }
    if (!$("toggle-nearby")?.checked) { section.style.display = "none"; return; }
    section.style.display = "";
    grid.innerHTML = "";
    stations.forEach(s => {
        const card = document.createElement("div");
        card.className = "nearby-card";
        card.innerHTML = `<div class="nearby-station-id">${s.stationID}</div><div class="nearby-neighborhood">${s.neighborhood || ""}</div><div class="nearby-stats"><span>${s.temp_f != null ? s.temp_f + "°F" : "—"}</span><span>${s.humidity != null ? s.humidity + "%" : ""}</span><span>${s.wind_speed != null ? s.wind_speed + " mph" : ""}</span></div>`;
        grid.appendChild(card);
    });
}

// ── Charts ────────────────────────────────────────────────────────────────────
function buildChart(id, config) {
    const ctx = $(id);
    if (!ctx) return null;
    if (charts[id]) charts[id].destroy();

    // Inject Zoom Configuration
    if (!config.options.plugins) config.options.plugins = {};
    config.options.plugins.zoom = {
        pan: {
            enabled: true,
            mode: 'x',
            onPanComplete: syncChartsFromControl
        },
        zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x',
            onZoomComplete: syncChartsFromControl
        }
    };

    charts[id] = new Chart(ctx, config);
    return charts[id];
}

function syncChartsFromControl({ chart }) {
    if (!chart) return;
    const { min, max } = chart.scales.x;

    // Update Slider UI context
    const slider = $("charts-timeline-slider");
    if (slider) {
        const total = chart.data.labels.length;
        // This is a simplified mapping, real slider-to-zoom sync is handled in its listener
    }

    // Sync other charts
    Object.values(charts).forEach(c => {
        if (c !== chart) {
            c.options.scales.x.min = min;
            c.options.scales.x.max = max;
            c.update('none');
        }
    });

    const viewEl = $("slider-current-view");
    if (viewEl) {
        const start = new Date(min).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const end = new Date(max).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        viewEl.textContent = `${start} — ${end}`;
    }
}

// ── Timeline Slider Logic ────────────────────────────────────────────────────────
function initTimelineSlider() {
    const slider = $("charts-timeline-slider");
    const resetBtn = $("reset-charts-zoom");
    if (!slider) return;

    slider.oninput = function () {
        const pct = parseInt(this.value);
        Object.values(charts).forEach(c => {
            const labels = c.data.labels;
            if (!labels || labels.length < 2) return;

            const total = labels.length;
            const windowSize = Math.max(Math.floor(total * 0.2), 5); // 20% window
            const centerIdx = Math.floor((pct / 100) * (total - 1));

            const startIdx = Math.max(0, centerIdx - Math.floor(windowSize / 2));
            const endIdx = Math.min(total - 1, startIdx + windowSize);

            c.options.scales.x.min = labels[startIdx];
            c.options.scales.x.max = labels[endIdx];
            c.update('none');
        });
        $("slider-current-view").textContent = `Scanning Time... (${pct}%)`;
    };

    resetBtn?.addEventListener("click", () => {
        Object.values(charts).forEach(c => c.resetZoom());
        slider.value = 100;
        $("slider-current-view").textContent = "Full Range";
    });
}
// Call init in a wrapper or at end
setTimeout(initTimelineSlider, 1000);

const lineDs = (label, data, color, filled = false) => ({
    label, data, borderColor: color,
    backgroundColor: filled ? color.replace(")", ", .1)").replace("rgb", "rgba") : "transparent",
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: filled,
});
const barDs = (label, data, color) => ({
    label, data, backgroundColor: color, borderRadius: 3, borderSkipped: false,
});

const xAxis = () => ({ type: "time", time: { tooltipFormat: "MMM d, h:mm a", displayFormats: { hour: "h a", minute: "h:mm a" } }, grid: { color: "#1e3050" }, ticks: { maxTicksLimit: 6 } });
const opts = yLabel => ({
    responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: "#1a2436", borderColor: "#1e3050", borderWidth: 1, titleColor: "#f0f6ff", bodyColor: "#7a90ae", padding: 10 },
    },
    scales: { x: xAxis(), y: { grid: { color: "#1e3050" }, ticks: { maxTicksLimit: 5 }, title: { display: !!yLabel, text: yLabel, color: "#4a607a", font: { size: 10 } } } },
});
const withLeg = o => ({ ...o, plugins: { ...o.plugins, legend: { display: true, labels: { color: "#7a90ae", boxWidth: 12, padding: 12 } } } });

function renderCharts(rows) {
    if (!rows || !rows.length) return;
    const pts = rows.map(r => r.obs_time_utc);

    // Update Slider Ranges
    const startEl = $("slider-start-time");
    const endEl = $("slider-end-time");
    if (startEl && pts.length) startEl.textContent = new Date(pts[0]).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (endEl && pts.length) endEl.textContent = new Date(pts[pts.length - 1]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const tLabel = useCelsius ? "°C" : "°F";
    const tempData = useCelsius ? rows.map(r => toC(r.temp_f)) : rows.map(r => r.temp_f);
    const dpData = useCelsius ? rows.map(r => toC(r.dew_point_f)) : rows.map(r => r.dew_point_f);
    const hiData = useCelsius ? rows.map(r => toC(r.heat_index_f)) : rows.map(r => r.heat_index_f);

    buildChart("chart-temp", { type: "line", data: { labels: pts, datasets: [lineDs("Temp", tempData, "rgb(249,115,22)", true), lineDs("Dew Pt", dpData, "rgb(20,184,166)"), lineDs("Heat Idx", hiData, "rgb(168,85,247)")] }, options: withLeg(opts(tLabel)) });
    buildChart("chart-hum", { type: "line", data: { labels: pts, datasets: [lineDs("Humidity (%)", rows.map(r => r.humidity_pct), "rgb(59,130,246)", true)] }, options: { ...opts("%"), scales: { ...opts().scales, y: { min: 0, max: 100, grid: { color: "#1e3050" }, ticks: { maxTicksLimit: 5 } } } } });
    buildChart("chart-baro", { type: "line", data: { labels: pts, datasets: [lineDs("Pressure", rows.map(r => r.pressure_in), "rgb(34,197,94)")] }, options: opts("inHg") });
    buildChart("chart-wind", { type: "line", data: { labels: pts, datasets: [lineDs("Wind", rows.map(r => r.wind_speed_mph), "rgb(96,165,250)"), lineDs("Gust", rows.map(r => r.wind_gust_mph), "rgb(249,115,22)")] }, options: withLeg(opts("mph")) });
    buildChart("chart-rain", { type: "bar", data: { labels: pts, datasets: [barDs("Rain Rate", rows.map(r => r.precip_rate_in_hr || 0), "rgba(59,130,246,.7)")] }, options: { ...opts("in/hr"), scales: { ...opts().scales, y: { min: 0, grid: { color: "#1e3050" }, ticks: { maxTicksLimit: 5 } } } } });
    buildChart("chart-uv", { type: "bar", data: { labels: pts, datasets: [barDs("UV", rows.map(r => r.uv_index || 0), "rgba(234,179,8,.7)")] }, options: { ...opts("UV"), scales: { ...opts().scales, y: { min: 0, max: 12, grid: { color: "#1e3050" }, ticks: { maxTicksLimit: 5 } } } } });
    buildChart("chart-winddir", { type: "line", data: { labels: pts, datasets: [{ label: "Dir (°)", data: rows.map(r => r.wind_dir_deg), borderColor: "rgb(168,85,247)", backgroundColor: "transparent", borderWidth: 1, pointRadius: 2, pointBackgroundColor: "rgb(168,85,247)", tension: 0, fill: false }] }, options: { ...opts("°"), scales: { x: xAxis(), y: { min: 0, max: 360, grid: { color: "#1e3050" }, ticks: { stepSize: 90, callback: v => ({ 0: "N", 90: "E", 180: "S", 270: "W", 360: "N" }[v] || v) } } } } });
    buildChart("chart-solar", { type: "line", data: { labels: pts, datasets: [lineDs("Solar", rows.map(r => r.solar_radiation_wm2 || 0), "rgb(234,179,8)", true)] }, options: { ...opts("W/m²"), scales: { ...opts().scales, y: { min: 0, grid: { color: "#1e3050" }, ticks: { maxTicksLimit: 5 } } } } });
}

// ── Daily table ───────────────────────────────────────────────────────────────
function renderDailyTable(days) {
    const tbody = $("daily-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    days.forEach(d => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${d.day || "—"}</td><td>${tempStr(d.temp_high_f)}</td><td>${tempStr(d.temp_low_f)}</td><td>${tempStr(d.temp_avg_f)}</td><td>${fmt(d.humidity_high, 0)}%</td><td>${fmt(d.humidity_low, 0)}%</td><td>${fmt(d.pressure_avg, 2)}</td><td>${fmt(d.wind_gust_max, 1)}</td><td>${fmt(d.rain_total, 2)}"</td><td>${fmt(d.uv_max, 0)}</td><td>${d.reading_count || "—"}</td>`;
        tbody.appendChild(tr);
    });
}

// ── Fetch all ─────────────────────────────────────────────────────────────────
async function fetchAll() {
    try {
        const s = currentStation;
        const [currRes, histRes, nearbyRes, alertsRes, forecastRes, dailyRes] = await Promise.all([
            fetch(`/api/current?station=${s}`),
            fetch(historyUrl()),
            fetch(`/api/nearby?station=${s}`),
            fetch(`/api/alerts?station=${s}`),
            fetch(`/api/forecast?station=${s}`),
            fetch(`/api/daily?station=${s}`)
        ]);

        const current = await currRes.json();
        const history = await histRes.json();
        const nearby = await nearbyRes.json();
        const alerts = await alertsRes.json();
        const forecast = await forecastRes.json();
        const daily = await dailyRes.json();

        let heroData = current;
        const params = new URLSearchParams(historyUrl().split("?")[1]);
        const timeframe = params.get("range") || "1h";

        const liveBadge = document.querySelector(".live-badge");
        if (timeframe !== "live" && history && history.length > 0) {
            heroData = history[history.length - 1];
            if (liveBadge) {
                liveBadge.innerHTML = '<span class="live-dot" style="background:#eab308;animation:none;"></span> HISTORICAL';
                liveBadge.style.color = "#eab308";
                liveBadge.style.borderColor = "rgba(234,179,8,0.3)";
                liveBadge.style.background = "rgba(234,179,8,0.1)";
            }
        } else {
            if (liveBadge) {
                liveBadge.innerHTML = '<span class="live-dot"></span> LIVE';
                liveBadge.style.color = "var(--green)";
                liveBadge.style.borderColor = "rgba(34,197,94,0.3)";
                liveBadge.style.background = "rgba(34,197,94,0.1)";
            }
        }

        if (!heroData || Object.keys(heroData).length === 0) {
            if ($("no-data-state")) $("no-data-state").style.display = "flex";
            if ($("dashboard-state")) $("dashboard-state").style.display = "none";
            return;
        }

        if ($("no-data-state")) $("no-data-state").style.display = "none";
        if ($("dashboard-state")) $("dashboard-state").style.display = "block";

        try {
            stationList = await fetch("/api/stations").then(r => r.json());
        } catch (e) {
            console.warn("Map metadata fetch failed", e);
        }

        updateHero(heroData);
        updateDynamicTheme(heroData);
        updateSummary(history);
        updateMetrics(heroData, history);
        renderCharts(history);
        renderDailyTable(daily);
        renderAlerts(alerts);
        renderNearby(nearby.stations || []);
        renderForecast(forecast);

        setText("last-update-time", new Date().toLocaleTimeString());
    } catch (e) {
        console.warn("Fetch error:", e);
    }
}

async function initAuth() {
    const token = localStorage.getItem("wx_token");
    const userDisplay = $("user-display");
    const loginLink = $("login-link");
    const signupLink = $("signup-link");
    const logoutBtn = $("logout-btn");
    const manageBtn = $("manage-stations-btn");

    if (!token) {
        if (userDisplay) userDisplay.textContent = "Guest";
        if (loginLink) loginLink.style.display = "inline";
        if (signupLink) signupLink.style.display = "inline";
        if (logoutBtn) logoutBtn.style.display = "none";
        if (manageBtn) manageBtn.style.display = "none";
        return;
    }

    try {
        const res = await fetch("/api/auth/me", {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (res.ok) {
            currentUser = await res.json();
            if (userDisplay) userDisplay.textContent = currentUser.username;
            if (loginLink) loginLink.style.display = "none";
            if (signupLink) signupLink.style.display = "none";
            if (logoutBtn) logoutBtn.style.display = "inline";
            if (currentUser.is_admin && manageBtn) {
                manageBtn.style.display = "inline-block";
            }
        } else {
            localStorage.removeItem("wx_token");
            initAuth();
        }
    } catch (e) { console.error("Auth error:", e); }

    if (logoutBtn) logoutBtn.onclick = () => {
        localStorage.removeItem("wx_token");
        window.location.reload();
    };
}

function initStationManagement() {
    const modal = $("station-modal");
    const btn = $("manage-stations-btn");
    const close = $("close-station-modal");

    if (btn) btn.addEventListener("click", () => {
        if (modal) modal.style.display = "flex";
        renderStationList();
    });
    if (close) close.addEventListener("click", () => { if (modal) modal.style.display = "none"; });

    const addForm = $("add-station-form");
    if (addForm) addForm.onsubmit = async (e) => {
        e.preventDefault();
        const payload = {
            id: $("new-station-id").value.trim(),
            name: $("new-station-name").value.trim() || null
        };

        const res = await fetch("/api/stations", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${localStorage.getItem("wx_token")}`
            },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            addForm.reset();
            renderStationList();
            initStationTabs();
        } else {
            alert("Failed to add station");
        }
    };
}

async function renderStationList() {
    const container = $("station-list-container");
    if (!container) return;
    const res = await fetch("/api/stations");
    const stations = await res.json();
    container.innerHTML = "";

    stations.forEach(s => {
        const item = document.createElement("div");
        item.className = "station-item";
        item.innerHTML = `
            <div><strong>${s.name}</strong> (${s.id})</div>
            <button class="btn-delete" data-id="${s.id}">Delete</button>
        `;
        item.querySelector(".btn-delete").onclick = async () => {
            if (!confirm(`Delete ${s.name}?`)) return;
            const res = await fetch(`/api/stations/${s.id}`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${localStorage.getItem("wx_token")}` }
            });
            if (res.ok) {
                renderStationList();
                initStationTabs();
            }
        };
        container.appendChild(item);
    });
}

function getWeatherInsight(p) {
    const temp = p.temperature;
    const short = p.shortForecast.toLowerCase();
    const isDay = p.isDaytime;
    const rainProb = p.probabilityOfPrecipitation?.value || 0;
    const wind = parseInt(p.windSpeed) || 0;

    if (rainProb > 40) return "☂️ Carry an umbrella";
    if (temp > 85) return "☀️ Stay hydrated";
    if (temp < 40) return "🧣 Wear a warm coat";
    if (wind > 20) return "🌬️ High wind alert";
    if (short.includes("sunny") || short.includes("clear")) {
        return isDay ? "🕶️ Great for a walk" : "✨ Clear skies tonight";
    }
    if (short.includes("cloudy")) return "☁️ Overcast vibes";
    return "✅ Looking good";
}

function renderForecast(periods) {
    const container = $("forecast-grid");
    if (!container) return;
    container.innerHTML = "";
    if (!periods || !Array.isArray(periods)) {
        container.innerHTML = '<div style="color:var(--text-muted); padding:1rem;">No forecast available.</div>';
        return;
    }

    periods.forEach((p, i) => {
        const card = document.createElement("div");
        card.className = "forecast-card";
        card.style.animationDelay = `${i * 0.05}s`;

        const rainProb = p.probabilityOfPrecipitation?.value || 0;
        const wind = p.windSpeed || "—";
        const insight = getWeatherInsight(p);

        card.innerHTML = `
            <div class="fc-name">${p.name}</div>
            <div class="fc-icon">
                <img src="${p.icon}" style="width:56px; height:56px; border-radius:12px;" alt="${p.shortForecast}">
            </div>
            <div class="fc-temp">${p.temperature}°${p.temperatureUnit}</div>
            <div class="fc-short" style="margin-bottom:0.5rem; font-weight:500;">${p.shortForecast}</div>
            
            <div class="fc-details">
                <div class="fc-detail-row">
                    <span>Rain</span>
                    <span>${rainProb}%</span>
                </div>
                <div class="fc-detail-row">
                    <span>Wind</span>
                    <span>${wind}</span>
                </div>
            </div>
            
            <div class="fc-insight">${insight}</div>
        `;
        container.appendChild(card);
    });
}

// ── Event wiring ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tf-btn[data-hours]").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tf-btn[data-hours]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentHours = parseInt(btn.dataset.hours, 10);
        customStart = null; customEnd = null;
        const cs = $("chart-start"); if (cs) cs.value = "";
        const ce = $("chart-end"); if (ce) ce.value = "";
        saveSettings();
        fetchAll();
    });
});

const applyBtn = $("apply-custom-range");
if (applyBtn) {
    applyBtn.addEventListener("click", () => {
        const sv = $("chart-start")?.value;
        const ev = $("chart-end")?.value;
        if (sv && ev) {
            customStart = sv; customEnd = ev;
            document.querySelectorAll(".tf-btn[data-hours]").forEach(b => b.classList.remove("active"));
            fetchAll();
        }
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
initSettings();
initStationTabs();
fetchAll();
refreshTimer = setInterval(fetchAll, refreshMs);
