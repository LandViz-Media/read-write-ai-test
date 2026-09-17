/*
 * Read / Write AI Test
 *
 * Responsibility:
 *   Provides the browser-side interface for testing communication
 *   with the Cloudflare Worker and the GitHub App.
 *
 * Security:
 *   No GitHub credentials, PATs, App private keys, or installation
 *   tokens are stored or transmitted by this browser application.
 */


/* ============================================================
   CONFIGURATION
   ============================================================ */

const API_URL =
    "https://read-write-ai-test-api.cjseeger.workers.dev";


/* ============================================================
   DOM REFERENCES
   ============================================================ */

const healthButton =
    document.getElementById("healthButton");

const authButton =
    document.getElementById("authButton");

const writeButton =
    document.getElementById("writeButton");

const resultsContainer =
    document.getElementById("results");


/* ============================================================
   RESULT DISPLAY
   ============================================================ */

/**
 * Add a result message to the results panel.
 *
 * @param {string} title
 * @param {string} message
 * @param {"pass"|"fail"|"waiting"|"running"} status
 * @param {object|null} data
 */
function addResult(title, message, status = "waiting", data = null) {

    const result = document.createElement("div");

    result.className = `result ${status}`;

    const titleElement =
        document.createElement("div");

    titleElement.className = "result-title";

    titleElement.textContent = title;


    const messageElement =
        document.createElement("div");

    messageElement.className = "result-message";

    messageElement.textContent = message;


    result.appendChild(titleElement);
    result.appendChild(messageElement);


    if (data !== null) {

        const pre =
            document.createElement("pre");

        pre.textContent =
            JSON.stringify(data, null, 2);

        result.appendChild(pre);
    }


    resultsContainer.prepend(result);

    return result;
}


/**
 * Remove the default waiting message.
 */
function clearInitialResult() {

    const waitingResults =
        resultsContainer.querySelectorAll(".waiting");

    waitingResults.forEach(result => {

        if (
            result.textContent.includes(
                "Waiting for tests"
            )
        ) {
            result.remove();
        }

    });
}


/* ============================================================
   API REQUEST
   ============================================================ */

/**
 * Send a request to the Cloudflare Worker.
 *
 * @param {string} path
 * @param {string} method
 * @returns {Promise<object>}
 */
async function callWorker(path, method = "GET") {

    const response =
        await fetch(`${API_URL}${path}`, {
            method: method,
            headers: {
                "Accept": "application/json"
            }
        });


    let data;

    try {

        data = await response.json();

    } catch (error) {

        throw new Error(
            `Worker returned HTTP ${response.status}, ` +
            "but the response was not valid JSON."
        );
    }


    if (!response.ok) {

        const message =
            data.message ||
            data.error ||
            `HTTP ${response.status}`;

        throw new Error(message);
    }


    return data;
}


/* ============================================================
   TEST: WORKER HEALTH
   ============================================================ */

/**
 * Test that the browser can communicate with
 * the Cloudflare Worker.
 */
async function testWorkerHealth() {

    clearInitialResult();

    const result =
        addResult(
            "Worker Test",
            "Testing Cloudflare Worker...",
            "running"
        );


    try {

        const data =
            await callWorker("/health");


        result.className =
            "result pass";


        result.querySelector(".result-title")
            .textContent =
            "✓ Worker Test Passed";


        result.querySelector(".result-message")
            .textContent =
            "The browser successfully communicated with the Cloudflare Worker.";


        const pre =
            document.createElement("pre");

        pre.textContent =
            JSON.stringify(data, null, 2);

        result.appendChild(pre);


    } catch (error) {

        result.className =
            "result fail";


        result.querySelector(".result-title")
            .textContent =
            "Worker Test Failed";


        result.querySelector(".result-message")
            .textContent =
            error.message;
    }
}


/* ============================================================
   TEST: GITHUB AUTHENTICATION
   ============================================================ */

/**
 * Test GitHub App authentication and repository access.
 *
 * The installation token is generated and used entirely
 * by the Cloudflare Worker.
 */
async function testGitHubAuthentication() {

    clearInitialResult();

    const result =
        addResult(
            "GitHub Authentication",
            "Testing GitHub App authentication and repository access...",
            "running"
        );


    try {

        const data =
            await callWorker("/github/status");


        if (!data.ok) {

            throw new Error(
                data.message ||
                "GitHub authentication test failed."
            );
        }


        result.className =
            "result pass";


        result.querySelector(".result-title")
            .textContent =
            "✓ GitHub Authentication Passed";


        result.querySelector(".result-message")
            .textContent =
            "The GitHub App authenticated successfully and can access the private repository.";


        const pre =
            document.createElement("pre");

        pre.textContent =
            JSON.stringify(data, null, 2);

        result.appendChild(pre);


    } catch (error) {

        result.className =
            "result fail";


        result.querySelector(".result-title")
            .textContent =
            "GitHub Authentication Failed";


        result.querySelector(".result-message")
            .textContent =
            error.message;
    }
}


/* ============================================================
   TEST: GITHUB WRITE
   ============================================================ */

/**
 * Test writing data to the private GitHub repository.
 *
 * The Worker performs the actual GitHub API operation.
 */
async function testGitHubWrite() {

    clearInitialResult();

    const result =
        addResult(
            "GitHub Write Test",
            "Writing test data to the private repository...",
            "running"
        );


    try {

        const data =
            await callWorker(
                "/github/test",
                "POST"
            );


        if (!data.ok) {

            throw new Error(
                data.message ||
                "GitHub write test failed."
            );
        }


        result.className =
            "result pass";


        result.querySelector(".result-title")
            .textContent =
            "✓ GitHub Write Test Passed";


        result.querySelector(".result-message")
            .textContent =
            "The Worker successfully authenticated with the GitHub App, wrote a file, and read it back from the private repository.";


        const pre =
            document.createElement("pre");

        pre.textContent =
            JSON.stringify(data, null, 2);

        result.appendChild(pre);


    } catch (error) {

        result.className =
            "result fail";


        result.querySelector(".result-title")
            .textContent =
            "GitHub Write Test Failed";


        result.querySelector(".result-message")
            .textContent =
            error.message;
    }
}


/* ============================================================
   BUTTON STATE
   ============================================================ */

/**
 * Temporarily disable all test buttons while a test runs.
 *
 * @param {boolean} disabled
 */
function setButtonsDisabled(disabled) {

    healthButton.disabled =
        disabled;

    authButton.disabled =
        disabled;

    writeButton.disabled =
        disabled;
}


/* ============================================================
   EVENT HANDLERS
   ============================================================ */

healthButton.addEventListener(
    "click",
    async () => {

        setButtonsDisabled(true);

        try {
            await testWorkerHealth();
        } finally {
            setButtonsDisabled(false);
        }

    }
);


authButton.addEventListener(
    "click",
    async () => {

        setButtonsDisabled(true);

        try {
            await testGitHubAuthentication();
        } finally {
            setButtonsDisabled(false);
        }

    }
);


writeButton.addEventListener(
    "click",
    async () => {

        setButtonsDisabled(true);

        try {
            await testGitHubWrite();
        } finally {
            setButtonsDisabled(false);
        }

    }
);
