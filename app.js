/*
 * Read / Write AI Test
 *
 * Responsibility:
 *   Controls the browser-side Study Setup workflow,
 *   geocoding, Leaflet map, study-area geometry, and
 *   persistence of the study through the
 *   Cloudflare Worker.
 *
 * Test 3B.3.3.1:
 *   - Replace Nominatim city geocoding with validated U.S. Census place resolution.
 *   - Enable Save Study after the study area has been created.
 *   - Generate a stable study ID in the browser.
 *   - Send the study to the Worker through the
 *     application-level study API.
 *   - The Worker/GitHub App remains responsible for GitHub auth
 *     and writing the private repository files.
 *
 * Important geometry rule:
 *   The buffer is applied to the combined geographic extent
 *   containing both city points. It is NOT a circular buffer
 *   around either city.
 */


/* ============================================================
   DOM REFERENCES
   ============================================================ */

const studyNameInput =
    document.getElementById("studyName");

const city1Input =
    document.getElementById("city1");

const city2Input =
    document.getElementById("city2");

const bufferDistanceInput =
    document.getElementById("bufferDistance");

const createStudyAreaButton =
    document.getElementById("createStudyAreaButton");

const saveStudyButton =
    document.getElementById("saveStudyButton");

const continueButton =
    document.getElementById("continueButton");

const mapStatus =
    document.getElementById("mapStatus");

const locationDetails =
    document.getElementById("locationDetails");

const city1Resolved =
    document.getElementById("city1Resolved");

const city2Resolved =
    document.getElementById("city2Resolved");

const studyAreaDimensions =
    document.getElementById("studyAreaDimensions");

const saveSummary =
    document.getElementById("saveSummary");

const studyIdDisplay =
    document.getElementById("studyIdDisplay");

const studyStatusDisplay =
    document.getElementById("studyStatusDisplay");

const repositoryDisplay =
    document.getElementById("repositoryDisplay");

const resultsContainer =
    document.getElementById("results");


/* ============================================================
   CONFIGURATION
   ============================================================ */

/*
 * Application API endpoint.
 *
 * The browser talks to the Cloudflare Worker only for private GitHub persistence. It never
 * receives the GitHub App private key or an installation token.
 *
 * Test 3B.3.3.1 expects the Worker to expose:
 *
 *   POST /api/v1/studies
 *
 * The request body is the complete study object plus
 * its GeoJSON study-area artifact. The Worker should persist:
 *
 *   data/studies.json
 *   data/studyAreas/{studyId}.geojson
 *
 * and return the persisted study ID and file paths.
 */

const API_BASE_URL =
    "https://read-write-ai-test-api.cjseeger.workers.dev";

const STUDY_CREATE_ENDPOINT =
    "/api/v1/studies";


/*
 * Public geocoder.
 */

/*
 * Census place resolution is performed directly from the browser.
 * See the CENSUS PLACE RESOLUTION section below.
 */


/*
 * One degree of latitude is approximately this many miles.
 * Longitude varies with latitude and is adjusted below.
 */

const MILES_PER_DEGREE_LATITUDE =
    69.0;


/*
 * Repository information is display metadata only. The browser
 * does not use it for authentication.
 */

const REPOSITORY_LABEL =
    "LandViz-Media/read-write-ai-test (private)";


/* ============================================================
   MAP STATE
   ============================================================ */

let map = null;

let cityMarkers = [];

let studyAreaLayer = null;

let currentStudy = null;

let studySaved = false;


/* ============================================================
   MAP INITIALIZATION
   ============================================================ */

/**
 * Initialize the Leaflet map.
 */
function initializeMap() {

    map = L.map("map", {
        zoomControl: true
    }).setView(
        [42.0, -93.5],
        7
    );


    L.tileLayer(
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }
    ).addTo(map);


    requestAnimationFrame(() => {
        map.invalidateSize({
            pan: false
        });
    });
}


/* ============================================================
   INPUT VALIDATION
   ============================================================ */

/**
 * Validate Study Setup inputs.
 *
 * @returns {boolean}
 */
