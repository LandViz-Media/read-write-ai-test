/*
 * Read / Write AI Test
 *
 * Responsibility:
 *   Controls the browser-side Study Setup workflow for Test 3B.3.3.4:
 *   - validate user input
 *   - resolve U.S. cities/places using Census TIGERweb
 *   - create the buffered study-area extent
 *   - display the result with Leaflet
 *   - prepare the persistent study record
 *   - send persistence requests to the Cloudflare Worker
 *
 * Architecture:
 *   GitHub Pages JavaScript -> public Census TIGERweb
 *   GitHub Pages JavaScript -> Cloudflare Worker -> GitHub App -> private repo
 *
 * Geometry rule:
 *   The buffer is applied to the combined geographic extent containing
 *   both resolved city points. It is NOT a circular buffer around a city.
 */

"use strict";

/* ============================================================
   CONFIGURATION
   ============================================================ */

const APP_VERSION = "3B.3.3.4";

const API_BASE_URL = "https://read-write-ai-test-api.cjseeger.workers.dev";
const STUDY_CREATE_ENDPOINT = "/api/v1/studies";
const REPOSITORY_LABEL = "LandViz-Media/read-write-ai-test (private)";

const CENSUS_TIGERWEB_BASE_URL =
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer";

/*
 * The current TIGERweb service exposes these current-place layers.
 * Incorporated places are checked first because that is the normal
 * Census representation of a U.S. city or town. CDPs and consolidated
 * cities are fallbacks for valid U.S. Census places that are not in the
 * incorporated-place layer.
 */
const CENSUS_PLACE_LAYERS = [
    { id: 4, label: "Incorporated Place" },
    { id: 5, label: "Census Designated Place" },
    { id: 3, label: "Consolidated City" }
];

const CENSUS_QUERY_FIELDS = [
    "BASENAME",
    "NAME",
    "STATE",
    "GEOID",
    "PLACE",
    "PLACECC",
    "CENTLAT",
    "CENTLON",
    "INTPTLAT",
    "INTPTLON"
].join(",");

const CENSUS_REQUEST_TIMEOUT_MS = 15000;
const WORKER_REQUEST_TIMEOUT_MS = 20000;

const MILES_TO_METERS = 1609.344;
const METERS_PER_DEGREE_LATITUDE = 111132.92;

/* ============================================================
   U.S. STATE LOOKUP
   ============================================================ */

const STATES = [
    ["AL", "Alabama", "01"],
    ["AK", "Alaska", "02"],
    ["AZ", "Arizona", "04"],
    ["AR", "Arkansas", "05"],
    ["CA", "California", "06"],
    ["CO", "Colorado", "08"],
    ["CT", "Connecticut", "09"],
    ["DE", "Delaware", "10"],
    ["DC", "District of Columbia", "11"],
    ["FL", "Florida", "12"],
    ["GA", "Georgia", "13"],
    ["HI", "Hawaii", "15"],
    ["ID", "Idaho", "16"],
    ["IL", "Illinois", "17"],
    ["IN", "Indiana", "18"],
    ["IA", "Iowa", "19"],
    ["KS", "Kansas", "20"],
    ["KY", "Kentucky", "21"],
    ["LA", "Louisiana", "22"],
    ["ME", "Maine", "23"],
    ["MD", "Maryland", "24"],
    ["MA", "Massachusetts", "25"],
    ["MI", "Michigan", "26"],
    ["MN", "Minnesota", "27"],
    ["MS", "Mississippi", "28"],
    ["MO", "Missouri", "29"],
    ["MT", "Montana", "30"],
    ["NE", "Nebraska", "31"],
    ["NV", "Nevada", "32"],
    ["NH", "New Hampshire", "33"],
    ["NJ", "New Jersey", "34"],
    ["NM", "New Mexico", "35"],
    ["NY", "New York", "36"],
    ["NC", "North Carolina", "37"],
    ["ND", "North Dakota", "38"],
    ["OH", "Ohio", "39"],
    ["OK", "Oklahoma", "40"],
    ["OR", "Oregon", "41"],
    ["PA", "Pennsylvania", "42"],
    ["RI", "Rhode Island", "44"],
    ["SC", "South Carolina", "45"],
    ["SD", "South Dakota", "46"],
    ["TN", "Tennessee", "47"],
    ["TX", "Texas", "48"],
    ["UT", "Utah", "49"],
    ["VT", "Vermont", "50"],
    ["VA", "Virginia", "51"],
    ["WA", "Washington", "53"],
    ["WV", "West Virginia", "54"],
    ["WI", "Wisconsin", "55"],
    ["WY", "Wyoming", "56"],
    ["PR", "Puerto Rico", "72"]
];

