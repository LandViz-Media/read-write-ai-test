/*
 * Read / Write AI Test
 *
 * Responsibility:
 *   Controls the browser-side Study Setup workflow,
 *   geocoding, Leaflet map, and study-area geometry.
 *
 * Test 3B.2:
 *   - Geocode two cities with Nominatim.
 *   - Display both cities on an interactive Leaflet map.
 *   - Calculate the geographic extent of both locations.
 *   - Apply the requested buffer to that extent.
 *   - Display the resulting study area.
 *
 * Important:
 *   The buffer is applied to the combined geographic extent,
 *   NOT as a circular buffer around either city.
 *
 * No Worker calls or GitHub operations occur in this milestone.
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

const resultsContainer =
    document.getElementById("results");


/* ============================================================
   CONFIGURATION
   ============================================================ */

/*
 * Nominatim is a public geocoding service operated by the
 * OpenStreetMap Foundation.
 *
 * We identify this application with a descriptive User-Agent
 * through the browser's HTTP request headers where supported.
 *
 * No credentials are required.
 */

const NOMINATIM_URL =
    "https://nominatim.openstreetmap.org/search";


/*
 * One degree of latitude is approximately this many miles.
 *
 * Longitude varies with latitude, so longitude buffering is
 * calculated using the latitude of the study area's center.
 */

const MILES_PER_DEGREE_LATITUDE =
    69.0;


/* ============================================================
   MAP STATE
   ============================================================ */

let map = null;

let cityMarkers = [];

let studyAreaLayer = null;

let currentStudy = null;


/* ============================================================
   MAP INITIALIZATION
   ============================================================ */

/**
 * Initialize the Leaflet map.
 *
 * The initial view is centered approximately on Iowa.
 */
function initializeMap() {

    map = L.map("map", {
        zoomControl: true
    }).setView(
        [42.0, -93.5],
        7
    );


    /*
     * OpenStreetMap tiles are public map tiles.
     *
     * Attribution is required by the tile provider.
     */

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,

            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }
    ).addTo(map);
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


    if (!studyName) {
        return false;
    }


    if (!city1) {
        return false;
    }


    if (!city2) {
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
 * @param {string} query
 * @returns {Promise<object>}
 */
async function geocodeCity(query) {

    const url =
        new URL(NOMINATIM_URL);


    url.searchParams.set(
        "q",
        query
    );


    url.searchParams.set(
        "format",
        "jsonv2"
    );


    url.searchParams.set(
        "limit",
        "5"
    );


    url.searchParams.set(
        "addressdetails",
        "1"
    );


    const response =
        await fetch(url.toString(), {
            method: "GET",
            headers: {
                "Accept":
                    "application/json"
            }
        });


    if (!response.ok) {

        throw new Error(
            `Geocoding request failed with HTTP ${response.status}.`
        );
    }


    const results =
        await response.json();


    if (
        !Array.isArray(results) ||
        results.length === 0
    ) {

        throw new Error(
            `No location could be found for "${query}".`
        );
    }


    /*
     * Prefer an Iowa result when the user's query includes
     * Iowa or when Nominatim returns one among the candidates.
     */

    const iowaResult =
        results.find(result => {

            const address =
                result.address || {};

            return (
                address.state === "Iowa" ||
                address["ISO3166-2-lvl4"] === "US-IA"
            );

        });


    return iowaResult || results[0];
}


/* ============================================================
   GEOCODING HELPERS
   ============================================================ */

/**
 * Convert a Nominatim result into the compact location
 * object used by the application.
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


    return {

        input: input,

        name:
            result.address?.city ||
            result.address?.town ||
            result.address?.village ||
            result.address?.municipality ||
            result.display_name,

        state:
            result.address?.state ||
            "",

        country:
            result.address?.country ||
            "",

        latitude: latitude,

        longitude: longitude,

        displayName:
            result.display_name

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

    return (
        miles /
        MILES_PER_DEGREE_LATITUDE
    );
}


/**
 * Convert miles to degrees of longitude at a given latitude.
 *
 * @param {number} miles
 * @param {number} latitude
 * @returns {number}
 */
function milesToLongitudeDegrees(
    miles,
    latitude
) {

    const radians =
        latitude *
        Math.PI /
        180;


    const milesPerDegreeLongitude =
        MILES_PER_DEGREE_LATITUDE *
        Math.cos(radians);


    return (
        miles /
        milesPerDegreeLongitude
    );
}


/**
 * Create the buffered geographic extent containing
 * both city locations.
 *
 * The buffer expands all four sides of the combined
 * geographic extent.
 *
 * @param {object} city1
 * @param {object} city2
 * @param {number} bufferMiles
 * @returns {object}
 */
function calculateStudyExtent(
    city1,
    city2,
    bufferMiles
) {

    const minLatitude =
        Math.min(
            city1.latitude,
            city2.latitude
        );


    const maxLatitude =
        Math.max(
            city1.latitude,
            city2.latitude
        );


    const minLongitude =
        Math.min(
            city1.longitude,
            city2.longitude
        );


    const maxLongitude =
        Math.max(
            city1.longitude,
            city2.longitude
        );


    /*
     * Use the center latitude to calculate the longitude
     * distance represented by one degree.
     */

    const centerLatitude =
        (
            minLatitude +
            maxLatitude
        ) / 2;


    const latitudeBuffer =
        milesToLatitudeDegrees(
            bufferMiles
        );


    const longitudeBuffer =
        milesToLongitudeDegrees(
            bufferMiles,
            centerLatitude
        );


    return {

        minLatitude:
            minLatitude -
            latitudeBuffer,

        maxLatitude:
            maxLatitude +
            latitudeBuffer,

        minLongitude:
            minLongitude -
            longitudeBuffer,

        maxLongitude:
            maxLongitude +
            longitudeBuffer

    };
}


/**
 * Create a Leaflet LatLngBounds object from an extent.
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

        map.removeLayer(
            studyAreaLayer
        );

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
function displayStudyArea(
    city1,
    city2,
    extent
) {

    clearCityMarkers();

    clearStudyArea();


    /*
     * City markers
     */

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


    cityMarkers.push(marker1);
    cityMarkers.push(marker2);


    /*
     * Study area.
     *
     * This is intentionally a rectangle representing the
     * buffered geographic extent.
     */

    const bounds =
        extentToLeafletBounds(
            extent
        );


    studyAreaLayer =
        L.rectangle(
            bounds,
            {
                weight: 2,
                fillOpacity: 0.12
            }
        )
        .addTo(map);


    /*
     * Fit the map to the resulting study area.
     */

    map.fitBounds(
        bounds,
        {
            padding: [30, 30]
        }
    );


    /*
     * Add a popup explaining what the rectangle represents.
     */

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
        (
            extent.minLatitude +
            extent.maxLatitude
        ) / 2;


    const latitudeMiles =
        (
            extent.maxLatitude -
            extent.minLatitude
        ) *
        MILES_PER_DEGREE_LATITUDE;


    const longitudeMiles =
        (
            extent.maxLongitude -
            extent.minLongitude
        ) *
        MILES_PER_DEGREE_LATITUDE *
        Math.cos(
            centerLatitude *
            Math.PI /
            180
        );


    return {

        widthMiles:
            longitudeMiles,

        heightMiles:
            latitudeMiles

    };
}


