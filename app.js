/*
 * Read / Write AI Test
 *
 * Responsibility:
 *   Controls the browser-side Study Setup workflow for Test 3B.5:
 *   - validate user input
 *   - resolve U.S. cities/places using Census TIGERweb
 *   - create the buffered study-area extent
 *   - display the result with Leaflet
 *   - prepare the persistent study record
 *   - send persistence requests to the Cloudflare Worker
 *
 * Architecture:
 *   GitHub Pages JavaScript -> public Census TIGERweb
 *   GitHub Pages JavaScript -> Cloudflare Worker -> GitHub App -> GitHub repo
 *
 * Geometry rule:
 *   The buffer is applied to the combined geographic extent containing
 *   both resolved city points. It is NOT a circular buffer around a city.
 */

"use strict";

/* ============================================================
   CONFIGURATION
   ============================================================ */

const APP_VERSION = "3B.5";

const API_BASE_URL = "https://read-write-ai-test-api.cjseeger.workers.dev";
const STUDY_CREATE_ENDPOINT = "/api/v1/studies";
const REPOSITORY_LABEL = "LandViz-Media/read-write-ai-test (public)";

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


/*
 * Overpass is a public, read-only OSM data service. Collection is intentionally
 * browser-side so this deterministic public-data request does not consume the
 * Cloudflare Worker/GitHub authentication path.
 */
const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
];

const OVERPASS_REQUEST_TIMEOUT_MS = 90000;

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
    results: document.getElementById("results"),

    osmCollectionCard: document.getElementById("osmCollectionCard"),
    osmCollectionStatus: document.getElementById("osmCollectionStatus"),
    osmStudyId: document.getElementById("osmStudyId"),
    osmCollectionArea: document.getElementById("osmCollectionArea"),
    osmAreaMethod: document.getElementById("osmAreaMethod"),
    collectOsmButton: document.getElementById("collectOsmButton"),
    osmCounts: document.getElementById("osmCounts"),
    osmSchoolCount: document.getElementById("osmSchoolCount"),
    osmBuildingCount: document.getElementById("osmBuildingCount"),
    osmRenderedBuildingCount: document.getElementById("osmRenderedBuildingCount"),
    osmLayerControls: document.getElementById("osmLayerControls"),
    showOsmBuildings: document.getElementById("showOsmBuildings"),
    showOsmSchools: document.getElementById("showOsmSchools"),
    osmCollectionDetails: document.getElementById("osmCollectionDetails"),
    osmEndpoint: document.getElementById("osmEndpoint"),
    osmTimestamp: document.getElementById("osmTimestamp"),
    osmRetrievedAt: document.getElementById("osmRetrievedAt"),
    osmSchoolTable: document.getElementById("osmSchoolTable"),
    osmDownloads: document.getElementById("osmDownloads"),
    downloadSchoolsButton: document.getElementById("downloadSchoolsButton"),
    downloadBuildingsButton: document.getElementById("downloadBuildingsButton"),

    schoolEducationCard: document.getElementById("schoolEducationCard"),
    schoolEducationStatus: document.getElementById("schoolEducationStatus"),
    schoolEducationStudyId: document.getElementById("schoolEducationStudyId"),
    schoolEducationOsmSchools: document.getElementById("schoolEducationOsmSchools"),
    schoolEducationOsmBuildings: document.getElementById("schoolEducationOsmBuildings"),
    runSchoolEducationButton: document.getElementById("runSchoolEducationButton"),
    schoolEducationCounts: document.getElementById("schoolEducationCounts"),
    candidateBuildingCount: document.getElementById("candidateBuildingCount"),
    educationCurrentCount: document.getElementById("educationCurrentCount"),
    educationComparisonCount: document.getElementById("educationComparisonCount"),
    schoolEducationLayerControls: document.getElementById("schoolEducationLayerControls"),
    showSchoolCandidates: document.getElementById("showSchoolCandidates"),
    educationSourceDetails: document.getElementById("educationSourceDetails"),
    educationCurrentSource: document.getElementById("educationCurrentSource"),
    educationComparisonSource: document.getElementById("educationComparisonSource"),
    candidateBuildingTable: document.getElementById("candidateBuildingTable"),
    educationMatchTable: document.getElementById("educationMatchTable")
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
    censusStateCache: new Map(),
    osmCollection: null,
    osmBuildingsLayer: null,
    osmSchoolsLayer: null,
    schoolCandidateLayer: null,
    schoolEducation: null
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
    resetOsmCollection();
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
        "Saving the study to the GitHub repository...";
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
            `Study ${study.id} was accepted by the Worker and persisted to the GitHub repository.`;

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
   OVERPASS / OSM DATA COLLECTION
   ============================================================ */

function buildOverpassQueries(extent) {
    /*
     * Overpass bounding boxes are south,west,north,east.
     * The saved study extent is already expressed in decimal degrees.
     */
    const bbox = [
        extent.minLatitude,
        extent.minLongitude,
        extent.maxLatitude,
        extent.maxLongitude
    ].map(value => Number(value).toFixed(7)).join(",");

    return {
        bbox,
        /*
         * Schools: nodes, ways, and relations tagged amenity=school.
         * `out center` gives a usable display point for non-node features.
         */
        schools:
            `[out:json][timeout:60];` +
            `nwr["amenity"="school"](${bbox});` +
            `out center;`,

        /*
         * Building footprints: OSM building ways with full geometry.
         * This intentionally focuses on footprints rather than every OSM
         * object carrying a building tag. Multipolygon handling can be added
         * in a later milestone when the reconciliation workflow requires it.
         */
        buildings:
            `[out:json][timeout:90];` +
            `way["building"](${bbox});` +
            `out geom;`
    };
}

async function fetchOverpass(query, endpoint) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
        () => controller.abort(),
        OVERPASS_REQUEST_TIMEOUT_MS
    );

    try {
        /*
         * Use the documented POST form (`data=<urlencoded query>`).
         * A cache-busting query parameter avoids accidental intermediary caching.
         */
        const requestUrl = `${endpoint}?_cb=${encodeURIComponent(Date.now().toString())}`;

        const response = await fetch(requestUrl, {
            method: "POST",
            cache: "no-store",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                Accept: "application/json"
            },
            body: `data=${encodeURIComponent(query)}`
        });

        const text = await response.text();
        let data;

        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(
                `Overpass returned a non-JSON response (HTTP ${response.status}).`
            );
        }

        if (!response.ok) {
            const detail =
                data?.remark ||
                data?.error ||
                `HTTP ${response.status}`;
            throw new Error(detail);
        }

        if (!Array.isArray(data?.elements)) {
            throw new Error("Overpass returned no element collection.");
        }

        return data;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(
                `The Overpass request timed out after ${OVERPASS_REQUEST_TIMEOUT_MS / 1000} seconds.`
            );
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchOverpassWithFallback(query) {
    const errors = [];

    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const data = await fetchOverpass(query, endpoint);
            return { data, endpoint, errors };
        } catch (error) {
            errors.push(`${endpoint}: ${error.message}`);
        }
    }

    throw new Error(
        "All configured Overpass endpoints failed. " + errors.join(" ")
    );
}