const STATE_BY_ABBR = Object.fromEntries(
    STATES.map(([abbr, name, fips]) => [abbr, { abbr, name, fips }])
);

/* ============================================================
   DOM REFERENCES
   ============================================================ */

const dom = {
    studyName: document.getElementById("studyName"),
    city1: document.getElementById("city1"),
    city2: document.getElementById("city2"),
    state1: document.getElementById("state1"),
    state2: document.getElementById("state2"),
    bufferDistance: document.getElementById("bufferDistance"),
    createStudyAreaButton: document.getElementById("createStudyAreaButton"),
    saveStudyButton: document.getElementById("saveStudyButton"),
    continueButton: document.getElementById("continueButton"),
    mapStatus: document.getElementById("mapStatus"),
    locationDetails: document.getElementById("locationDetails"),
    city1Resolved: document.getElementById("city1Resolved"),
    city2Resolved: document.getElementById("city2Resolved"),
    studyAreaDimensions: document.getElementById("studyAreaDimensions"),
    saveSummary: document.getElementById("saveSummary"),
    studyIdDisplay: document.getElementById("studyIdDisplay"),
    studyStatusDisplay: document.getElementById("studyStatusDisplay"),
    repositoryDisplay: document.getElementById("repositoryDisplay"),
    results: document.getElementById("results")
};

/* ============================================================
   APPLICATION STATE
   ============================================================ */

const state = {
    map: null,
    cityMarkers: [],
    studyAreaLayer: null,
    currentStudy: null,
    studySaved: false,
    censusStateCache: new Map()
};

/* ============================================================
   STATE SELECTORS
   ============================================================ */

function initializeStateSelectors() {
    const options = [...STATES].sort((a, b) =>
        a[1].localeCompare(b[1])
    );

    [dom.state1, dom.state2].forEach(select => {
        select.innerHTML = "";

        options.forEach(([abbr, name]) => {
            const option = document.createElement("option");
            option.value = abbr;
            option.textContent = name;
            select.appendChild(option);
        });

        /* Iowa remains the development default, not a geographic restriction. */
        select.value = "IA";
    });
}

/* ============================================================
   MAP
   ============================================================ */

function initializeMap() {
    state.map = L.map("map", {
        zoomControl: true
    }).setView([42.0, -93.5], 7);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(state.map);

    requestAnimationFrame(() => state.map.invalidateSize({ pan: false }));
}

function clearCityMarkers() {
    state.cityMarkers.forEach(marker => state.map.removeLayer(marker));
    state.cityMarkers = [];
}

function clearStudyAreaLayer() {
    if (state.studyAreaLayer) {
        state.map.removeLayer(state.studyAreaLayer);
        state.studyAreaLayer = null;
    }
}

/* ============================================================
   GENERIC FETCH HELPERS
   ============================================================ */

async function fetchJson(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            cache: "no-store",
            signal: controller.signal
        });

        const text = await response.text();
        let data = null;

        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            throw new Error(
                `The service returned a non-JSON response (HTTP ${response.status}).`
            );
        }

        if (!response.ok) {
            const detail =
                data?.error?.message ||
                data?.message ||
                data?.error ||
                `HTTP ${response.status}`;

            throw new Error(detail);
        }

        return data;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(`The request timed out after ${timeoutMs / 1000} seconds.`);
        }

        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/* ============================================================
   INPUT PARSING / VALIDATION
   ============================================================ */