function validateStudyInputs() {

    const studyName =
        studyNameInput.value.trim();

    const city1 =
        city1Input.value.trim();

    const city2 =
        city2Input.value.trim();

    const buffer =
        Number(bufferDistanceInput.value);


    if (!studyName || !city1 || !city2) {
        return false;
    }


    if (
        Number.isNaN(buffer) ||
        buffer < 0 ||
        buffer > 25
    ) {
        return false;
    }


    return true;
}


/**
 * Update the Create Study Area button.
 */
function updateCreateButton() {

    createStudyAreaButton.disabled =
        !validateStudyInputs();
}


/* ============================================================
   RESULT DISPLAY
   ============================================================ */

/**
 * Display a status result.
 *
 * @param {string} title
 * @param {string} message
 * @param {"waiting"|"running"|"pass"|"fail"} status
 * @param {object|null} data
 * @returns {HTMLElement}
 */
function showResult(
    title,
    message,
    status = "waiting",
    data = null
) {

    resultsContainer.innerHTML = "";


    const result =
        document.createElement("div");

    result.className =
        `result ${status}`;


    const titleElement =
        document.createElement("div");

    titleElement.className =
        "result-title";

    titleElement.textContent =
        title;


    const messageElement =
        document.createElement("div");

    messageElement.className =
        "result-message";

    messageElement.textContent =
        message;


    result.appendChild(titleElement);
    result.appendChild(messageElement);


    if (data !== null) {

        const pre =
            document.createElement("pre");

        pre.textContent =
            JSON.stringify(data, null, 2);

        result.appendChild(pre);
    }


    resultsContainer.appendChild(result);

    return result;
}


/* ============================================================
   CENSUS PLACE RESOLUTION
   ============================================================ */

/*
 * The user enters a city/place, not a street address. The Census
 * Geocoder is an address geocoder and requires a street address;
 * it is therefore not the correct Census service for city-only
 * input. Census TIGERweb exposes the current Incorporated Places,
 * Census Designated Places, and Consolidated Cities layers with
 * place names and representative coordinates.
 *
 * We use those Census place layers directly from the browser. This
 * keeps the operation client-side, avoids a Worker call, and avoids
 * hard-coding Iowa. The Worker remains responsible only for the
 * private GitHub persistence operation.
 *
 * Census Geocoder documentation:
 *   https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
 *
 * Census TIGERweb REST service:
 *   https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb
 */

const CENSUS_TIGERWEB_BASE_URL =
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer";

/* Current 2026 place layers. */
const CENSUS_PLACE_LAYERS = [
    {
        id: 4,
        label: "Incorporated Place"
    },
    {
        id: 5,
        label: "Census Designated Place"
    },
    {
        id: 3,
        label: "Consolidated City"
    }
];

const STATE_FIPS = {
    AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06",
    CO: "08", CT: "09", DE: "10", DC: "11", FL: "12",
    GA: "13", HI: "15", ID: "16", IL: "17", IN: "18",
    IA: "19", KS: "20", KY: "21", LA: "22", ME: "23",
    MD: "24", MA: "25", MI: "26", MN: "27", MS: "28",
    MO: "29", MT: "30", NE: "31", NV: "32", NH: "33",
    NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38",
    OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
    SC: "45", SD: "46", TN: "47", TX: "48", UT: "49",
    VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
    WY: "56", PR: "72"
};

const STATE_NAMES = {
    ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR",
    CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE",
    DISTRICTOFCOLUMBIA: "DC", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI",
    IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS",
    KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
    MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS",
    MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
    NEWHAMPSHIRE: "NH", NEWJERSEY: "NJ", NEWMEXICO: "NM", NEWYORK: "NY",
    NORTHCAROLINA: "NC", NORTHDAKOTA: "ND", OHIO: "OH", OKLAHOMA: "OK",
    OREGON: "OR", PENNSYLVANIA: "PA", RHODEISLAND: "RI", SOUTHCAROLINA: "SC",
    SOUTHDAKOTA: "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT",
    VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", WESTVIRGINIA: "WV",
    WISCONSIN: "WI", WYOMING: "WY", PUERTORICO: "PR"
};