function osmElementKey(element) {
    return `${element.type}/${element.id}`;
}

function osmElementLabel(element) {
    const tags = element?.tags || {};
    return (
        tags.name ||
        tags["official_name"] ||
        tags.operator ||
        `${String(element.type).toUpperCase()} ${element.id}`
    );
}

function osmSchoolElementToFeature(element) {
    const tags = { ...(element.tags || {}) };

    if (element.type === "node" && Number.isFinite(Number(element.lat)) && Number.isFinite(Number(element.lon))) {
        return {
            type: "Feature",
            properties: {
                ...tags,
                osmType: element.type,
                osmId: element.id,
                osmUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`
            },
            geometry: {
                type: "Point",
                coordinates: [Number(element.lon), Number(element.lat)]
            }
        };
    }

    if (element.center &&
        Number.isFinite(Number(element.center.lat)) &&
        Number.isFinite(Number(element.center.lon))) {
        return {
            type: "Feature",
            properties: {
                ...tags,
                osmType: element.type,
                osmId: element.id,
                osmUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`
            },
            geometry: {
                type: "Point",
                coordinates: [Number(element.center.lon), Number(element.center.lat)]
            }
        };
    }

    return null;
}

function coordinatesEqual(a, b) {
    return Boolean(
        a && b &&
        Math.abs(a[0] - b[0]) < 1e-12 &&
        Math.abs(a[1] - b[1]) < 1e-12
    );
}