function parseCityName(value) {
    const raw = String(value || "").trim();

    if (!raw) {
        throw new Error("Enter a city name.");
    }

    /* Allow a pasted value such as "Ogden, IA" while the selector remains authoritative. */
    const city = raw.split(",")[0].trim();

    if (!city) {
        throw new Error("Enter a city name.");
    }

    return city;
}

function parseCitySelection(cityValue, stateAbbr) {
    const city = parseCityName(cityValue);
    const selectedState = STATE_BY_ABBR[String(stateAbbr || "").toUpperCase()];

    if (!selectedState) {
        throw new Error("Select a valid U.S. state.");
    }

    return {
        city,
        ...selectedState
    };
}

function getBufferDistance() {
    const value = Number(dom.bufferDistance.value);

    if (!Number.isFinite(value) || value < 0 || value > 25) {
        throw new Error("Buffer distance must be between 0 and 25 miles.");
    }

    return Number(value.toFixed(1));
}

function validateStudyInputs() {
    return Boolean(
        dom.studyName.value.trim() &&
        dom.city1.value.trim() &&
        dom.city2.value.trim() &&
        STATE_BY_ABBR[dom.state1.value] &&
        STATE_BY_ABBR[dom.state2.value] &&
        (() => {
            try {
                getBufferDistance();
                return true;
            } catch {
                return false;
            }
        })()
    );
}

function updateCreateButton() {
    dom.createStudyAreaButton.disabled = !validateStudyInputs();
}

/* ============================================================
   PLACE-NAME NORMALIZATION
   ============================================================ */

/**
 * Normalize names for an exact comparison without treating capitalization,
 * apostrophe style, accents, punctuation, or repeated spaces as meaningful.
 *
 * This function was missing from Test 3B.3.3.2 and caused the Census lookup
 * to fail with a ReferenceError before the returned Census features could be
 * evaluated. It is deliberately small and deterministic.
 */
function normalizePlaceName(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’‘]/g, "'")
        .replace(/&/g, " AND ")
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase();
}

/* ============================================================
   CENSUS PLACE DATA
   ============================================================ */

function censusLayerKey(layerId, stateFips) {
    return `${layerId}:${stateFips}`;
}

async function fetchCensusPlacesForState(layer, selectedState) {
    const cacheKey = censusLayerKey(layer.id, selectedState.fips);

    if (state.censusStateCache.has(cacheKey)) {
        return state.censusStateCache.get(cacheKey);
    }

    const url = new URL(
        `${CENSUS_TIGERWEB_BASE_URL}/${layer.id}/query`
    );

    url.searchParams.set("where", `STATE = '${selectedState.fips}'`);
    url.searchParams.set("outFields", CENSUS_QUERY_FIELDS);
    url.searchParams.set("returnGeometry", "false");
    url.searchParams.set("f", "json");
    url.searchParams.set("_cb", `${APP_VERSION}-${Date.now()}`);

    const data = await fetchJson(url.toString(), {
        method: "GET",
        headers: {
            Accept: "application/json"
        }
    }, CENSUS_REQUEST_TIMEOUT_MS);

    if (!Array.isArray(data?.features)) {
        throw new Error("The Census place service returned no feature collection.");
    }

    const features = data.features;
    state.censusStateCache.set(cacheKey, features);
    return features;
}

function validateCensusFeature(attributes, selectedState, requestedCity) {
    if (!attributes) {
        return false;
    }

    const returnedState = String(attributes.STATE || "").trim();
    const returnedName = normalizePlaceName(attributes.BASENAME || "");
    const requestedName = normalizePlaceName(requestedCity);

    if (returnedState !== selectedState.fips) {
        return false;
    }

    if (returnedName !== requestedName) {
        return false;
    }

    const latitude = Number(attributes.INTPTLAT || attributes.CENTLAT);
    const longitude = Number(attributes.INTPTLON || attributes.CENTLON);

    return Number.isFinite(latitude) && Number.isFinite(longitude);
}