/**
 * Parse a city/place input such as "Jefferson, IA" or
 * "Jefferson, Iowa". A state is required because place names
 * are not unique nationally.
 *
 * @param {string} query
 * @returns {{city: string, stateAbbr: string, stateName: string, stateFips: string}}
 */
function parseCityInput(query) {

    const parts = String(query)
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);

    if (parts.length < 2) {
        throw new Error(
            `Enter the city and state, for example "Jefferson, IA".`
        );
    }

    const city = parts[0];
    const stateInput = parts.slice(1).join(" ");
    const normalizedState = stateInput
        .toUpperCase()
        .replace(/[^A-Z]/g, "");

    let stateAbbr = normalizedState;

    if (STATE_NAMES[normalizedState]) {
        stateAbbr = STATE_NAMES[normalizedState];
    }

    if (!STATE_FIPS[stateAbbr]) {
        throw new Error(
            `"${stateInput}" is not a recognized U.S. state or territory abbreviation/name.`
        );
    }

    const stateName = Object.entries(STATE_NAMES)
        .find(([, abbr]) => abbr === stateAbbr)?.[0] || stateAbbr;

    return {
        city,
        stateAbbr,
        stateName,
        stateFips: STATE_FIPS[stateAbbr]
    };
}

/**
 * Query a Census TIGERweb place layer.
 *
 * @param {number} layerId
 * @param {string} city
 * @param {string} stateFips
 * @returns {Promise<Array>}
 */
async function fetchCensusPlaceLayer(layerId, city, stateFips) {

    const url = new URL(
        `${CENSUS_TIGERWEB_BASE_URL}/${layerId}/query`
    );

    const escapedCity = city
        .replace(/'/g, "''")
        .toUpperCase();

    /*
     * ArcGIS standardized string comparisons can be case-sensitive.
     * Use UPPER() so inputs such as "Madrid", "MADRID", and
     * "madrid" resolve to the same Census place. The state filter
     * keeps the request small and prevents same-name places in other
     * states from being considered.
     */
    url.searchParams.set(
        "where",
        `UPPER(BASENAME) = UPPER('${escapedCity}') AND STATE = '${stateFips}'`
    );
    url.searchParams.set(
        "outFields",
        "BASENAME,NAME,STATE,GEOID,PLACE,PLACECC,CENTLAT,CENTLON,INTPTLAT,INTPTLON"
    );
    url.searchParams.set("returnGeometry", "false");
    url.searchParams.set("sqlFormat", "standard");
    url.searchParams.set("f", "json");
    url.searchParams.set("_cb", Date.now().toString());

    const response = await fetch(url.toString(), {
        method: "GET",
        cache: "no-store",
        headers: {
            "Accept": "application/json"
        }
    });

    if (!response.ok) {
        throw new Error(
            `Census place lookup failed with HTTP ${response.status}.`
        );
    }

    const data = await response.json();

    if (data.error) {
        throw new Error(
            data.error.message || "The Census place service returned an error."
        );
    }

    return Array.isArray(data.features)
        ? data.features
        : [];
}

/**
 * Validate and rank Census place features.
 *
 * Only an exact Census BASENAME match in the requested state is
 * accepted. This prevents a county or other administrative feature
 * from being substituted for the requested city/place.
 *
 * @param {Array} features
 * @param {string} requestedCity
 * @returns {object|null}
 */
function selectCensusPlaceResult(features, requestedCity) {

    const requested = normalizePlaceName(requestedCity);

    const matches = features
        .map(feature => feature.attributes || {})
        .filter(attributes => {
            const basename = normalizePlaceName(attributes.BASENAME || "");
            return basename === requested;
        });

    if (matches.length === 0) {
        return null;
    }

    matches.sort((a, b) => {
        const score = attributes => {
            const placecc = String(attributes.PLACECC || "").toUpperCase();
            let value = 0;

            /* Incorporated places are preferred when both layers
             * happen to represent the same named place. */
            if (placecc.startsWith("C1")) value += 20;
            if (attributes.INTPTLAT && attributes.INTPTLON) value += 10;
            if (attributes.CENTLAT && attributes.CENTLON) value += 5;

            return value;
        };

        return score(b) - score(a);
    });

    return matches[0];
}

/**
 * Resolve a city/place against current Census TIGERweb place data.
 *
 * @param {string} query
 * @returns {Promise<object>}
 */
async function geocodeCity(query) {

    const parsed = parseCityInput(query);
    const layerErrors = [];

    for (const layer of CENSUS_PLACE_LAYERS) {
        try {
            const features = await fetchCensusPlaceLayer(
                layer.id,
                parsed.city,
                parsed.stateFips
            );

            const selected = selectCensusPlaceResult(
                features,
                parsed.city
            );

            if (selected) {
                return {
                    ...selected,
                    censusLayer: layer.id,
                    censusLayerLabel: layer.label,
                    requestedCity: parsed.city,
                    requestedState: parsed.stateAbbr,
                    requestedStateName: parsed.stateName
                };
            }
        } catch (error) {
            layerErrors.push(error.message);
        }
    }

    if (layerErrors.length === CENSUS_PLACE_LAYERS.length) {
        throw new Error(
            `The Census TIGERweb place service could not be queried for "${parsed.city}, ${parsed.stateAbbr}". ` +
            layerErrors[0]
        );
    }

    throw new Error(
        `Census did not return a validated incorporated place, census-designated place, or consolidated city named ` +
        `"${parsed.city}" in ${parsed.stateAbbr}. The result was rejected rather than substituting a county or other administrative feature.`
    );
}

/**
 * Create the compact location object stored in the study record.
 *
 * @param {string} input
 * @param {object} result
 * @returns {object}
 */
function createLocationObject(input, result) {

    const latitude = Number(
        result.INTPTLAT || result.CENTLAT
    );

    const longitude = Number(
        result.INTPTLON || result.CENTLON
    );

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error(
            `The Census place service returned invalid coordinates for "${input}".`
        );
    }

    const displayName =
        result.NAME ||
        `${result.BASENAME}, ${result.requestedState}`;

    return {
        input,
        name: result.BASENAME,
        state: result.requestedStateName,
        stateAbbr: result.requestedState,
        country: "United States",
        latitude,
        longitude,
        displayName,
        geocoder: "U.S. Census Bureau TIGERweb",
        censusLayer: result.censusLayerLabel,
        censusGEOID: result.GEOID || "",
        censusPlaceCode: result.PLACE || "",
        censusPlaceClassCode: result.PLACECC || ""
    };
}