function osmBuildingElementToFeature(element) {
    const geometry = Array.isArray(element.geometry)
        ? element.geometry
            .filter(point => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)))
            .map(point => [Number(point.lon), Number(point.lat)])
        : [];

    if (geometry.length < 2) {
        return null;
    }

    const tags = { ...(element.tags || {}) };
    const isClosed = geometry.length >= 4 && coordinatesEqual(geometry[0], geometry[geometry.length - 1]);

    return {
        type: "Feature",
        properties: {
            ...tags,
            osmType: element.type,
            osmId: element.id,
            osmUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`
        },
        geometry: isClosed
            ? { type: "Polygon", coordinates: [geometry] }
            : { type: "LineString", coordinates: geometry }
    };
}

function buildOsmGeoJSON(rawSchools, rawBuildings) {
    const schools = rawSchools
        .map(osmSchoolElementToFeature)
        .filter(Boolean);

    const buildings = rawBuildings
        .map(osmBuildingElementToFeature)
        .filter(Boolean);

    return {
        schools: {
            type: "FeatureCollection",
            name: "osm-schools",
            features: schools
        },
        buildings: {
            type: "FeatureCollection",
            name: "osm-buildings",
            features: buildings
        }
    };
}

function clearOsmLayers() {
    clearSchoolCandidateLayer();

    if (state.osmBuildingsLayer) {
        state.map.removeLayer(state.osmBuildingsLayer);
        state.osmBuildingsLayer = null;
    }

    if (state.osmSchoolsLayer) {
        state.map.removeLayer(state.osmSchoolsLayer);
        state.osmSchoolsLayer = null;
    }
}

function schoolPopupHtml(feature) {
    const p = feature.properties || {};
    const label = escapeHtml(
        p.name || p.official_name || p.operator || `OSM ${p.osmType}/${p.osmId}`
    );
    const type = escapeHtml(`${p.osmType || ""}/${p.osmId || ""}`);
    const address = [p["addr:street"], p["addr:city"], p["addr:state"]]
        .filter(Boolean)
        .map(escapeHtml)
        .join(", ");
    const addressHtml = address ? `<br>${address}` : "";

    return `<strong>${label}</strong><br>${type}${addressHtml}<br>` +
        `<a href="${escapeHtml(p.osmUrl || "#")}" target="_blank" rel="noopener">Open in OpenStreetMap</a>`;
}

function renderOsmLayers(geojson) {
    clearOsmLayers();

    state.osmBuildingsLayer = L.geoJSON(geojson.buildings, {
        style: {
            weight: 1,
            fillOpacity: 0.08
        }
    });

    state.osmSchoolsLayer = L.geoJSON(geojson.schools, {
        pointToLayer: (_feature, latlng) =>
            L.circleMarker(latlng, {
                radius: 6,
                weight: 2,
                fillOpacity: 0.9
            }),
        onEachFeature: (feature, layer) => {
            layer.bindPopup(schoolPopupHtml(feature));
        }
    });

    if (dom.showOsmBuildings.checked) {
        state.osmBuildingsLayer.addTo(state.map);
    }

    if (dom.showOsmSchools.checked) {
        state.osmSchoolsLayer.addTo(state.map);
    }
}

function updateOsmLayerVisibility() {
    if (!state.osmCollection) {
        return;
    }

    if (state.osmBuildingsLayer) {
        if (dom.showOsmBuildings.checked) {
            state.osmBuildingsLayer.addTo(state.map);
        } else {
            state.map.removeLayer(state.osmBuildingsLayer);
        }
    }

    if (state.osmSchoolsLayer) {
        if (dom.showOsmSchools.checked) {
            state.osmSchoolsLayer.addTo(state.map);
        } else {
            state.map.removeLayer(state.osmSchoolsLayer);
        }
    }
}

function buildSchoolTable(geojson) {
    const features = geojson.schools.features;

    if (!features.length) {
        dom.osmSchoolTable.innerHTML =
            `<div class="result waiting"><div class="result-title">No school features found</div>` +
            `<div class="result-message">Overpass returned no elements tagged amenity=school inside the saved study area.</div></div>`;
        dom.osmSchoolTable.hidden = false;
        return;
    }

    const rows = features.map(feature => {
        const p = feature.properties || {};
        const name = p.name || p.official_name || p.operator || "(unnamed)";
        const address = [p["addr:street"], p["addr:city"], p["addr:state"]]
            .filter(Boolean)
            .join(", ");

        return `<tr>` +
            `<td>${escapeHtml(name)}</td>` +
            `<td>${escapeHtml(p.osmType || "")}/${escapeHtml(p.osmId || "")}</td>` +
            `<td>${escapeHtml(address || "—")}</td>` +
            `<td><a href="${escapeHtml(p.osmUrl || "#")}" target="_blank" rel="noopener">OSM</a></td>` +
            `</tr>`;
    }).join("");

    dom.osmSchoolTable.innerHTML =
        `<table>` +
        `<thead><tr><th>School</th><th>OSM ID</th><th>Address</th><th>Source</th></tr></thead>` +
        `<tbody>${rows}</tbody>` +
        `</table>`;
    dom.osmSchoolTable.hidden = false;
}

function updateOsmCollectionUI(collection) {
    const dimensions = calculateDimensions(collection.studyExtent);

    dom.osmCollectionStatus.textContent =
        `OSM collection complete. ${collection.schoolsGeoJSON.features.length} school features and ` +
        `${collection.buildingsGeoJSON.features.length} building footprints were returned.`;

    dom.osmStudyId.textContent = collection.studyId;
    dom.osmCollectionArea.textContent =
        `${dimensions.widthMiles.toFixed(1)} × ${dimensions.heightMiles.toFixed(1)} miles`;
    dom.osmAreaMethod.textContent = collection.areaMethod;

    dom.osmCounts.hidden = false;
    dom.osmSchoolCount.textContent = collection.schoolsGeoJSON.features.length;
    dom.osmBuildingCount.textContent = collection.buildingsRawCount;
    dom.osmRenderedBuildingCount.textContent = collection.buildingsGeoJSON.features.length;

    dom.osmLayerControls.hidden = false;
    dom.osmCollectionDetails.hidden = false;
    dom.osmEndpoint.textContent =
        `Schools: ${collection.schoolEndpoint}; Buildings: ${collection.buildingEndpoint}`;
    dom.osmTimestamp.textContent = collection.osmTimestamp || "Not supplied by Overpass";
    dom.osmRetrievedAt.textContent = new Date(collection.retrievedAt).toLocaleString();
    dom.osmDownloads.hidden = false;

    buildSchoolTable(collection.schoolsGeoJSON);
    revealSchoolEducationCard();
}

async function collectOsmData() {
    if (!state.studySaved || !state.currentStudy) {
        showResult(
            "Study Not Ready",
            "Save the study before collecting OpenStreetMap data.",
            "fail"
        );
        return;
    }

    const extent = state.currentStudy.studyArea.extent;
    const queries = buildOverpassQueries(extent);

    dom.collectOsmButton.disabled = true;
    dom.osmCollectionStatus.textContent =
        "Querying OpenStreetMap school features through Overpass...";

    const result = showResult(
        "Collecting OSM Data",
        "Querying Overpass for school features...",
        "running"
    );

    try {
        const schoolsResponse = await fetchOverpassWithFallback(queries.schools);

        result.querySelector(".result-message").textContent =
            "School features retrieved. Querying building footprints...";

        const buildingsResponse = await fetchOverpassWithFallback(queries.buildings);
        const geojson = buildOsmGeoJSON(
            schoolsResponse.data.elements,
            buildingsResponse.data.elements
        );

        const collection = {
            studyId: state.currentStudy.id,
            areaMethod: state.currentStudy.studyArea.method,
            studyExtent: extent,
            bbox: queries.bbox,
            schoolEndpoint: schoolsResponse.endpoint,
            buildingEndpoint: buildingsResponse.endpoint,
            retrievedAt: new Date().toISOString(),
            osmTimestamp:
                buildingsResponse.data.osm3s?.timestamp_osm_base ||
                schoolsResponse.data.osm3s?.timestamp_osm_base ||
                "",
            schoolsRawCount: schoolsResponse.data.elements.length,
            buildingsRawCount: buildingsResponse.data.elements.length,
            schoolsGeoJSON: geojson.schools,
            buildingsGeoJSON: geojson.buildings,
            queries
        };

        state.osmCollection = collection;
        renderOsmLayers(geojson);
        updateOsmCollectionUI(collection);

        result.className = "result pass";
        result.querySelector(".result-title").textContent = "✓ OSM Data Collected";
        result.querySelector(".result-message").textContent =
            `Returned ${collection.schoolsRawCount} school features and ` +
            `${collection.buildingsRawCount} building footprints from the saved study area.`;

        result.appendChild(createDataPre({
            studyId: collection.studyId,
            bbox: collection.bbox,
            schoolFeatures: collection.schoolsRawCount,
            buildingFeatures: collection.buildingsRawCount,
            schoolEndpoint: collection.schoolEndpoint,
            buildingEndpoint: collection.buildingEndpoint,
            osmTimestamp: collection.osmTimestamp,
            persistence: "client-side test output only; OSM data is not written to GitHub in Test 3B.4"
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        dom.osmCollectionStatus.textContent =
            `Unable to collect OSM data: ${message}`;

        result.className = "result fail";
        result.querySelector(".result-title").textContent = "OSM Collection Failed";
        result.querySelector(".result-message").textContent = message;

        result.appendChild(createDataPre({
            stage: "overpass-collection",
            studyId: state.currentStudy.id,
            bbox: queries.bbox,
            endpointsTried: OVERPASS_ENDPOINTS
        }));
    } finally {
        dom.collectOsmButton.disabled = false;
    }
}

function revealOsmCollection() {
    if (!state.studySaved || !state.currentStudy) {
        return;
    }

    dom.osmCollectionCard.hidden = false;
    dom.osmStudyId.textContent = state.currentStudy.id;
    dom.osmAreaMethod.textContent = state.currentStudy.studyArea.method;

    const dimensions = calculateDimensions(state.currentStudy.studyArea.extent);
    dom.osmCollectionArea.textContent =
        `${dimensions.widthMiles.toFixed(1)} × ${dimensions.heightMiles.toFixed(1)} miles`;

    dom.osmCollectionStatus.textContent =
        "The saved study area is ready for OpenStreetMap collection.";

    dom.osmCollectionCard.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

function downloadGeoJSON(geojson, filename) {
    const blob = new Blob(
        [JSON.stringify(geojson, null, 2)],
        { type: "application/geo+json" }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadOsmSchools() {
    if (!state.osmCollection) return;
    downloadGeoJSON(
        state.osmCollection.schoolsGeoJSON,
        `${state.osmCollection.studyId}-osm-schools.geojson`
    );
}

function downloadOsmBuildings() {
    if (!state.osmCollection) return;
    downloadGeoJSON(
        state.osmCollection.buildingsGeoJSON,
        `${state.osmCollection.studyId}-osm-buildings.geojson`
    );
}

/* ============================================================
   SCHOOL BUILDING + EDUCATION DATA
   ============================================================ */

const EDUCATION_DATA_SOURCES = {
    page: "https://educate.iowa.gov/pk-12/data/education-statistics",
    currentDirectory: "https://educate.iowa.gov/media/11648/download?inline=",
    currentEnrollment: "https://educate.iowa.gov/media/12228/download?inline=",
    comparisonEnrollment: "https://educate.iowa.gov/media/7631/download?inline="
};

const SCHOOL_BUILDING_CANDIDATE_RADIUS_METERS = 150;
const EDUCATION_REQUEST_TIMEOUT_MS = 30000;

function clearSchoolCandidateLayer() {
    if (state.schoolCandidateLayer) {
        state.map.removeLayer(state.schoolCandidateLayer);
        state.schoolCandidateLayer = null;
    }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371008.8;
    const toRadians = value => value * Math.PI / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function featureRepresentativePoint(feature) {
    const geometry = feature?.geometry;
    if (!geometry) return null;

    if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
        return [Number(geometry.coordinates[1]), Number(geometry.coordinates[0])];
    }

    const positions = [];

    function collectPositions(coords) {
        if (!Array.isArray(coords)) return;
        if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
            positions.push([Number(coords[1]), Number(coords[0])]);
            return;
        }
        coords.forEach(collectPositions);
    }

    collectPositions(geometry.coordinates);

    if (!positions.length) return null;

    const lat = positions.reduce((sum, point) => sum + point[0], 0) / positions.length;
    const lon = positions.reduce((sum, point) => sum + point[1], 0) / positions.length;
    return [lat, lon];
}

function normalizeSchoolText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’‘]/g, "'")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim()
        .replace(/\\s+/g, " ");
}

function schoolTokens(value) {
    const stopWords = new Set([
        "THE", "SCHOOL", "SCHOOLS", "DISTRICT", "DIST", "COMMUNITY",
        "COMM", "PUBLIC", "ACADEMY", "CAMPUS", "CENTER", "CTR"
    ]);
    return new Set(
        normalizeSchoolText(value)
            .split(" ")
            .filter(token => token && !stopWords.has(token))
    );
}

function tokenJaccard(a, b) {
    const aSet = schoolTokens(a);
    const bSet = schoolTokens(b);
    const union = new Set([...aSet, ...bSet]);
    if (!union.size) return 0;
    let intersection = 0;
    aSet.forEach(token => {
        if (bSet.has(token)) intersection += 1;
    });
    return intersection / union.size;
}

function levenshteinRatio(a, b) {
    const left = normalizeSchoolText(a);
    const right = normalizeSchoolText(b);
    if (!left && !right) return 1;
    if (!left || !right) return 0;

    const previous = Array(right.length + 1).fill(0);
    const current = Array(right.length + 1).fill(0);
    for (let j = 0; j <= right.length; j += 1) previous[j] = j;

    for (let i = 1; i <= left.length; i += 1) {
        current[0] = i;
        for (let j = 1; j <= right.length; j += 1) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + cost
            );
        }
        for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
    }

    return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function schoolMatchScore(osmSchool, doeRecord) {
    const osmName =
        osmSchool.properties?.name ||
        osmSchool.properties?.official_name ||
        osmSchool.properties?.operator ||
        "";
    const osmCity = osmSchool.properties?.["addr:city"] || "";

    const exact = normalizeSchoolText(osmName) === normalizeSchoolText(doeRecord.schoolName);
    if (exact) return { score: 100, method: "exact-name" };

    const tokenScore = tokenJaccard(osmName, doeRecord.schoolName);
    const editScore = levenshteinRatio(osmName, doeRecord.schoolName);
    let score = Math.round(Math.max(tokenScore * 100, editScore * 100));
    let method = "name-similarity";

    if (osmCity && doeRecord.city && normalizeSchoolText(osmCity) === normalizeSchoolText(doeRecord.city)) {
        score = Math.min(100, score + 8);
        method = "name-and-city";
    }

    return { score, method };
}

function identifyCandidateSchoolBuildings() {
    if (!state.osmCollection) {
        throw new Error("Collect OSM data before identifying candidate school buildings.");
    }

    const schools = state.osmCollection.schoolsGeoJSON.features;
    const buildings = state.osmCollection.buildingsGeoJSON.features;
    const candidatesByBuilding = new Map();
    const candidatesBySchool = [];

    schools.forEach(school => {
        const schoolPoint = featureRepresentativePoint(school);
        if (!schoolPoint) return;

        const schoolCandidates = buildings
            .map(building => {
                const buildingPoint = featureRepresentativePoint(building);
                if (!buildingPoint) return null;

                const distance = haversineMeters(
                    schoolPoint[0],
                    schoolPoint[1],
                    buildingPoint[0],
                    buildingPoint[1]
                );

                if (distance > SCHOOL_BUILDING_CANDIDATE_RADIUS_METERS) return null;

                return {
                    schoolOsmKey: `${school.properties?.osmType}/${school.properties?.osmId}`,
                    schoolName:
                        school.properties?.name ||
                        school.properties?.official_name ||
                        school.properties?.operator ||
                        "(unnamed school)",
                    buildingOsmKey: `${building.properties?.osmType}/${building.properties?.osmId}`,
                    buildingFeature: building,
                    distanceMeters: distance,
                    buildingName: building.properties?.name || "",
                    buildingType: building.properties?.building || "yes"
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.distanceMeters - b.distanceMeters);

        candidatesBySchool.push({
            school,
            candidates: schoolCandidates
        });

        schoolCandidates.forEach(candidate => {
            if (!candidatesByBuilding.has(candidate.buildingOsmKey)) {
                candidatesByBuilding.set(candidate.buildingOsmKey, candidate);
            }
        });
    });

    const candidateFeatures = [...candidatesByBuilding.values()].map(candidate => ({
        ...candidate.buildingFeature,
        properties: {
            ...(candidate.buildingFeature.properties || {}),
            candidateForSchool: candidate.schoolName,
            candidateDistanceMeters: Number(candidate.distanceMeters.toFixed(1)),
            candidateRadiusMeters: SCHOOL_BUILDING_CANDIDATE_RADIUS_METERS,
            candidateRole: "school-building-candidate"
        }
    }));

    return {
        radiusMeters: SCHOOL_BUILDING_CANDIDATE_RADIUS_METERS,
        candidatesBySchool,
        candidateBuildings: {
            type: "FeatureCollection",
            name: "osm-school-building-candidates",
            features: candidateFeatures
        },
        uniqueCandidateCount: candidateFeatures.length
    };
}

function candidateBuildingPopupHtml(feature) {
    const p = feature.properties || {};
    const name = escapeHtml(p.name || `OSM ${p.osmType}/${p.osmId}`);
    const school = escapeHtml(p.candidateForSchool || "School feature");
    const distance = Number(p.candidateDistanceMeters);
    const distanceText = Number.isFinite(distance) ? `${distance.toFixed(1)} m` : "—";
    return `<strong>${name}</strong><br>` +
        `Candidate for: ${school}<br>` +
        `Distance from school feature: ${escapeHtml(distanceText)}<br>` +
        `<a href="${escapeHtml(p.osmUrl || "#")}" target="_blank" rel="noopener">Open in OpenStreetMap</a>`;
}

function renderSchoolBuildingCandidates(candidateData) {
    clearSchoolCandidateLayer();

    state.schoolCandidateLayer = L.geoJSON(candidateData.candidateBuildings, {
        style: {
            weight: 2,
            fillOpacity: 0.18,
            dashArray: "5 4"
        },
        onEachFeature: (feature, layer) => {
            layer.bindPopup(candidateBuildingPopupHtml(feature));
        }
    });

    if (dom.showSchoolCandidates.checked) {
        state.schoolCandidateLayer.addTo(state.map);
    }
}

function updateSchoolCandidateVisibility() {
    if (!state.schoolCandidateLayer) return;
    if (dom.showSchoolCandidates.checked) {
        state.schoolCandidateLayer.addTo(state.map);
    } else {
        state.map.removeLayer(state.schoolCandidateLayer);
    }
}

function buildCandidateBuildingTable(candidateData) {
    const rows = candidateData.candidatesBySchool.flatMap(entry =>
        entry.candidates.map(candidate => ({
            schoolName: entry.school.properties?.name || entry.school.properties?.official_name || "(unnamed school)",
            schoolOsmId: `${entry.school.properties?.osmType}/${entry.school.properties?.osmId}`,
            buildingOsmId: candidate.buildingOsmKey,
            distanceMeters: candidate.distanceMeters,
            buildingType: candidate.buildingType,
            buildingName: candidate.buildingName,
            osmUrl: candidate.buildingFeature.properties?.osmUrl || "#"
        }))
    );

    if (!rows.length) {
        dom.candidateBuildingTable.innerHTML =
            `<div class="result waiting"><div class="result-title">No nearby candidate buildings</div>` +
            `<div class="result-message">No OSM building footprints were found within ${SCHOOL_BUILDING_CANDIDATE_RADIUS_METERS} meters of the returned school features.</div></div>`;
        dom.candidateBuildingTable.hidden = false;
        return;
    }

    const body = rows.map(row =>
        `<tr>` +
        `<td>${escapeHtml(row.schoolName)}</td>` +
        `<td>${escapeHtml(row.schoolOsmId)}</td>` +
        `<td>${escapeHtml(row.buildingOsmId)}</td>` +
        `<td>${row.distanceMeters.toFixed(1)} m</td>` +
        `<td>${escapeHtml(row.buildingType)}</td>` +
        `<td>${escapeHtml(row.buildingName || "—")}</td>` +
        `<td><a href="${escapeHtml(row.osmUrl)}" target="_blank" rel="noopener">OSM</a></td>` +
        `</tr>`
    ).join("");

    dom.candidateBuildingTable.innerHTML =
        `<div class="school-education-table">` +
        `<h3>Candidate OSM School Buildings</h3>` +
        `<p class="table-note">Candidate buildings are deterministic spatial matches within ${SCHOOL_BUILDING_CANDIDATE_RADIUS_METERS} meters of each mapped school feature. They are not yet classified as actual school buildings.</p>` +
        `<table><thead><tr>` +
        `<th>OSM School</th><th>School OSM ID</th><th>Building OSM ID</th><th>Distance</th><th>Building Tag</th><th>Building Name</th><th>Source</th>` +
        `</tr></thead><tbody>${body}</tbody></table></div>`;
    dom.candidateBuildingTable.hidden = false;
}

function normalizeHeader(value) {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim();
}

function toNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = String(value ?? "").replace(/,/g, "").trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
}

function normalizeCode(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const digits = text.replace(/[^0-9]/g, "");
    return digits || normalizeSchoolText(text);
}

function findHeaderRow(rows) {
    const aliases = {
        school: ["SCHOOL", "SCHOOL NAME"],
        district: ["DISTRICT", "DISTRICT NAME"],
        total: ["TOTAL", "TOTAL ENROLLMENT", "PK 12", "K 12", "ENROLLMENT"]
    };

    let best = { index: -1, score: 0 };

    rows.slice(0, 60).forEach((row, index) => {
        const headers = row.map(normalizeHeader);
        let score = 0;
        if (headers.some(h => aliases.school.includes(h))) score += 3;
        if (headers.some(h => aliases.district.includes(h))) score += 2;
        if (headers.some(h => aliases.total.includes(h) || /TOTAL.*ENROLL/.test(h))) score += 2;
        if (headers.some(h => /^PK$|^KG$|^K$|^GRADE/.test(h))) score += 1;
        if (score > best.score) best = { index, score };
    });

    return best.index >= 0 && best.score >= 3 ? best.index : -1;
}

function mapGradeName(header) {
    const h = normalizeHeader(header);
    if (/^(PK|PRE K|PREK|PRE KINDERGARTEN|PRESCHOOL)$/.test(h)) return "PK";
    if (/^(K|KG|KINDERGARTEN)$/.test(h)) return "K";
    const match = h.match(/^(?:GRADE|GR|YEAR)?\s*([0-9]{1,2})(?:ST|ND|RD|TH)?$/);
    if (match) {
        const number = Number(match[1]);
        if (number >= 1 && number <= 12) return String(number);
    }
    const ordinal = h.match(/^(1ST|2ND|3RD|4TH|5TH|6TH|7TH|8TH|9TH|10TH|11TH|12TH)$/);
    if (ordinal) return ordinal[1].replace(/ST$|ND$|RD$|TH$/, "");
    return null;
}

function findColumn(headers, tests) {
    for (let i = 0; i < headers.length; i += 1) {
        const header = normalizeHeader(headers[i]);
        if (tests.some(test => test(header))) return i;
    }
    return -1;
}

function parseEnrollmentWorkbook(buffer, yearLabel) {
    if (!window.XLSX) {
        throw new Error("SheetJS did not load, so the Iowa enrollment workbook cannot be read in the browser.");
    }

    const workbook = XLSX.read(buffer, { type: "array" });
    const records = [];

    workbook.SheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
        const headerIndex = findHeaderRow(rows);
        if (headerIndex < 0) return;

        const headers = rows[headerIndex];
        const schoolIndex = findColumn(headers, [
            h => h === "SCHOOL",
            h => h === "SCHOOL NAME"
        ]);
        if (schoolIndex < 0) return;

        const districtCodeIndex = findColumn(headers, [
            h => h === "DISTRICT",
            h => h === "DISTRICT CODE",
            h => h.includes("DISTRICT") && h.includes("CODE")
        ]);
        const schoolCodeIndex = findColumn(headers, [
            h => h === "SCHOOL CODE",
            h => h === "SCHOOL ID",
            h => h.includes("SCHOOL") && h.includes("CODE")
        ]);
        const districtNameIndex = findColumn(headers, [
            h => h === "DISTRICT NAME",
            h => h.includes("DISTRICT") && h.includes("NAME")
        ]);
        const totalIndex = findColumn(headers, [
            h => /^TOTAL$/.test(h),
            h => /TOTAL.*ENROLL/.test(h),
            h => /PK 12/.test(h) || /K 12/.test(h)
        ]);

        const gradeColumns = headers
            .map((header, index) => ({ grade: mapGradeName(header), index }))
            .filter(item => item.grade !== null);

        for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
            const row = rows[rowIndex];
            if (!row || !row.length) continue;

            const schoolName = String(row[schoolIndex] ?? "").trim();
            if (!schoolName) continue;

            const grades = {};
            gradeColumns.forEach(({ grade, index }) => {
                const value = toNumber(row[index]);
                if (value !== null) grades[grade] = value;
            });

            let total = totalIndex >= 0 ? toNumber(row[totalIndex]) : null;
            if (total === null && Object.keys(grades).length) {
                total = Object.values(grades).reduce((sum, value) => sum + value, 0);
            }

            records.push({
                year: yearLabel,
                sheet: sheetName,
                districtCode: districtCodeIndex >= 0 ? normalizeCode(row[districtCodeIndex]) : "",
                schoolCode: schoolCodeIndex >= 0 ? normalizeCode(row[schoolCodeIndex]) : "",
                districtName: districtNameIndex >= 0 ? String(row[districtNameIndex] ?? "").trim() : "",
                schoolName,
                total,
                grades
            });
        }
    });

    if (!records.length) {
        throw new Error(`The ${yearLabel} Iowa enrollment workbook was read, but no school building enrollment records could be identified.`);
    }

    return deduplicateEducationRecords(records);
}

