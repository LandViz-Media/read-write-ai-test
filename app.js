/*
 * Read / Write AI Test
 *
 * Responsibility:
 *   Controls the browser-side Study Setup interface.
 *
 * Test 3B.1:
 *   UI only.
 *
 *   No geocoding.
 *   No mapping.
 *   No Worker calls.
 *   No GitHub operations.
 */

const studyNameInput = document.getElementById("studyName");
const city1Input = document.getElementById("city1");
const city2Input = document.getElementById("city2");
const bufferDistanceInput = document.getElementById("bufferDistance");

const createStudyAreaButton = document.getElementById("createStudyAreaButton");
const saveStudyButton = document.getElementById("saveStudyButton");
const continueButton = document.getElementById("continueButton");

const mapStatus = document.getElementById("mapStatus");
const resultsContainer = document.getElementById("results");

let currentStudy = null;

function validateStudyInputs() {
    const studyName = studyNameInput.value.trim();
    const city1 = city1Input.value.trim();
    const city2 = city2Input.value.trim();
    const buffer = Number(bufferDistanceInput.value);

    if (!studyName) return false;
    if (!city1) return false;
    if (!city2) return false;
    if (Number.isNaN(buffer) || buffer < 0 || buffer > 25) return false;

    return true;
}

function updateCreateButton() {
    createStudyAreaButton.disabled = !validateStudyInputs();
}

function showResult(title, message) {
    resultsContainer.innerHTML = "";

    const result = document.createElement("div");
    result.className = "result waiting";

    const titleElement = document.createElement("div");
    titleElement.className = "result-title";
    titleElement.textContent = title;

    const messageElement = document.createElement("div");
    messageElement.className = "result-message";
    messageElement.textContent = message;

    result.appendChild(titleElement);
    result.appendChild(messageElement);
    resultsContainer.appendChild(result);
}

function createStudyArea() {
    if (!validateStudyInputs()) {
        showResult(
            "Study Setup Incomplete",
            "Please provide a study name, two cities, and a valid buffer distance."
        );
        return;
    }

    const studyName = studyNameInput.value.trim();
    const city1 = city1Input.value.trim();
    const city2 = city2Input.value.trim();
    const buffer = Number(bufferDistanceInput.value);

    currentStudy = {
        name: studyName,
        cities: [
            { input: city1 },
            { input: city2 }
        ],
        buffer: {
            distance: buffer,
            units: "miles"
        }
    };

    mapStatus.textContent =
        "Study inputs captured. Geocoding will be added in Test 3B.2.";

    showResult(
        "Study Setup Ready",
        "The interface successfully captured the study parameters. Geocoding and study-area creation will be added in the next milestone."
    );
}

studyNameInput.addEventListener("input", updateCreateButton);
city1Input.addEventListener("input", updateCreateButton);
city2Input.addEventListener("input", updateCreateButton);
bufferDistanceInput.addEventListener("input", updateCreateButton);

createStudyAreaButton.addEventListener("click", createStudyArea);

saveStudyButton.addEventListener("click", () => {
    showResult(
        "Save Study",
        "Study persistence will be implemented in a later milestone."
    );
});

continueButton.addEventListener("click", () => {
    showResult(
        "OSM Data Collection",
        "OSM data collection will be implemented in a later milestone."
    );
});

updateCreateButton();