/* ============================================================
   GEOMETRY
   ============================================================ */

/**
 * Convert miles to degrees of latitude.
 *
 * @param {number} miles
 * @returns {number}
 */
function milesToLatitudeDegrees(miles) {
    return miles / MILES_PER_DEGREE_LATITUDE;
}


/**
 * Convert miles to degrees of longitude at a given latitude.
 *
 * @param {number} miles
 * @param {number} latitude
 * @returns {number}
 */
function milesToLongitudeDegrees(miles, latitude) {

    const radians =
        latitude * Math.PI / 180;

    const milesPerDegreeLongitude =
        MILES_PER_DEGREE_LATITUDE * Math.cos(radians);


    return miles / milesPerDegreeLongitude;
}


/**
 * Create the buffered geographic extent containing both cities.
 *
 * The buffer expands all four sides of the combined extent.
 *
 * @param {object} city1
 * @param {object} city2
 * @param {number} bufferMiles
 * @returns {object}
 */
function calculateStudyExtent(city1, city2, bufferMiles) {

    const minLatitude =
        Math.min(city1.latitude, city2.latitude);

    const maxLatitude =
        Math.max(city1.latitude, city2.latitude);

    const minLongitude =
        Math.min(city1.longitude, city2.longitude);

    const maxLongitude =
        Math.max(city1.longitude, city2.longitude);


    const centerLatitude =
        (minLatitude + maxLatitude) / 2;

    const latitudeBuffer =
        milesToLatitudeDegrees(bufferMiles);

    const longitudeBuffer =
        milesToLongitudeDegrees(
            bufferMiles,
            centerLatitude
        );


    return {
        minLatitude:
            minLatitude - latitudeBuffer,

        maxLatitude:
            maxLatitude + latitudeBuffer,

        minLongitude:
            minLongitude - longitudeBuffer,

        maxLongitude:
            maxLongitude + longitudeBuffer
    };
}