function deduplicateEducationRecords(records) {
    const map = new Map();
    records.forEach(record => {
        const key = record.districtCode && record.schoolCode
            ? `${record.districtCode}|${record.schoolCode}`
            : `${normalizeSchoolText(record.districtName)}|${normalizeSchoolText(record.schoolName)}|${record.year}`;
        if (!map.has(key)) map.set(key, record);
    });
    return [...map.values()];
}

function parseDirectoryWorkbook(buffer, yearLabel) {
    if (!window.XLSX) {
        throw new Error("SheetJS did not load, so the Iowa school building directory cannot be read in the browser.");
    }

    const workbook = XLSX.read(buffer, { type: "array" });
    const records = [];

    workbook.SheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
        const headerIndex = findHeaderRow(rows);
        if (headerIndex < 0) return;

        const headers = rows[headerIndex];
        const schoolIndex = findColumn(headers, [h => h === "SCHOOL", h => h === "SCHOOL NAME"]);
        if (schoolIndex < 0) return;

        const districtCodeIndex = findColumn(headers, [
            h => h === "DISTRICT",
            h => h === "DISTRICT CODE",
            h => h.includes("DISTRICT") && h.includes("CODE")
        ]);
        const districtNameIndex = findColumn(headers, [h => h === "DISTRICT NAME", h => h.includes("DISTRICT") && h.includes("NAME")]);
        const schoolCodeIndex = findColumn(headers, [h => h === "SCHOOL CODE", h => h === "SCHOOL ID", h => h.includes("SCHOOL") && h.includes("CODE")]);
        const streetIndex = findColumn(headers, [h => h === "STREET ADDRESS", h => h.includes("STREET") && h.includes("ADDRESS")]);
        const cityIndex = findColumn(headers, [h => h === "CITY", h => h.includes("MAILING CITY")]);
        const gradesIndex = findColumn(headers, [h => h === "GRADES", h => h.includes("GRADE")]);
        const levelIndex = findColumn(headers, [h => h.includes("SCHOOL LEVEL") || h === "LEVEL"]);

        for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
            const row = rows[rowIndex];
            if (!row || !row.length) continue;
            const schoolName = String(row[schoolIndex] ?? "").trim();
            if (!schoolName) continue;

            records.push({
                year: yearLabel,
                sheet: sheetName,
                districtCode: districtCodeIndex >= 0 ? normalizeCode(row[districtCodeIndex]) : "",
                districtName: districtNameIndex >= 0 ? String(row[districtNameIndex] ?? "").trim() : "",
                schoolCode: schoolCodeIndex >= 0 ? normalizeCode(row[schoolCodeIndex]) : "",
                schoolName,
                streetAddress: streetIndex >= 0 ? String(row[streetIndex] ?? "").trim() : "",
                city: cityIndex >= 0 ? String(row[cityIndex] ?? "").trim() : "",
                gradesText: gradesIndex >= 0 ? String(row[gradesIndex] ?? "").trim() : "",
                schoolLevel: levelIndex >= 0 ? String(row[levelIndex] ?? "").trim() : ""
            });
        }
    });

    return deduplicateDirectoryRecords(records);
}