function selectCensusFeature(features, selectedState, requestedCity) {
    const matches = features
        .map(feature => feature?.attributes || null)
        .filter(attributes =>
            validateCensusFeature(attributes, selectedState, requestedCity)
        );

    return matches.length > 0 ? matches[0] : null;
}

async function resolveCensusPlace(cityValue, stateAbbr) {
    const selectedState = STATE_BY_ABBR[String(stateAbbr || "").toUpperCase()];
    const requestedCity = parseCityName(cityValue);

    if (!selectedState) {
        throw new Error("Select a valid U.S. state.");
    }

    const queryErrors = [];

    for (const layer of CENSUS_PLACE_LAYERS) {
        try {
            const features = await fetchCensusPlacesForState(
                layer,
                selectedState
            );

            const selected = selectCensusFeature(
                features,
                selectedState,
                requestedCity
            );

            if (selected) {
                return {
                    attributes: selected,
                    layer
                };
            }
        } catch (error) {
            queryErrors.push(`${layer.label}: ${error.message}`);
        }
    }

    if (queryErrors.length === CENSUS_PLACE_LAYERS.length) {
        throw new Error(
            `Census place lookup failed for "${requestedCity}, ${selectedState.abbr}". ` +
            queryErrors.join(" ")
        );
    }

    throw new Error(
        `No exact Census place named "${requestedCity}" was found in ${selectedState.name}. ` +
        `The result was rejected rather than substituting a county or other administrative feature.`
    );
}

function createLocationObject(input, resolved) {
    const attributes = resolved.attributes;
    const selectedState = STATE_BY_ABBR[resolved.attributes.STATE === undefined
        ? ""
        : Object.keys(STATE_BY_ABBR).find(
            abbr => STATE_BY_ABBR[abbr].fips === String(attributes.STATE)
        )
    ];

    const latitude = Number(attributes.INTPTLAT || attributes.CENTLAT);
    const longitude = Number(attributes.INTPTLON || attributes.CENTLON);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error(`The Census place service returned invalid coordinates for "${input}".`);
    }

    /* The selected UI state is safer than trying to infer the state name from NAME. */
    const stateAbbr = Object.keys(STATE_BY_ABBR).find(
        abbr => STATE_BY_ABBR[abbr].fips === String(attributes.STATE)
    );
    const stateInfo = STATE_BY_ABBR[stateAbbr];

    return {
        input,
        name: attributes.BASENAME,
        state: stateInfo.name,
        stateAbbr,
        country: "United States",
        latitude,
        longitude,
        displayName: attributes.NAME || `${attributes.BASENAME}, ${stateInfo.name}`,
        geocoder: "U.S. Census Bureau TIGERweb",
        censusVintage: "2026",
        censusLayer: resolved.layer.label,
        censusLayerId: resolved.layer.id,
        censusGEOID: attributes.GEOID || "",
        censusPlaceCode: attributes.PLACE || "",
        censusPlaceClassCode: attributes.PLACECC || ""
    };
}

/* ============================================================
   GEOMETRY
   ============================================================ */

function milesToLatitudeDegrees(miles) {
    return (miles * MILES_TO_METERS) / METERS_PER_DEGREE_LATITUDE;
}

function milesToLongitudeDegrees(miles, latitude) {
    const radians = latitude * Math.PI / 180;
    const metersPerDegreeLongitude =
        METERS_PER_DEGREE_LATITUDE * Math.cos(radians);

    if (metersPerDegreeLongitude <= 0) {
        throw new Error("Unable to calculate longitude buffer at this latitude.");
    }

    return (miles * MILES_TO_METERS) / metersPerDegreeLongitude;
}