/**
 * Convert an extent to Leaflet bounds.
 *
 * @param {object} extent
 * @returns {L.LatLngBounds}
 */
function extentToLeafletBounds(extent) {

    return L.latLngBounds(
        [
            extent.minLatitude,
            extent.minLongitude
        ],
        [
            extent.maxLatitude,
            extent.maxLongitude
        ]
    );
}


/* ============================================================
   GEOJSON
   ============================================================ */

/**
 * Create the study-area GeoJSON artifact.
 *
 * The polygon is deliberately simple and represents the
 * buffered rectangular geographic extent used by the study.
 *
 * @param {object} study
 * @returns {object}
 */
function createStudyAreaGeoJSON(study) {

    const extent =
        study.studyArea.extent;

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
                    bufferDistance:
                        study.buffer.distance,
                    bufferUnits:
                        study.buffer.units
                },
                geometry: {
                    type: "Polygon",
                    coordinates: [[
                        [
                            extent.minLongitude,
                            extent.minLatitude
                        ],
                        [
                            extent.maxLongitude,
                            extent.minLatitude
                        ],
                        [
                            extent.maxLongitude,
                            extent.maxLatitude
                        ],
                        [
                            extent.minLongitude,
                            extent.maxLatitude
                        ],
                        [
                            extent.minLongitude,
                            extent.minLatitude
                        ]
                    ]]
                }
            }
        ]
    };
}


/* ============================================================
   MAP DISPLAY
   ============================================================ */

/**
 * Remove the existing city markers.
 */
function clearCityMarkers() {

    cityMarkers.forEach(marker => {
        map.removeLayer(marker);
    });

    cityMarkers = [];
}


/**
 * Remove the existing study-area polygon.
 */
function clearStudyArea() {

    if (studyAreaLayer !== null) {
        map.removeLayer(studyAreaLayer);
        studyAreaLayer = null;
    }
}


/**
 * Display the two geocoded cities and the study area.
 *
 * @param {object} city1
 * @param {object} city2
 * @param {object} extent
 */
function displayStudyArea(city1, city2, extent) {

    clearCityMarkers();
    clearStudyArea();


    const marker1 =
        L.marker([
            city1.latitude,
            city1.longitude
        ])
        .addTo(map)
        .bindPopup(
            `<strong>City 1</strong><br>${escapeHtml(city1.displayName)}`
        );


    const marker2 =
        L.marker([
            city2.latitude,
            city2.longitude
        ])
        .addTo(map)
        .bindPopup(
            `<strong>City 2</strong><br>${escapeHtml(city2.displayName)}`
        );


    cityMarkers.push(marker1, marker2);


    const bounds =
        extentToLeafletBounds(extent);


    studyAreaLayer =
        L.rectangle(
            bounds,
            {
                weight: 2,
                fillOpacity: 0.12
            }
        )
        .addTo(map);


    map.invalidateSize({
        pan: false
    });

    map.fitBounds(
        bounds,
        {
            padding: [30, 30],
            maxZoom: 12
        }
    );


    setTimeout(() => {
        map.invalidateSize({
            pan: false
        });

        map.fitBounds(
            bounds,
            {
                padding: [30, 30],
                maxZoom: 12
            }
        );
    }, 100);


    studyAreaLayer.bindPopup(
        `<strong>Study Area</strong><br>` +
        `Buffered geographic extent of the two selected cities.`
    );
}


/* ============================================================
   HTML SAFETY
   ============================================================ */

/**
 * Escape text before inserting it into Leaflet popup HTML.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


/* ============================================================
   STUDY AREA INFORMATION
   ============================================================ */

/**
 * Calculate approximate width and height of the study area.
 *
 * @param {object} extent
 * @returns {object}
 */
function calculateDimensions(extent) {

    const centerLatitude =
        (extent.minLatitude + extent.maxLatitude) / 2;

    const latitudeMiles =
        (extent.maxLatitude - extent.minLatitude) *
        MILES_PER_DEGREE_LATITUDE;

    const longitudeMiles =
        (extent.maxLongitude - extent.minLongitude) *
        MILES_PER_DEGREE_LATITUDE *
        Math.cos(centerLatitude * Math.PI / 180);


    return {
        widthMiles: longitudeMiles,
        heightMiles: latitudeMiles
    };
}