function deduplicateDirectoryRecords(records) {
    const map = new Map();
    records.forEach(record => {
        const key = record.districtCode && record.schoolCode
            ? `${record.districtCode}|${record.schoolCode}`
            : `${normalizeSchoolText(record.districtName)}|${normalizeSchoolText(record.schoolName)}|${record.year}`;
        if (!map.has(key)) map.set(key, record);
    });
    return [...map.values()];
}

function mergeDirectoryIntoEnrollment(enrollmentRecords, directoryRecords) {
    const byCode = new Map();
    const byName = new Map();

    directoryRecords.forEach(record => {
        if (record.districtCode && record.schoolCode) {
            byCode.set(`${record.districtCode}|${record.schoolCode}`, record);
        }
        byName.set(`${normalizeSchoolText(record.districtName)}|${normalizeSchoolText(record.schoolName)}`, record);
    });

    return enrollmentRecords.map(record => {
        const codeMatch = record.districtCode && record.schoolCode
            ? byCode.get(`${record.districtCode}|${record.schoolCode}`)
            : null;
        const nameMatch = byName.get(
            `${normalizeSchoolText(record.districtName)}|${normalizeSchoolText(record.schoolName)}`
        );
        const directory = codeMatch || nameMatch || null;

        return {
            ...record,
            directory: directory ? {
                streetAddress: directory.streetAddress,
                city: directory.city,
                gradesText: directory.gradesText,
                schoolLevel: directory.schoolLevel
            } : null
        };
    });
}