function calculateStudyExtent(city1, city2, bufferMiles) {
    const minLatitude = Math.min(city1.latitude, city2.latitude);
    const maxLatitude = Math.max(city1.latitude, city2.latitude);
    const minLongitude = Math.min(city1.longitude, city2.longitude);
    const maxLongitude = Math.max(city1.longitude, city2.longitude);

    const centerLatitude = (minLatitude + maxLatitude) / 2;
    const latitudeBuffer = milesToLatitudeDegrees(bufferMiles);
    const longitudeBuffer = milesToLongitudeDegrees(
        bufferMiles,
        centerLatitude
    );

    return {
        minLatitude: minLatitude - latitudeBuffer,
        maxLatitude: maxLatitude + latitudeBuffer,
        minLongitude: minLongitude - longitudeBuffer,
        maxLongitude: maxLongitude + longitudeBuffer
    };
}

function extentToLeafletBounds(extent) {
    return L.latLngBounds(
        [extent.minLatitude, extent.minLongitude],
        [extent.maxLatitude, extent.maxLongitude]
    );
}

function calculateDimensions(extent) {
    const centerLatitude = (extent.minLatitude + extent.maxLatitude) / 2;

    const heightMiles =
        (extent.maxLatitude - extent.minLatitude) *
        METERS_PER_DEGREE_LATITUDE /
        MILES_TO_METERS;

    const metersPerDegreeLongitude =
        METERS_PER_DEGREE_LATITUDE * Math.cos(centerLatitude * Math.PI / 180);

    const widthMiles =
        (extent.maxLongitude - extent.minLongitude) *
        metersPerDegreeLongitude /
        MILES_TO_METERS;

    return { widthMiles, heightMiles };
}

/* ============================================================
   GEOJSON
   ============================================================ */

function createStudyAreaGeoJSON(study) {
    const extent = study.studyArea.extent;

    return {
        type: "FeatureCollection",
        name: study.id,
        features: [
            {
                type: "Feature",
                properties: {
                    studyId: study.id,
                    studyName: study.name,
                    application: study.application,
                    method: study.studyArea.method,
                    bufferDistance: study.buffer.distance,
                    bufferUnits: study.buffer.units
                },
                geometry: {
                    type: "Polygon",
                    coordinates: [[
                        [extent.minLongitude, extent.minLatitude],
                        [extent.maxLongitude, extent.minLatitude],
                        [extent.maxLongitude, extent.maxLatitude],
                        [extent.minLongitude, extent.maxLatitude],
                        [extent.minLongitude, extent.minLatitude]
                    ]]
                }
            }
        ]
    };
}

/* ============================================================
   UI / RESULTS
   ============================================================ */

function showResult(title, message, status = "waiting", data = null) {
    dom.results.innerHTML = "";

    const result = document.createElement("div");
    result.className = `result ${status}`;

    const titleElement = document.createElement("div");
    titleElement.className = "result-title";
    titleElement.textContent = title;

    const messageElement = document.createElement("div");
    messageElement.className = "result-message";
    messageElement.textContent = message;

    result.append(titleElement, messageElement);

    if (data !== null) {
        result.appendChild(createDataPre(data));
    }

    dom.results.appendChild(result);
    return result;
}

function createDataPre(data) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(data, null, 2);
    return pre;
}

function updateLocationDetails(city1, city2, extent) {
    dom.city1Resolved.textContent = city1.displayName;
    dom.city2Resolved.textContent = city2.displayName;

    const dimensions = calculateDimensions(extent);
    dom.studyAreaDimensions.textContent =
        `${dimensions.widthMiles.toFixed(1)} × ${dimensions.heightMiles.toFixed(1)} miles`;

    dom.locationDetails.hidden = false;
}

function updateSaveSummary(study, statusText) {
    dom.studyIdDisplay.textContent = study.id;
    dom.studyStatusDisplay.textContent = statusText;
    dom.repositoryDisplay.textContent = REPOSITORY_LABEL;
    dom.saveSummary.hidden = false;
}