/**
 * Update the location detail cards.
 *
 * @param {object} city1
 * @param {object} city2
 * @param {object} extent
 */
function updateLocationDetails(
    city1,
    city2,
    extent
) {

    city1Resolved.textContent =
        city1.displayName;


    city2Resolved.textContent =
        city2.displayName;


    const dimensions =
        calculateDimensions(
            extent
        );


    studyAreaDimensions.textContent =
        `${dimensions.widthMiles.toFixed(1)} × ` +
        `${dimensions.heightMiles.toFixed(1)} miles`;


    locationDetails.hidden =
        false;
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
        Number(
            bufferDistanceInput.value
        );


    /*
     * Disable the button while the geocoding requests run.
     */

    createStudyAreaButton.disabled =
        true;


    saveStudyButton.disabled =
        true;

    continueButton.disabled =
        true;


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
         * Nominatim asks clients to avoid sending many
         * simultaneous requests. We therefore geocode the
         * cities sequentially.
         */

        const city1Result =
            await geocodeCity(
                city1InputValue
            );


        runningResult
            .querySelector(".result-message")
            .textContent =
            "Geocoding City 2...";


        const city2Result =
            await geocodeCity(
                city2InputValue
            );


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


        /*
         * Calculate the buffered combined geographic extent.
         */

        const extent =
            calculateStudyExtent(
                city1,
                city2,
                buffer
            );


        /*
         * Store the preliminary study in browser memory.
         */

        currentStudy = {

            name: studyName,

            cities: [
                city1,
                city2
            ],

            buffer: {
                distance: buffer,
                units: "miles"
            },

            studyArea: {
                method:
                    "city-extent-buffer",

                extent: extent
            }

        };


        /*
         * Display the results.
         */

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


        mapStatus.textContent =
            "Study area created. Review the map before continuing.";


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
            `The combined extent was buffered by ${buffer.toFixed(1)} miles on all four sides.`;


        /*
         * The study area now exists and can be reviewed.
         *
         * Save is still disabled because persistence belongs
         * to Test 3B.3.
         *
         * Continue is also still disabled until the study is
         * saved and later workflow logic is implemented.
         */

    } catch (error) {

        currentStudy =
            null;


        clearCityMarkers();

        clearStudyArea();


        locationDetails.hidden =
            true;


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
   INPUT EVENTS
   ============================================================ */

studyNameInput.addEventListener(
    "input",
    updateCreateButton
);


city1Input.addEventListener(
    "input",
    updateCreateButton
);


city2Input.addEventListener(
    "input",
    updateCreateButton
);


bufferDistanceInput.addEventListener(
    "input",
    updateCreateButton
);


/* ============================================================
   EVENT HANDLERS
   ============================================================ */

createStudyAreaButton.addEventListener(
    "click",
    createStudyArea
);


/*
 * Save and Continue remain disabled in Test 3B.2.
 *
 * Persistence will be implemented in Test 3B.3.
 */

saveStudyButton.addEventListener(
    "click",
    () => {

        showResult(
            "Save Study",
            "Study persistence will be implemented in Test 3B.3.",
            "waiting"
        );

    }
);


continueButton.addEventListener(
    "click",
    () => {

        showResult(
            "OSM Data Collection",
            "OSM data collection will be implemented after study persistence.",
            "waiting"
        );

    }
);


/* ============================================================
   INITIALIZATION
   ============================================================ */

initializeMap();

updateCreateButton();