/**
 * Update the location detail cards.
 */
function updateLocationDetails(city1, city2, extent) {

    city1Resolved.textContent =
        city1.displayName;

    city2Resolved.textContent =
        city2.displayName;


    const dimensions =
        calculateDimensions(extent);


    studyAreaDimensions.textContent =
        `${dimensions.widthMiles.toFixed(1)} × ` +
        `${dimensions.heightMiles.toFixed(1)} miles`;


    locationDetails.hidden = false;
}


/* ============================================================
   STUDY IDENTIFIER
   ============================================================ */

/**
 * Generate a browser-side study ID.
 *
 * The date portion makes the ID easy to recognize while the
 * time/random suffix prevents ordinary collisions between study
 * creation attempts.
 *
 * @returns {string}
 */
function generateStudyId() {

    const now =
        new Date();

    const year =
        now.getFullYear();

    const month =
        String(now.getMonth() + 1).padStart(2, "0");

    const day =
        String(now.getDate()).padStart(2, "0");

    const time =
        [
            now.getHours(),
            now.getMinutes(),
            now.getSeconds()
        ]
        .map(value =>
            String(value).padStart(2, "0")
        )
        .join("");


    const random =
        Math.random()
            .toString(36)
            .slice(2, 7);


    return `study-${year}${month}${day}-${time}-${random}`;
}


/* ============================================================
   STUDY OBJECT
   ============================================================ */

/**
 * Build the persistent study object from the current study-area state.
 *
 * @returns {object}
 */
function buildStudyRecord() {

    if (currentStudy === null) {
        throw new Error(
            "There is no study to save."
        );
    }


    const now =
        new Date().toISOString();


    return {
        id: currentStudy.id,

        name: currentStudy.name,

        application: "osm-scout",

        created: currentStudy.created,

        updated: now,

        status: "study-area-created",

        cities: currentStudy.cities,

        buffer: currentStudy.buffer,

        studyArea: currentStudy.studyArea,

        provenance: {
            geocoder: "U.S. Census Bureau TIGERweb",
            geocodedAt: currentStudy.geocodedAt,
            mapReviewedBeforeSave: true
        }
    };
}


/* ============================================================
   SAVE SUMMARY
   ============================================================ */

/**
 * Update the save summary shown after the study is created.
 */
function updateSaveSummary(study, statusText = "Ready to save") {

    studyIdDisplay.textContent =
        study.id;

    studyStatusDisplay.textContent =
        statusText;

    repositoryDisplay.textContent =
        REPOSITORY_LABEL;

    saveSummary.hidden = false;
}


/**
 * Update Save Study availability.
 *
 * The map and resolved locations are presented for review before
 * this button becomes available. No separate checkbox is required;
 * clicking Save Study is the user's review/approval action.
 */
function updateSaveControls() {

    const hasStudy =
        currentStudy !== null;

    saveStudyButton.disabled =
        !hasStudy || studySaved;
}


/* ============================================================
   WORKER RESPONSE HANDLING
   ============================================================ */

/**
 * Convert a failed Worker response into a useful error message.
 *
 * @param {Response} response
 * @returns {Promise<Error>}
 */
async function createApiError(response) {

    let payload = null;

    try {
        payload = await response.json();
    } catch (error) {
        /* The response was not JSON. Use the HTTP status below. */
    }


    const serverMessage =
        payload?.message ||
        payload?.error ||
        payload?.details ||
        "";


    return new Error(
        serverMessage
            ? `${serverMessage} (HTTP ${response.status})`
            : `Study save request failed with HTTP ${response.status}.`
    );
}


/**
 * Persist the reviewed study through the Cloudflare Worker.
 *
 * @param {object} study
 * @returns {Promise<object>}
 */