function updateSaveControls() {
    dom.saveStudyButton.disabled = !state.currentStudy || state.studySaved;
    dom.continueButton.disabled = !state.studySaved || !state.currentStudy;
}

function displayStudyArea(city1, city2, extent) {
    clearCityMarkers();
    clearStudyAreaLayer();

    const marker1 = L.marker([city1.latitude, city1.longitude])
        .addTo(state.map)
        .bindPopup(`<strong>City 1</strong><br>${escapeHtml(city1.displayName)}`);

    const marker2 = L.marker([city2.latitude, city2.longitude])
        .addTo(state.map)
        .bindPopup(`<strong>City 2</strong><br>${escapeHtml(city2.displayName)}`);

    state.cityMarkers.push(marker1, marker2);

    const bounds = extentToLeafletBounds(extent);

    state.studyAreaLayer = L.rectangle(bounds, {
        weight: 2,
        fillOpacity: 0.12
    }).addTo(state.map);

    state.studyAreaLayer.bindPopup(
        "<strong>Study Area</strong><br>" +
        "Buffered geographic extent of the two selected cities."
    );

    state.map.invalidateSize({ pan: false });
    state.map.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: 12
    });

    setTimeout(() => {
        state.map.invalidateSize({ pan: false });
        state.map.fitBounds(bounds, {
            padding: [30, 30],
            maxZoom: 12
        });
    }, 100);
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

/* ============================================================
   STUDY IDS / STUDY RECORDS
   ============================================================ */

function generateStudyId() {
    const now = new Date();
    const date = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
    ].join("");

    const time = [
        now.getHours(),
        now.getMinutes(),
        now.getSeconds()
    ].map(value => String(value).padStart(2, "0")).join("");

    const random = crypto?.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);

    return `study-${date}-${time}-${random}`;
}

function buildStudyRecord() {
    if (!state.currentStudy) {
        throw new Error("There is no study to save.");
    }

    const now = new Date().toISOString();

    return {
        id: state.currentStudy.id,
        name: state.currentStudy.name,
        application: "osm-scout",
        created: state.currentStudy.created,
        updated: now,
        status: "study-area-created",
        cities: state.currentStudy.cities,
        buffer: state.currentStudy.buffer,
        studyArea: state.currentStudy.studyArea,
        provenance: {
            geocoder: "U.S. Census Bureau TIGERweb",
            censusVintage: "2026",
            geocodedAt: state.currentStudy.geocodedAt,
            mapReviewedBeforeSave: true
        }
    };
}

/* ============================================================
   WORKER PERSISTENCE
   ============================================================ */

async function createApiError(response) {
    let payload = null;

    try {
        payload = await response.json();
    } catch {
        /* Fall through to the HTTP status. */
    }

    const message =
        payload?.message ||
        payload?.error ||
        payload?.details ||
        `Study save request failed with HTTP ${response.status}.`;

    return new Error(message);
}

