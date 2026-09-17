/*
 * Read / Write AI Test
 *
 * Responsibility:
 *   Controls the browser-side Study Setup workflow,
 *   geocoding, Leaflet map, study-area geometry, and
 *   persistence of the study through the
 *   Cloudflare Worker.
 *
 * Test 3B.3:
 *   - Preserve the Test 3B.2 geocoding and map workflow.
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
 * The browser talks only to the Cloudflare Worker. It never
 * receives the GitHub App private key or an installation token.
 *
 * Test 3B.3 expects the Worker to expose:
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

const NOMINATIM_URL =
    "https://nominatim.openstreetmap.org/search";


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
   GEOCODING
   ============================================================ */

/**
 * Geocode a city using Nominatim.
 *
 * The search is restricted to U.S. settlements and prefers an
 * exact city/town/village match in Iowa. This helps prevent a
 * query such as "Boone, Iowa" from resolving to Boone County.
 *
 * @param {string} query
 * @returns {Promise<object>}
 */
async function geocodeCity(query) {

    const parsed = parseCityInput(query);
    const requestedName = parsed.city.toLowerCase();


    /*
     * First use Nominatim's structured search. This is much safer
     * for a city/state input than asking Nominatim to interpret a
     * free-form string such as "Jefferson, IA".
     *
     * Nominatim documents `city` and `state` as structured search
     * fields and `featureType=settlement` as a way to restrict the
     * result to inhabited places rather than counties or other
     * administrative features.
     */
    const structuredUrl =
        new URL(NOMINATIM_URL);

    structuredUrl.searchParams.set("city", parsed.city);
    structuredUrl.searchParams.set("state", "Iowa");
    structuredUrl.searchParams.set("country", "United States");
    structuredUrl.searchParams.set("countrycodes", "us");
    structuredUrl.searchParams.set("format", "jsonv2");
    structuredUrl.searchParams.set("limit", "10");
    structuredUrl.searchParams.set("addressdetails", "1");
    structuredUrl.searchParams.set("featuretype", "settlement");


    const structuredResults =
        await fetchNominatimResults(structuredUrl);


    let selected =
        selectSettlementResult(
            structuredResults,
            requestedName
        );


    /*
     * If structured search did not produce a valid settlement,
     * make a second, broader settlement-only search. We still
     * refuse to accept counties or other administrative features.
     */
    if (!selected) {

        const fallbackUrl =
            new URL(NOMINATIM_URL);

        fallbackUrl.searchParams.set(
            "q",
            `${parsed.city}, Iowa, United States`
        );
        fallbackUrl.searchParams.set("format", "jsonv2");
        fallbackUrl.searchParams.set("limit", "10");
        fallbackUrl.searchParams.set("addressdetails", "1");
        fallbackUrl.searchParams.set("featuretype", "settlement");
        fallbackUrl.searchParams.set("countrycodes", "us");


        const fallbackResults =
            await fetchNominatimResults(fallbackUrl);


        selected =
            selectSettlementResult(
                fallbackResults,
                requestedName
            );
    }


    if (!selected) {
        throw new Error(
            `Nominatim did not return a valid Iowa settlement named "${parsed.city}". ` +
            `The search was intentionally rejected rather than using a county or other administrative boundary.`
        );
    }


    return selected;
}


/**
 * Parse a city input such as "Jefferson, IA" or "Jefferson, Iowa".
 *
 * The prototype is intentionally Iowa-specific because this study
 * workflow currently targets Iowa Department of Education data.
 *
 * @param {string} query
 * @returns {{city: string}}
 */
function parseCityInput(query) {

    const parts =
        query
            .split(",")
            .map(value => value.trim())
            .filter(Boolean);


    if (parts.length === 0) {
        throw new Error("Please enter a city name.");
    }


    return {
        city: parts[0]
    };
}


/**
 * Request and parse a Nominatim response.
 *
 * @param {URL} url
 * @returns {Promise<Array>}
 */
async function fetchNominatimResults(url) {

    const response =
        await fetch(url.toString(), {
            method: "GET",
            headers: {
                "Accept": "application/json"
            }
        });


    if (!response.ok) {
        throw new Error(
            `Geocoding request failed with HTTP ${response.status}.`
        );
    }


    const results =
        await response.json();


    return Array.isArray(results)
        ? results
        : [];
}


/**
 * Select only a true settlement matching the requested name.
 *
 * This deliberately rejects county/admin results. For a research
 * workflow, silently substituting "Jefferson County" for the city
 * "Jefferson" is worse than stopping and asking the user to correct
 * an ambiguous geocoding result.
 *
 * @param {Array} results
 * @param {string} requestedName
 * @returns {object|null}
 */
function selectSettlementResult(results, requestedName) {

    const settlements =
        results.filter(result => {

            const type =
                String(result.type || result.addresstype || "")
                    .toLowerCase();

            const resultClass =
                String(result.class || "")
                    .toLowerCase();

            const name =
                String(result.name || "")
                    .trim()
                    .toLowerCase();

            const address =
                result.address || {};

            const state =
                String(address.state || "")
                    .trim()
                    .toLowerCase();

            const countryCode =
                String(
                    address.country_code ||
                    result.address?.country_code ||
                    ""
                )
                    .trim()
                    .toLowerCase();


            const validSettlementType = [
                "city",
                "town",
                "village",
                "hamlet",
                "municipality",
                "locality"
            ].includes(type);


            const validSettlementClass =
                resultClass === "place" ||
                resultClass === "boundary" && validSettlementType;


            const iowa =
                state === "iowa" ||
                address["ISO3166-2-lvl4"] === "US-IA";


            const us =
                countryCode === "us" ||
                /united states/i.test(address.country || "");


            return (
                validSettlementType &&
                validSettlementClass &&
                iowa &&
                us &&
                name === requestedName
            );
        });


    return settlements[0] || null;
}



/* ============================================================
   GEOCODING HELPERS
   ============================================================ */

/**
 * Convert a Nominatim result into the compact location object
 * stored in the study record.
 *
 * @param {string} input
 * @param {object} result
 * @returns {object}
 */
function createLocationObject(input, result) {

    const latitude =
        Number(result.lat);

    const longitude =
        Number(result.lon);


    if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
    ) {
        throw new Error(
            `The geocoder returned invalid coordinates for "${input}".`
        );
    }


    return {
        input: input,

        name:
            result.address?.city ||
            result.address?.town ||
            result.address?.village ||
            result.address?.municipality ||
            result.address?.hamlet ||
            result.display_name,

        state:
            result.address?.state || "",

        country:
            result.address?.country || "",

        latitude: latitude,

        longitude: longitude,

        displayName:
            result.display_name,

        osmType:
            result.osm_type || "",

        osmId:
            result.osm_id || null
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
            geocoder: "Nominatim",
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
        "Geocoding the two cities...";


    const runningResult =
        showResult(
            "Creating Study Area",
            "Geocoding City 1...",
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
            "Geocoding City 2...";


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
            `Both cities were geocoded successfully. ` +
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
 * Test 3B.3 does not yet collect Overpass data. This button
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