async function saveStudyToWorker(study) {

    const geojson =
        createStudyAreaGeoJSON(study);


    const payload = {
        study: study,
        studyArea: geojson
    };


    const response =
        await fetch(
            `${API_BASE_URL}${STUDY_CREATE_ENDPOINT}`,
            {
                method: "POST",
                cache: "no-store",

                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },

                body: JSON.stringify(payload)
            }
        );


    if (!response.ok) {
        throw await createApiError(response);
    }


    const result =
        await response.json();


    if (result.ok !== true) {
        throw new Error(
            result.message ||
            "The Worker did not confirm that the study was saved."
        );
    }


    return result;
}


/* ============================================================
   CREATE STUDY AREA
   ============================================================ */

/**
 * Geocode both cities and create the study-area extent.
 */
async function createStudyArea() {

    if (!validateStudyInputs()) {

        showResult(
            "Study Setup Incomplete",
            "Please provide a study name, two cities, and a valid buffer distance.",
            "fail"
        );

        return;
    }


    const studyName =
        studyNameInput.value.trim();

    const city1InputValue =
        city1Input.value.trim();

    const city2InputValue =
        city2Input.value.trim();

    const buffer =
        Number(bufferDistanceInput.value);


    createStudyAreaButton.disabled = true;
    saveStudyButton.disabled = true;
    continueButton.disabled = true;
    studySaved = false;


    mapStatus.textContent =
        "Resolving the two cities with U.S. Census place data...";


    const runningResult =
        showResult(
            "Creating Study Area",
            "Resolving City 1 with U.S. Census place data...",
            "running"
        );


    try {

        /*
         * Keep the requests sequential because Nominatim asks
         * clients to avoid bursts of requests.
         */

        const city1Result =
            await geocodeCity(city1InputValue);


        runningResult
            .querySelector(".result-message")
            .textContent =
            "Resolving City 2 with U.S. Census place data...";


        const city2Result =
            await geocodeCity(city2InputValue);


        const city1 =
            createLocationObject(
                city1InputValue,
                city1Result
            );

        const city2 =
            createLocationObject(
                city2InputValue,
                city2Result
            );


        const extent =
            calculateStudyExtent(
                city1,
                city2,
                buffer
            );


        const now =
            new Date().toISOString();


        currentStudy = {
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
                extent: extent
            }
        };


        displayStudyArea(
            city1,
            city2,
            extent
        );


        updateLocationDetails(
            city1,
            city2,
            extent
        );

        updateSaveSummary(
            currentStudy,
            "Ready to save"
        );

        updateSaveControls();

        mapStatus.textContent =
            "Study area created. Review the map, then save the study.";


        runningResult.className =
            "result pass";

        runningResult
            .querySelector(".result-title")
            .textContent =
            "✓ Study Area Created";

        runningResult
            .querySelector(".result-message")
            .textContent =
            `Both U.S. Census place records were validated successfully. ` +
            `The combined extent was buffered by ${buffer.toFixed(1)} miles on all four sides. ` +
            `Study ID: ${currentStudy.id}`;


        saveStudyButton.disabled = false;

    } catch (error) {

        currentStudy = null;
        studySaved = false;

        clearCityMarkers();
        clearStudyArea();

        locationDetails.hidden = true;
        saveSummary.hidden = true;

        mapStatus.textContent =
            "Unable to create the study area.";


        runningResult.className =
            "result fail";

        runningResult
            .querySelector(".result-title")
            .textContent =
            "Study Area Creation Failed";

        runningResult
            .querySelector(".result-message")
            .textContent =
            error.message;

    } finally {
        updateCreateButton();
    }
}


/* ============================================================
   SAVE STUDY
   ============================================================ */

/**
 * Save the study through the Worker.
 */