async function saveStudyToWorker(study) {
    const payload = {
        study,
        studyArea: createStudyAreaGeoJSON(study)
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(
        () => controller.abort(),
        WORKER_REQUEST_TIMEOUT_MS
    );

    try {
        const response = await fetch(
            `${API_BASE_URL}${STUDY_CREATE_ENDPOINT}?v=${APP_VERSION}&_cb=${Date.now()}`,
            {
                method: "POST",
                cache: "no-store",
                signal: controller.signal,
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "Cache-Control": "no-cache"
                },
                body: JSON.stringify(payload)
            }
        );

        if (!response.ok) {
            throw await createApiError(response);
        }

        const result = await response.json();

        if (result.ok !== true) {
            throw new Error(
                result.message ||
                "The Worker did not confirm that the study was saved."
            );
        }

        return result;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(
                `The Worker request timed out after ${WORKER_REQUEST_TIMEOUT_MS / 1000} seconds.`
            );
        }

        /*
         * Browsers report fetch/CORS/preflight failures as a generic
         * NetworkError/TypeError rather than exposing the underlying HTTP
         * response. Give the user a useful diagnostic without hiding a real
         * Worker error when the Worker did respond.
         */
        const networkMessage = String(error?.message || "");
        if (
            error?.name === "TypeError" &&
            /fetch|network|failed/i.test(networkMessage)
        ) {
            throw new Error(
                "The browser could not reach the Cloudflare Worker. " +
                "This usually indicates a Worker endpoint, CORS, or preflight configuration problem."
            );
        }

        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/* ============================================================
   CREATE STUDY AREA
   ============================================================ */

async function createStudyArea() {
    if (!validateStudyInputs()) {
        showResult(
            "Study Setup Incomplete",
            "Please provide a study name, two cities, select both states, and provide a buffer from 0 to 25 miles.",
            "fail"
        );
        return;
    }

    const studyName = dom.studyName.value.trim();
    const city1Input = dom.city1.value.trim();
    const city2Input = dom.city2.value.trim();
    const city1State = dom.state1.value;
    const city2State = dom.state2.value;
    const buffer = getBufferDistance();

    state.currentStudy = null;
    state.studySaved = false;
    clearCityMarkers();
    clearStudyAreaLayer();
    dom.locationDetails.hidden = true;
    dom.saveSummary.hidden = true;
    updateSaveControls();

    dom.createStudyAreaButton.disabled = true;
    dom.mapStatus.textContent = "Resolving City 1 with U.S. Census place data...";

    const result = showResult(
        "Creating Study Area",
        "Resolving City 1 with U.S. Census place data...",
        "running"
    );

    try {
        const city1Resolved = await resolveCensusPlace(city1Input, city1State);

        result.querySelector(".result-message").textContent =
            "City 1 resolved. Resolving City 2 with U.S. Census place data...";

        const city2Resolved = await resolveCensusPlace(city2Input, city2State);

        const city1 = createLocationObject(
            `${city1Input}, ${city1State}`,
            city1Resolved
        );

        const city2 = createLocationObject(
            `${city2Input}, ${city2State}`,
            city2Resolved
        );

        const extent = calculateStudyExtent(city1, city2, buffer);
        const now = new Date().toISOString();

        state.currentStudy = {
            id: generateStudyId(),
            name: studyName,
            application: "osm-scout",
            created: now,
            geocodedAt: now,
            cities: [city1, city2],
            buffer: {
                distance: buffer,
                units: "miles"
            },
            studyArea: {
                method: "city-extent-buffer",
                extent
            }
        };

        displayStudyArea(city1, city2, extent);
        updateLocationDetails(city1, city2, extent);
        updateSaveSummary(state.currentStudy, "Ready to save");
        updateSaveControls();

        dom.mapStatus.textContent =
            "Study area created. Review the map, then save the study.";

        result.className = "result pass";
        result.querySelector(".result-title").textContent = "✓ Study Area Created";
        result.querySelector(".result-message").textContent =
            `Both Census place records were validated successfully. ` +
            `The combined extent was buffered by ${buffer.toFixed(1)} miles on all four sides. ` +
            `Study ID: ${state.currentStudy.id}`;

        result.appendChild(createDataPre({
            city1: city1.displayName,
            city2: city2.displayName,
            censusSources: [city1.censusLayer, city2.censusLayer],
            bufferMiles: buffer,
            extent,
            appVersion: APP_VERSION
        }));
    } catch (error) {
        state.currentStudy = null;
        state.studySaved = false;

        clearCityMarkers();
        clearStudyAreaLayer();
        dom.locationDetails.hidden = true;
        dom.saveSummary.hidden = true;
        updateSaveControls();

        const message = error instanceof Error
            ? error.message
            : String(error);

        dom.mapStatus.textContent =
            `Unable to create the study area: ${message}`;

        result.className = "result fail";
        result.querySelector(".result-title").textContent =
            "Study Area Creation Failed";
        result.querySelector(".result-message").textContent = message;

        result.appendChild(createDataPre({
            stage: "census-place-resolution",
            appVersion: APP_VERSION,
            city1: {
                input: city1Input,
                state: city1State
            },
            city2: {
                input: city2Input,
                state: city2State
            }
        }));
    } finally {
        updateCreateButton();
    }
}

/* ============================================================
   SAVE STUDY
   ============================================================ */

async function saveStudy() {
    if (!state.currentStudy) {
        showResult(
            "Nothing to Save",
            "Create a study area first.",
            "fail"
        );
        return;
    }

    if (state.studySaved) {
        showResult(
            "Study Already Saved",
            `Study ${state.currentStudy.id} has already been persisted.`,
            "pass"
        );
        return;
    }

    dom.saveStudyButton.disabled = true;
    dom.continueButton.disabled = true;
    dom.createStudyAreaButton.disabled = true;
    dom.mapStatus.textContent =
        "Saving the study to the private GitHub repository...";
    updateSaveSummary(state.currentStudy, "Saving...");

    const result = showResult(
        "Saving Study",
        "Sending the study to the Cloudflare Worker...",
        "running"
    );

    try {
        const study = buildStudyRecord();
        const apiResult = await saveStudyToWorker(study);

        state.studySaved = true;
        state.currentStudy = {
            ...study,
            persistence: apiResult
        };

        updateSaveSummary(state.currentStudy, "Saved to GitHub");
        updateSaveControls();

        dom.mapStatus.textContent =
            "Study saved. You may continue to OSM data collection.";

        result.className = "result pass";
        result.querySelector(".result-title").textContent = "✓ Study Saved";
        result.querySelector(".result-message").textContent =
            `Study ${study.id} was accepted by the Worker and persisted to the private GitHub repository.`;

        result.appendChild(createDataPre({
            studyId: study.id,
            studiesFile: apiResult.files?.studies || "data/studies.json",
            studyAreaFile:
                apiResult.files?.studyArea ||
                `data/studyAreas/${study.id}.geojson`
        }));
    } catch (error) {
        state.studySaved = false;
        updateSaveSummary(state.currentStudy, "Save failed");

        const message = error instanceof Error
            ? error.message
            : String(error);

        dom.mapStatus.textContent =
            `The study was not confirmed as saved: ${message}`;

        result.className = "result fail";
        result.querySelector(".result-title").textContent =
            "Study Save Failed";
        result.querySelector(".result-message").textContent = message;

        dom.saveStudyButton.disabled = false;
        dom.continueButton.disabled = true;
    }
}

/* ============================================================
   CONTINUE
   ============================================================ */

function continueToOsmCollection() {
    if (!state.studySaved || !state.currentStudy) {
        return;
    }

    showResult(
        "Ready for OSM Data Collection",
        `Study ${state.currentStudy.id} is saved and ready for the next milestone. ` +
        "OSM/Overpass collection will be implemented next.",
        "pass",
        {
            studyId: state.currentStudy.id,
            status: state.currentStudy.status,
            nextStep: "osm-data-collection"
        }
    );
}

/* ============================================================
   STUDY INVALIDATION / INPUT EVENTS
   ============================================================ */

function invalidateCurrentStudy() {
    state.currentStudy = null;
    state.studySaved = false;
    dom.saveSummary.hidden = true;
    updateSaveControls();
}

[
    dom.studyName,
    dom.city1,
    dom.city2,
    dom.bufferDistance
].forEach(input => {
    input.addEventListener("input", () => {
        invalidateCurrentStudy();
        updateCreateButton();
    });
});

[dom.state1, dom.state2].forEach(select => {
    select.addEventListener("change", () => {
        invalidateCurrentStudy();
        updateCreateButton();
    });
});

dom.createStudyAreaButton.addEventListener("click", createStudyArea);
dom.saveStudyButton.addEventListener("click", saveStudy);
dom.continueButton.addEventListener("click", continueToOsmCollection);

/* ============================================================
   INITIALIZATION
   ============================================================ */

initializeStateSelectors();
initializeMap();
updateSaveControls();
updateCreateButton();