async function fetchArrayBuffer(url, label) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EDUCATION_REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}_cb=${Date.now()}`, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: {
                Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel, application/octet-stream"
            }
        });

        if (!response.ok) {
            throw new Error(`${label} returned HTTP ${response.status}.`);
        }

        const contentType = response.headers.get("content-type") || "";
        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) {
            throw new Error(`${label} returned an empty file.`);
        }

        return { buffer, contentType };
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(`${label} request timed out after ${EDUCATION_REQUEST_TIMEOUT_MS / 1000} seconds.`);
        }
        if (error?.name === "TypeError") {
            throw new Error(
                `The browser could not directly fetch ${label}. ` +
                "The Iowa Department of Education file may require a Worker proxy if the source blocks cross-origin browser requests."
            );
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function findBestEducationMatches(osmSchools, currentRecords) {
    return osmSchools.map(school => {
        const candidates = currentRecords.map(record => {
            const match = schoolMatchScore(school, record);
            return { record, ...match };
        }).sort((a, b) => b.score - a.score);

        const best = candidates[0] || null;
        let matchStatus = "no-match";
        if (best?.score === 100) matchStatus = "exact-name";
        else if (best?.score >= 85) matchStatus = "close-name";
        else if (best?.score >= 65) matchStatus = "review";

        return {
            osmSchool: school,
            best,
            alternatives: candidates.slice(1, 3),
            matchStatus
        };
    });
}

function findHistoricalRecord(currentRecord, comparisonRecords) {
    if (!currentRecord) return null;

    if (currentRecord.districtCode && currentRecord.schoolCode) {
        const codeMatch = comparisonRecords.find(record =>
            record.districtCode === currentRecord.districtCode &&
            record.schoolCode === currentRecord.schoolCode
        );
        if (codeMatch) return codeMatch;
    }

    const exactName = comparisonRecords.find(record =>
        normalizeSchoolText(record.schoolName) === normalizeSchoolText(currentRecord.schoolName) &&
        normalizeSchoolText(record.districtName) === normalizeSchoolText(currentRecord.districtName)
    );

    if (exactName) return exactName;

    return comparisonRecords.find(record =>
        normalizeSchoolText(record.schoolName) === normalizeSchoolText(currentRecord.schoolName)
    ) || null;
}

function calculateGradeChanges(current, historical) {
    if (!current || !historical) return {};
    const grades = new Set([
        ...Object.keys(current.grades || {}),
        ...Object.keys(historical.grades || {})
    ]);

    const changes = {};
    [...grades].sort((a, b) => {
        const order = ["PK", "K", ...Array.from({ length: 12 }, (_, i) => String(i + 1))];
        return order.indexOf(a) - order.indexOf(b);
    }).forEach(grade => {
        const currentValue = current.grades?.[grade];
        const historicalValue = historical.grades?.[grade];
        if (currentValue === undefined && historicalValue === undefined) return;
        changes[grade] = {
            current: currentValue ?? null,
            historical: historicalValue ?? null,
            change: currentValue !== undefined && historicalValue !== undefined
                ? currentValue - historicalValue
                : null
        };
    });

    return changes;
}

function buildEducationMatchData(osmSchools, currentRecords, comparisonRecords) {
    return findBestEducationMatches(osmSchools, currentRecords).map(item => {
        const current = item.best?.record || null;
        const historical = findHistoricalRecord(current, comparisonRecords);
        const currentTotal = current?.total ?? null;
        const historicalTotal = historical?.total ?? null;

        return {
            ...item,
            current,
            historical,
            totalChange:
                currentTotal !== null && historicalTotal !== null
                    ? currentTotal - historicalTotal
                    : null,
            percentChange:
                currentTotal !== null && historicalTotal !== null && historicalTotal !== 0
                    ? ((currentTotal - historicalTotal) / historicalTotal) * 100
                    : null,
            gradeChanges: calculateGradeChanges(current, historical)
        };
    });
}

function formatGradeChanges(gradeChanges) {
    const entries = Object.entries(gradeChanges || {});
    if (!entries.length) return "—";

    return entries.map(([grade, values]) => {
        const c = values.current === null ? "—" : values.current;
        const h = values.historical === null ? "—" : values.historical;
        const d = values.change === null ? "—" : (values.change > 0 ? `+${values.change}` : values.change);
        return `<span>${escapeHtml(grade)}: ${escapeHtml(String(c))} / ${escapeHtml(String(h))} (${escapeHtml(String(d))})</span>`;
    }).join("; ");
}

function buildEducationMatchTable(matchData) {
    if (!matchData.length) {
        dom.educationMatchTable.innerHTML =
            `<div class="result waiting"><div class="result-title">No education matches to display</div>` +
            `<div class="result-message">No OSM school features were returned.</div></div>`;
        dom.educationMatchTable.hidden = false;
        return;
    }

    const rows = matchData.map(item => {
        const osmName = item.osmSchool.properties?.name || item.osmSchool.properties?.official_name || "(unnamed school)";
        const current = item.current;
        const historical = item.historical;
        const currentTotal = current?.total ?? null;
        const historicalTotal = historical?.total ?? null;
        const changeText = item.totalChange === null || item.totalChange === undefined
            ? "—"
            : `${item.totalChange > 0 ? "+" : ""}${item.totalChange}` +
              (item.percentChange === null || item.percentChange === undefined
                  ? ""
                  : ` (${item.percentChange > 0 ? "+" : ""}${item.percentChange.toFixed(1)}%)`);
        const statusText = item.matchStatus === "exact-name"
            ? "Exact name"
            : item.matchStatus === "close-name"
                ? "Close name"
                : item.matchStatus === "review"
                    ? "Review"
                    : "No match";
        const statusClass = item.matchStatus === "exact-name" || item.matchStatus === "close-name"
            ? "match-good"
            : item.matchStatus === "review"
                ? "match-review"
                : "match-none";
        const gradeText = formatGradeChanges(item.gradeChanges);

        return `<tr>` +
            `<td>${escapeHtml(osmName)}</td>` +
            `<td>${escapeHtml(current?.schoolName || "—")}</td>` +
            `<td>${escapeHtml(current?.districtName || "—")}</td>` +
            `<td class="${statusClass}">${escapeHtml(statusText)}<br><small>${item.best ? `${item.best.score}/100 · ${escapeHtml(item.best.method)}` : ""}</small></td>` +
            `<td>${currentTotal === null ? "—" : currentTotal.toLocaleString()}</td>` +
            `<td>${historicalTotal === null ? "—" : historicalTotal.toLocaleString()}</td>` +
            `<td>${escapeHtml(changeText)}</td>` +
            `<td class="grade-values">${gradeText}</td>` +
            `</tr>`;
    }).join("");

    dom.educationMatchTable.innerHTML =
        `<div class="school-education-table">` +
        `<h3>OSM School ↔ Iowa DOE Evidence</h3>` +
        `<p class="table-note">Current enrollment is 2025-26 and the historical comparison is 2020-21. Grade cells show current / historical (change). Name matching is deterministic test logic, not an AI or final reconciliation decision.</p>` +
        `<table><thead><tr>` +
        `<th>OSM School</th><th>DOE School</th><th>District</th><th>Match</th><th>2025-26 Total</th><th>2020-21 Total</th><th>Total Change</th><th>Grade Values</th>` +
        `</tr></thead><tbody>${rows}</tbody></table></div>`;
    dom.educationMatchTable.hidden = false;
}

function updateSchoolEducationUI(data) {
    const osmSchoolCount = state.osmCollection?.schoolsGeoJSON.features.length || 0;
    const osmBuildingCount = state.osmCollection?.buildingsGeoJSON.features.length || 0;

    dom.schoolEducationStudyId.textContent = state.currentStudy?.id || "—";
    dom.schoolEducationOsmSchools.textContent = String(osmSchoolCount);
    dom.schoolEducationOsmBuildings.textContent = String(osmBuildingCount);
    dom.schoolEducationCounts.hidden = false;
    dom.candidateBuildingCount.textContent = String(data.candidates.uniqueCandidateCount);
    dom.educationCurrentCount.textContent = String(data.currentEnrollment.length);
    dom.educationComparisonCount.textContent = String(data.comparisonEnrollment.length);
    dom.schoolEducationLayerControls.hidden = false;
    dom.educationSourceDetails.hidden = false;
    dom.candidateBuildingTable.hidden = false;
    dom.educationMatchTable.hidden = false;

    buildCandidateBuildingTable(data.candidates);
    buildEducationMatchTable(data.matches);
}

async function runSchoolEducationTest() {
    if (!state.studySaved || !state.currentStudy || !state.osmCollection) {
        showResult(
            "School/Education Test Not Ready",
            "Save the study and complete OSM Data Collection before running the school-building and education-data test.",
            "fail"
        );
        return;
    }

    dom.runSchoolEducationButton.disabled = true;
    dom.schoolEducationStatus.textContent =
        "Identifying OSM buildings near the mapped school features...";

    const result = showResult(
        "School Building + Education Test",
        "Identifying candidate OSM school buildings...",
        "running"
    );

    try {
        const candidates = identifyCandidateSchoolBuildings();
        renderSchoolBuildingCandidates(candidates);

        const studyStates = new Set(state.currentStudy.cities.map(city => city.stateAbbr));
        if (!studyStates.has("IA") || studyStates.size !== 1) {
            throw new Error(
                "The OSM candidate-building test completed, but the education portion of Test 3B.5 is currently scoped to Iowa Department of Education data. Run this milestone with an Iowa-only study area."
            );
        }

        result.querySelector(".result-message").textContent =
            "Candidate buildings identified. Fetching the 2025-26 Iowa school building directory...";
        dom.schoolEducationStatus.textContent =
            "Candidate buildings identified. Loading the current Iowa Department of Education building directory...";

        const [directoryResponse, currentEnrollmentResponse, comparisonEnrollmentResponse] = await Promise.all([
            fetchArrayBuffer(EDUCATION_DATA_SOURCES.currentDirectory, "2025-26 Iowa Public School Building Directory"),
            fetchArrayBuffer(EDUCATION_DATA_SOURCES.currentEnrollment, "2025-26 Public School Building enrollment"),
            fetchArrayBuffer(EDUCATION_DATA_SOURCES.comparisonEnrollment, "2020-21 Public School Building enrollment")
        ]);

        result.querySelector(".result-message").textContent =
            "DOE files retrieved. Parsing building and enrollment records in the browser...";
        dom.schoolEducationStatus.textContent =
            "DOE files retrieved. Parsing the building directory and enrollment workbooks in the browser...";

        const directory = parseDirectoryWorkbook(directoryResponse.buffer, "2025-26");
        const currentEnrollment = mergeDirectoryIntoEnrollment(
            parseEnrollmentWorkbook(currentEnrollmentResponse.buffer, "2025-26"),
            directory
        );
        const comparisonEnrollment = parseEnrollmentWorkbook(
            comparisonEnrollmentResponse.buffer,
            "2020-21"
        );

        const osmSchools = state.osmCollection.schoolsGeoJSON.features;
        const matches = buildEducationMatchData(
            osmSchools,
            currentEnrollment,
            comparisonEnrollment
        );

        state.schoolEducation = {
            studyId: state.currentStudy.id,
            candidates,
            directory,
            currentEnrollment,
            comparisonEnrollment,
            matches,
            sources: EDUCATION_DATA_SOURCES,
            retrievedAt: new Date().toISOString()
        };

        updateSchoolEducationUI(state.schoolEducation);

        dom.schoolEducationStatus.textContent =
            `School-building and education-data test complete. ${candidates.uniqueCandidateCount} unique OSM building candidates were identified and ${matches.filter(item => item.current).length} of ${matches.length} OSM school features have a deterministic DOE candidate match.`;

        result.className = "result pass";
        result.querySelector(".result-title").textContent = "✓ School Building + Education Data Loaded";
        result.querySelector(".result-message").textContent =
            `Returned ${osmSchools.length} OSM school features, identified ${candidates.uniqueCandidateCount} candidate buildings, ` +
            `and parsed ${currentEnrollment.length} current and ${comparisonEnrollment.length} comparison DOE enrollment records.`;

        result.appendChild(createDataPre({
            studyId: state.currentStudy.id,
            candidateBuildingRadiusMeters: SCHOOL_BUILDING_CANDIDATE_RADIUS_METERS,
            candidateBuildings: candidates.uniqueCandidateCount,
            currentEnrollmentRecords: currentEnrollment.length,
            comparisonEnrollmentRecords: comparisonEnrollment.length,
            deterministicMatches: matches.filter(item => item.current).length,
            source: EDUCATION_DATA_SOURCES,
            persistence: "client-side test output only; education/reconciliation results are not written to GitHub in Test 3B.5"
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dom.schoolEducationStatus.textContent =
            `Unable to complete school-building and education-data test: ${message}`;
        result.className = "result fail";
        result.querySelector(".result-title").textContent = "School Building + Education Test Failed";
        result.querySelector(".result-message").textContent = message;
        result.appendChild(createDataPre({
            stage: "school-building-education",
            studyId: state.currentStudy.id,
            sources: EDUCATION_DATA_SOURCES
        }));
    } finally {
        dom.runSchoolEducationButton.disabled = false;
    }
}

function revealSchoolEducationCard() {
    if (!state.studySaved || !state.currentStudy || !state.osmCollection) return;
    dom.schoolEducationCard.hidden = false;
    dom.schoolEducationStudyId.textContent = state.currentStudy.id;
    dom.schoolEducationOsmSchools.textContent = String(state.osmCollection.schoolsGeoJSON.features.length);
    dom.schoolEducationOsmBuildings.textContent = String(state.osmCollection.buildingsGeoJSON.features.length);
    dom.schoolEducationStatus.textContent =
        "OSM data are ready. Run the school-building and Iowa education-data test.";
}

function resetOsmCollection() {
    state.osmCollection = null;
    state.schoolEducation = null;
    clearOsmLayers();
    dom.osmCollectionCard.hidden = true;
    dom.osmCounts.hidden = true;
    dom.osmLayerControls.hidden = true;
    dom.osmCollectionDetails.hidden = true;
    dom.osmSchoolTable.hidden = true;
    dom.osmDownloads.hidden = true;
    dom.schoolEducationCard.hidden = true;
    dom.schoolEducationCounts.hidden = true;
    dom.schoolEducationLayerControls.hidden = true;
    dom.educationSourceDetails.hidden = true;
    dom.candidateBuildingTable.hidden = true;
    dom.educationMatchTable.hidden = true;
    dom.runSchoolEducationButton.disabled = false;
    dom.showSchoolCandidates.checked = true;
    dom.collectOsmButton.disabled = false;
    dom.showOsmBuildings.checked = true;
    dom.showOsmSchools.checked = true;
}

/* ============================================================
   CONTINUE
   ============================================================ */

function continueToOsmCollection() {
    if (!state.studySaved || !state.currentStudy) {
        return;
    }

    revealOsmCollection();

    showResult(
        "Ready for OSM Data Collection",
        `Study ${state.currentStudy.id} is saved. The next step collects ` +
        "OpenStreetMap school features and building footprints from the saved study area.",
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
dom.collectOsmButton.addEventListener("click", collectOsmData);
dom.showOsmBuildings.addEventListener("change", updateOsmLayerVisibility);
dom.showOsmSchools.addEventListener("change", updateOsmLayerVisibility);
dom.downloadSchoolsButton.addEventListener("click", downloadOsmSchools);
dom.downloadBuildingsButton.addEventListener("click", downloadOsmBuildings);
dom.runSchoolEducationButton.addEventListener("click", runSchoolEducationTest);
dom.showSchoolCandidates.addEventListener("change", updateSchoolCandidateVisibility);

/* ============================================================
   INITIALIZATION
   ============================================================ */

initializeStateSelectors();
initializeMap();
updateSaveControls();
updateCreateButton();