async function saveStudy() {

    if (currentStudy === null) {

        showResult(
            "Nothing to Save",
            "Create and review a study area first.",
            "fail"
        );

        return;
    }


    if (studySaved) {

        showResult(
            "Study Already Saved",
            `Study ${currentStudy.id} has already been persisted.`,
            "pass"
        );

        return;
    }


    saveStudyButton.disabled = true;
    continueButton.disabled = true;
    createStudyAreaButton.disabled = true;

    mapStatus.textContent =
        "Saving the study to the private GitHub repository...";


    updateSaveSummary(
        currentStudy,
        "Saving..."
    );


    const runningResult =
        showResult(
            "Saving Study",
            "Sending the study to the Cloudflare Worker...",
            "running"
        );


    try {

        const study =
            buildStudyRecord();

        const apiResult =
            await saveStudyToWorker(study);


        studySaved = true;

        currentStudy = {
            ...study,
            updated: study.updated,
            persistence: apiResult
        };


        updateSaveSummary(
            currentStudy,
            "Saved to GitHub"
        );


        mapStatus.textContent =
            "Study saved. You may continue to OSM data collection.";


        runningResult.className =
            "result pass";

        runningResult
            .querySelector(".result-title")
            .textContent =
            "✓ Study Saved";

        runningResult
            .querySelector(".result-message")
            .textContent =
            `Study ${study.id} was accepted by the Worker and persisted to the private GitHub repository.`;


        runningResult.appendChild(
            createDataPre(
                {
                    studyId: study.id,
                    studiesFile:
                        apiResult.files?.studies ||
                        "data/studies.json",
                    studyAreaFile:
                        apiResult.files?.studyArea ||
                        `data/studyAreas/${study.id}.geojson`
                }
            )
        );


        continueButton.disabled = false;

    } catch (error) {

        studySaved = false;

        updateSaveSummary(
            currentStudy,
            "Save failed"
        );

        mapStatus.textContent =
            "The study was not confirmed as saved.";


        runningResult.className =
            "result fail";

        runningResult
            .querySelector(".result-title")
            .textContent =
            "Study Save Failed";

        runningResult
            .querySelector(".result-message")
            .textContent =
            error.message;


        /*
         * Leave Save enabled so the user can retry after fixing
         * an API or network problem. No duplicate is created by
         * this browser-side code because the same study ID is
         * reused on retry.
         */

        saveStudyButton.disabled = false;

    } finally {

        if (!studySaved) {
            updateCreateButton();
        }
    }
}


/**
 * Create a preformatted result element.
 *
 * @param {object} data
 * @returns {HTMLElement}
 */
function createDataPre(data) {

    const pre =
        document.createElement("pre");

    pre.textContent =
        JSON.stringify(data, null, 2);

    return pre;
}


/* ============================================================
   CONTINUE
   ============================================================ */

/**
 * Continue to the next workflow milestone.
 *
 * Test 3B.3.3 does not yet collect Overpass data. This button
 * simply proves that the persisted study can be handed to the
 * next stage without creating another study.
 */
function continueToOsmCollection() {

    if (!studySaved || currentStudy === null) {
        return;
    }


    showResult(
        "Ready for OSM Data Collection",
        `Study ${currentStudy.id} is saved and ready for the next milestone. ` +
        `OSM/Overpass collection will be implemented next.`,
        "pass",
        {
            studyId: currentStudy.id,
            status: currentStudy.status,
            nextStep: "osm-data-collection"
        }
    );
}


/* ============================================================
   INPUT EVENTS
   ============================================================ */

function invalidateCurrentStudy() {
    studySaved = false;
    currentStudy = null;
    saveSummary.hidden = true;
    saveStudyButton.disabled = true;
    continueButton.disabled = true;
}


studyNameInput.addEventListener(
    "input",
    () => {
        invalidateCurrentStudy();
        updateCreateButton();
    }
);

city1Input.addEventListener(
    "input",
    () => {
        invalidateCurrentStudy();
        updateCreateButton();
    }
);

city2Input.addEventListener(
    "input",
    () => {
        invalidateCurrentStudy();
        updateCreateButton();
    }
);

bufferDistanceInput.addEventListener(
    "input",
    () => {
        invalidateCurrentStudy();
        updateCreateButton();
    }
);



/* ============================================================
   EVENT HANDLERS
   ============================================================ */

createStudyAreaButton.addEventListener(
    "click",
    createStudyArea
);

saveStudyButton.addEventListener(
    "click",
    saveStudy
);

continueButton.addEventListener(
    "click",
    continueToOsmCollection
);


/* ============================================================
   INITIALIZATION
   ============================================================ */

initializeMap();
updateSaveControls();
updateCreateButton();
