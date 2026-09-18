/*
 * Read / Write AI Test — Cloudflare Worker
 *
 * Responsibility:
 *   Provides the server-side application API for Test 3B.3.5.
 *
 *   The browser sends a validated study record and its GeoJSON study-area
 *   artifact to POST /api/v1/studies. This Worker:
 *     1. authenticates to GitHub as the installed GitHub App;
 *     2. reads the existing studies.json record;
 *     3. creates/updates both files in one Git commit;
 *     4. advances the main branch only if it has not changed underneath us;
 *     5. returns the commit and persisted file paths to the browser.
 *
 * Security:
 *   - The GitHub App private key exists only as a Cloudflare secret.
 *   - The browser never receives an installation token or private key.
 *   - CORS is restricted to the GitHub Pages application origin.
 *   - Client-supplied repository paths are never trusted.
 *
 * Required Cloudflare secret:
 *   GITHUB_APP_PRIVATE_KEY = full PEM private key for the GitHub App.
 *
 * Existing configuration can continue to use GITHUB_APP_ID as a secret.
 * Public/non-secret defaults below match Test 3A configuration.
 */

"use strict";

const CONFIG = {
    owner: "LandViz-Media",
    repo: "read-write-ai-test",
    branch: "main",
    appId: "4970537",
    installationId: "162348099",
    allowedOrigin: "https://landviz-media.github.io",
    apiVersion: "2026-03-10",
    studiesPath: "data/studies.json",
    studyAreaDirectory: "data/studyAreas",
    appName: "read-write-ai-test-api",
    maxBodyBytes: 1024 * 1024,
    maxStudyNameLength: 200,
    maxCityInputLength: 160,
    maxStudyCount: 5000,
    maxConflictRetries: 2
};

const JSON_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
};

/* ============================================================
   RESPONSE / CORS
   ============================================================ */

function corsHeaders(origin, allowedOrigin = CONFIG.allowedOrigin) {
    const headers = {
        ...JSON_HEADERS,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, Cache-Control",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
    };

    if (origin === allowedOrigin) {
        headers["Access-Control-Allow-Origin"] = origin;
    }

    return headers;
}

function jsonResponse(body, status, origin, allowedOrigin = CONFIG.allowedOrigin) {
    return new Response(JSON.stringify(body), {
        status,
        headers: corsHeaders(origin, allowedOrigin)
    });
}

function errorResponse(message, status, origin, details = undefined, allowedOrigin = CONFIG.allowedOrigin) {
    const body = { ok: false, error: message };

    if (details !== undefined) {
        body.details = details;
    }

    return jsonResponse(body, status, origin, allowedOrigin);
}

/* ============================================================
   GENERIC HELPERS
   ============================================================ */

function getConfiguration(env) {
    return {
        ...CONFIG,
        appId: String(env.GITHUB_APP_ID || CONFIG.appId),
        installationId: String(
            env.GITHUB_APP_INSTALLATION_ID || CONFIG.installationId
        ),
        allowedOrigin:
            String(env.ALLOWED_ORIGIN || CONFIG.allowedOrigin),
        owner: String(env.GITHUB_OWNER || CONFIG.owner),
        repo: String(env.GITHUB_REPO || CONFIG.repo),
        branch: String(env.GITHUB_BRANCH || CONFIG.branch)
    };
}

function base64UrlEncode(bytes) {
    let binary = "";

    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function textToBase64Url(value) {
    return base64UrlEncode(new TextEncoder().encode(value));
}

function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

function base64ToUtf8(value) {
    return new TextDecoder().decode(base64ToBytes(value));
}

function encodeDerLength(length) {
    if (length < 0x80) {
        return new Uint8Array([length]);
    }

    const bytes = [];
    let value = length;

    while (value > 0) {
        bytes.unshift(value & 0xff);
        value >>>= 8;
    }

    return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...arrays) {
    const total = arrays.reduce((sum, array) => sum + array.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;

    arrays.forEach(array => {
        result.set(array, offset);
        offset += array.length;
    });

    return result;
}

function wrapPkcs1InPkcs8(pkcs1Bytes) {
    /*
     * GitHub-generated App private keys are PKCS#1 RSAPrivateKey files.
     * WebCrypto importKey() expects PKCS#8 for an RSA private key.
     * Wrap the PKCS#1 DER bytes in the standard PKCS#8 PrivateKeyInfo shell.
     *
     * PKCS#8:
     *   SEQUENCE {
     *     version INTEGER 0,
     *     algorithmIdentifier SEQUENCE { rsaEncryption OID, NULL },
     *     privateKey OCTET STRING <PKCS#1 bytes>
     *   }
     */
    const version = new Uint8Array([0x02, 0x01, 0x00]);

    const algorithmBody = new Uint8Array([
        0x06, 0x09,
        0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
        0x05, 0x00
    ]);

    const algorithmIdentifier = concatBytes(
        new Uint8Array([0x30]),
        encodeDerLength(algorithmBody.length),
        algorithmBody
    );

    const privateKeyOctetString = concatBytes(
        new Uint8Array([0x04]),
        encodeDerLength(pkcs1Bytes.length),
        pkcs1Bytes
    );

    const body = concatBytes(
        version,
        algorithmIdentifier,
        privateKeyOctetString
    );

    return concatBytes(
        new Uint8Array([0x30]),
        encodeDerLength(body.length),
        body
    );
}

function pemToBytes(pem) {
    const text = String(pem || "").trim();

    if (!text) {
        throw new Error("GitHub App private key is empty.");
    }

    const isPkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(text);
    const isPkcs8 = /-----BEGIN PRIVATE KEY-----/.test(text);

    if (!isPkcs1 && !isPkcs8) {
        throw new Error(
            "GitHub App private key is not a recognized PEM private-key format."
        );
    }

    const body = text
        .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
        .replace(/-----END RSA PRIVATE KEY-----/g, "")
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\s/g, "");

    if (!body) {
        throw new Error("GitHub App private key contains no encoded key data.");
    }

    const decoded = base64ToBytes(body);

    return isPkcs1
        ? wrapPkcs1InPkcs8(decoded)
        : decoded;
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function githubHeaders(token) {
    return {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": CONFIG.apiVersion,
        "User-Agent": CONFIG.appName,
        "Content-Type": "application/json"
    };
}

async function readResponseBody(response) {
    const text = await response.text();

    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

async function githubRequest(path, options, token) {
    const response = await fetch(`https://api.github.com${path}`, {
        ...options,
        headers: {
            ...githubHeaders(token),
            ...(options?.headers || {})
        }
    });

    const body = await readResponseBody(response);

    if (!response.ok) {
        const message =
            body?.message ||
            body?.error ||
            `GitHub API returned HTTP ${response.status}.`;

        const error = new Error(message);
        error.status = response.status;
        error.github = body;
        throw error;
    }

    return body;
}

/* ============================================================
   GITHUB APP AUTHENTICATION
   ============================================================ */

async function createAppJwt(appId, privateKeyPem) {
    const keyBytes = pemToBytes(privateKeyPem);

    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        keyBytes.buffer,
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256"
        },
        false,
        ["sign"]
    );

    const header = {
        alg: "RS256",
        typ: "JWT"
    };

    const issuedAt = nowSeconds() - 60;
    const payload = {
        iat: issuedAt,
        exp: issuedAt + 9 * 60,
        iss: String(appId)
    };

    const encodedHeader = textToBase64Url(JSON.stringify(header));
    const encodedPayload = textToBase64Url(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    const signature = await crypto.subtle.sign(
        {
            name: "RSASSA-PKCS1-v1_5"
        },
        privateKey,
        new TextEncoder().encode(unsignedToken)
    );

    return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function createInstallationToken(env, config) {
    const privateKey = env.GITHUB_APP_PRIVATE_KEY;

    if (!privateKey) {
        throw new Error(
            "Cloudflare secret GITHUB_APP_PRIVATE_KEY is not configured."
        );
    }

    const jwt = await createAppJwt(config.appId, privateKey);

    const response = await fetch(
        `https://api.github.com/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
        {
            method: "POST",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${jwt}`,
                "X-GitHub-Api-Version": config.apiVersion,
                "User-Agent": config.appName,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                repositories: [config.repo],
                permissions: {
                    contents: "write"
                }
            })
        }
    );

    const body = await readResponseBody(response);

    if (!response.ok || !body?.token) {
        const message =
            body?.message ||
            `GitHub installation-token request failed with HTTP ${response.status}.`;

        throw new Error(message);
    }

    return {
        token: body.token,
        expiresAt: body.expires_at || null,
        permissions: body.permissions || null
    };
}

/* ============================================================
   REQUEST VALIDATION
   ============================================================ */

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertString(value, field, maxLength) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${field} is required.`);
    }

    if (value.length > maxLength) {
        throw new Error(`${field} exceeds the maximum length of ${maxLength}.`);
    }
}

function assertFiniteNumber(value, field, min, max) {
    if (!Number.isFinite(Number(value))) {
        throw new Error(`${field} must be a number.`);
    }

    const number = Number(value);

    if (number < min || number > max) {
        throw new Error(`${field} must be between ${min} and ${max}.`);
    }

    return number;
}

function isSafeStudyId(id) {
    return /^study-[0-9]{8}-[0-9]{6}-[a-z0-9-]{8,64}$/i.test(String(id || ""));
}

function validateStudy(study) {
    if (!isPlainObject(study)) {
        throw new Error("study must be an object.");
    }

    if (!isSafeStudyId(study.id)) {
        throw new Error("study.id has an invalid format.");
    }

    assertString(study.name, "study.name", CONFIG.maxStudyNameLength);

    if (study.application !== "osm-scout") {
        throw new Error("study.application must be 'osm-scout'.");
    }

    if (!Array.isArray(study.cities) || study.cities.length !== 2) {
        throw new Error("study.cities must contain exactly two cities.");
    }

    study.cities.forEach((city, index) => {
        if (!isPlainObject(city)) {
            throw new Error(`study.cities[${index}] must be an object.`);
        }

        assertString(city.input, `study.cities[${index}].input`, CONFIG.maxCityInputLength);
        assertString(city.name, `study.cities[${index}].name`, CONFIG.maxCityInputLength);
        assertString(city.state, `study.cities[${index}].state`, CONFIG.maxCityInputLength);
        assertString(city.stateAbbr, `study.cities[${index}].stateAbbr`, 2);

        const lat = assertFiniteNumber(
            city.latitude,
            `study.cities[${index}].latitude`,
            -90,
            90
        );

        const lon = assertFiniteNumber(
            city.longitude,
            `study.cities[${index}].longitude`,
            -180,
            180
        );

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            throw new Error(`study.cities[${index}] has invalid coordinates.`);
        }
    });

    if (!isPlainObject(study.buffer)) {
        throw new Error("study.buffer is required.");
    }

    if (study.buffer.units !== "miles") {
        throw new Error("study.buffer.units must be 'miles'.");
    }

    assertFiniteNumber(
        study.buffer.distance,
        "study.buffer.distance",
        0,
        25
    );

    if (!isPlainObject(study.studyArea)) {
        throw new Error("study.studyArea is required.");
    }

    if (study.studyArea.method !== "city-extent-buffer") {
        throw new Error("study.studyArea.method is not supported by Test 3B.3.5.");
    }

    if (!isPlainObject(study.studyArea.extent)) {
        throw new Error("study.studyArea.extent is required.");
    }

    const extent = study.studyArea.extent;
    assertFiniteNumber(extent.minLatitude, "studyArea.extent.minLatitude", -90, 90);
    assertFiniteNumber(extent.maxLatitude, "studyArea.extent.maxLatitude", -90, 90);
    assertFiniteNumber(extent.minLongitude, "studyArea.extent.minLongitude", -180, 180);
    assertFiniteNumber(extent.maxLongitude, "studyArea.extent.maxLongitude", -180, 180);

    if (extent.minLatitude >= extent.maxLatitude) {
        throw new Error("studyArea latitude extent is invalid.");
    }

    if (extent.minLongitude >= extent.maxLongitude) {
        throw new Error("studyArea longitude extent is invalid.");
    }
}

function validateStudyAreaGeoJSON(study, studyArea) {
    if (!isPlainObject(studyArea)) {
        throw new Error("studyArea must be a GeoJSON object.");
    }

    if (studyArea.type !== "FeatureCollection") {
        throw new Error("studyArea GeoJSON must be a FeatureCollection.");
    }

    if (!Array.isArray(studyArea.features) || studyArea.features.length !== 1) {
        throw new Error("studyArea GeoJSON must contain exactly one feature.");
    }

    const feature = studyArea.features[0];

    if (!isPlainObject(feature) || feature.type !== "Feature") {
        throw new Error("studyArea GeoJSON contains an invalid feature.");
    }

    if (feature.geometry?.type !== "Polygon") {
        throw new Error("studyArea geometry must be a Polygon.");
    }

    const coordinates = feature.geometry.coordinates;

    if (!Array.isArray(coordinates) || coordinates.length !== 1) {
        throw new Error("studyArea Polygon must contain one outer ring.");
    }

    if (!Array.isArray(coordinates[0]) || coordinates[0].length < 5) {
        throw new Error("studyArea Polygon outer ring is invalid.");
    }

    if (feature.properties?.studyId !== study.id) {
        throw new Error("studyArea.properties.studyId does not match study.id.");
    }

    const expectedPathId = study.id;
    if (!isSafeStudyId(expectedPathId)) {
        throw new Error("Study ID cannot be used as a repository path.");
    }
}

function validatePayload(payload) {
    if (!isPlainObject(payload)) {
        throw new Error("Request body must be a JSON object.");
    }

    validateStudy(payload.study);
    validateStudyAreaGeoJSON(payload.study, payload.studyArea);
}

/* ============================================================
   STUDIES.JSON
   ============================================================ */

function parseStudiesFile(text) {
    if (!text.trim()) {
        return [];
    }

    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
        return parsed;
    }

    if (isPlainObject(parsed) && Array.isArray(parsed.studies)) {
        return parsed.studies;
    }

    throw new Error(
        "data/studies.json must contain either an array or an object with a studies array."
    );
}

function prepareStudiesDocument(existingText, study) {
    const studies = parseStudiesFile(existingText);

    const index = studies.findIndex(item => item?.id === study.id);

    if (index >= 0) {
        studies[index] = study;
    } else {
        studies.push(study);
    }

    if (studies.length > CONFIG.maxStudyCount) {
        throw new Error(
            `data/studies.json exceeds the configured study limit of ${CONFIG.maxStudyCount}.`
        );
    }

    return JSON.stringify(studies, null, 2) + "\n";
}

async function readStudiesFile(token, config) {
    const path = encodeURIComponent(config.studiesPath)
        .replace(/%2F/g, "/");

    try {
        const body = await githubRequest(
            `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path}?ref=${encodeURIComponent(config.branch)}`,
            { method: "GET" },
            token
        );

        if (!body?.content) {
            throw new Error("GitHub returned no content for studies.json.");
        }

        return {
            exists: true,
            sha: body.sha,
            text: base64ToUtf8(body.content)
        };
    } catch (error) {
        if (error.status === 404) {
            return {
                exists: false,
                sha: null,
                text: "[]\n"
            };
        }

        throw error;
    }
}

/* ============================================================
   ATOMIC TWO-FILE COMMIT
   ============================================================

   GitHub's Git database API lets us create the two blobs, construct one
   tree, create one commit, and then move the branch reference. The result is
   a single commit containing both files, rather than two independent file
   commits. GitHub documents the tree/commit/ref flow for this use case.
*/

async function getBranchHead(token, config) {
    return githubRequest(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/ref/heads/${encodeURIComponent(config.branch)}`,
        { method: "GET" },
        token
    );
}

async function getCommit(token, config, commitSha) {
    return githubRequest(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/commits/${encodeURIComponent(commitSha)}`,
        { method: "GET" },
        token
    );
}

async function createBlob(token, config, text) {
    return githubRequest(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/blobs`,
        {
            method: "POST",
            body: JSON.stringify({
                content: bytesToBase64(new TextEncoder().encode(text)),
                encoding: "base64"
            })
        },
        token
    );
}

async function createTree(token, config, baseTreeSha, entries) {
    return githubRequest(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/trees`,
        {
            method: "POST",
            body: JSON.stringify({
                base_tree: baseTreeSha,
                tree: entries
            })
        },
        token
    );
}

async function createCommit(token, config, treeSha, parentSha, study) {
    return githubRequest(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/commits`,
        {
            method: "POST",
            body: JSON.stringify({
                message: `Save study ${study.id}`,
                tree: treeSha,
                parents: [parentSha]
            })
        },
        token
    );
}

async function updateBranch(token, config, expectedHeadSha, newCommitSha) {
    const ref = `heads/${config.branch}`;

    const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/refs/heads/${encodeURIComponent(config.branch)}`,
        {
            method: "PATCH",
            headers: githubHeaders(token),
            body: JSON.stringify({
                sha: newCommitSha,
                force: false
            })
        }
    );

    const body = await readResponseBody(response);

    if (!response.ok) {
        const error = new Error(
            body?.message ||
            `GitHub branch update failed with HTTP ${response.status}.`
        );

        error.status = response.status;
        error.github = body;
        error.expectedHeadSha = expectedHeadSha;
        throw error;
    }

    return body;
}

async function persistStudyOnce(token, config, study, studyArea) {
    const branchHead = await getBranchHead(token, config);
    const parentSha = branchHead?.object?.sha;

    if (!parentSha) {
        throw new Error("GitHub did not return the current main-branch commit SHA.");
    }

    const currentCommit = await getCommit(token, config, parentSha);
    const baseTreeSha = currentCommit?.tree?.sha;

    if (!baseTreeSha) {
        throw new Error("GitHub did not return the current commit tree SHA.");
    }

    const studiesFile = await readStudiesFile(token, config);
    const nextStudiesText = prepareStudiesDocument(studiesFile.text, study);
    const studyAreaText = JSON.stringify(studyArea, null, 2) + "\n";

    const studiesBlob = await createBlob(token, config, nextStudiesText);
    const studyAreaBlob = await createBlob(token, config, studyAreaText);

    if (!studiesBlob?.sha || !studyAreaBlob?.sha) {
        throw new Error("GitHub did not return blob SHAs for the study files.");
    }

    const studyAreaPath =
        `${config.studyAreaDirectory}/${study.id}.geojson`;

    const tree = await createTree(token, config, baseTreeSha, [
        {
            path: config.studiesPath,
            mode: "100644",
            type: "blob",
            sha: studiesBlob.sha
        },
        {
            path: studyAreaPath,
            mode: "100644",
            type: "blob",
            sha: studyAreaBlob.sha
        }
    ]);

    if (!tree?.sha) {
        throw new Error("GitHub did not return a tree SHA for the study save.");
    }

    const commit = await createCommit(
        token,
        config,
        tree.sha,
        parentSha,
        study
    );

    if (!commit?.sha) {
        throw new Error("GitHub did not return a commit SHA for the study save.");
    }

    await updateBranch(token, config, parentSha, commit.sha);

    return {
        commitSha: commit.sha,
        parentSha,
        treeSha: tree.sha,
        studiesSha: studiesBlob.sha,
        studyAreaSha: studyAreaBlob.sha,
        files: {
            studies: config.studiesPath,
            studyArea: studyAreaPath
        },
        branch: config.branch,
        repository: `${config.owner}/${config.repo}`,
        commitUrl:
            `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/commit/${encodeURIComponent(commit.sha)}`,
        savedAt: new Date().toISOString()
    };
}

async function persistStudy(env, config, study, studyArea) {
    const installation = await createInstallationToken(env, config);

    let lastError = null;

    for (let attempt = 0; attempt <= config.maxConflictRetries; attempt += 1) {
        try {
            return await persistStudyOnce(
                installation.token,
                config,
                study,
                studyArea
            );
        } catch (error) {
            lastError = error;

            /*
             * A concurrent main-branch update is safe to retry because the
             * next attempt rereads the latest head and current studies.json.
             */
            if (error.status !== 409 && error.status !== 422) {
                throw error;
            }
        }
    }

    throw new Error(
        `The study could not be committed after ${config.maxConflictRetries + 1} attempts: ` +
        (lastError?.message || "GitHub reported a branch conflict.")
    );
}

/* ============================================================
   GITHUB TEST / STATUS
   ============================================================ */

async function getRepository(token, config) {
    return githubRequest(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`,
        { method: "GET" },
        token
    );
}

async function runGithubStatus(env, config) {
    const installation = await createInstallationToken(env, config);
    const repository = await getRepository(installation.token, config);

    return {
        ok: true,
        app: {
            id: Number(config.appId),
            authenticated: true
        },
        installation: {
            found: true,
            id: Number(config.installationId),
            authenticated: true,
            account: repository?.owner?.login || config.owner
        },
        repository: {
            owner: config.owner,
            name: config.repo,
            accessible: true,
            private: Boolean(repository?.private),
            defaultBranch: repository?.default_branch || config.branch
        },
        message: "GitHub App authentication and repository access verified."
    };
}

async function runGithubTest(env, config) {
    const installation = await createInstallationToken(env, config);
    const repository = await getRepository(installation.token, config);
    const testPath = "data/github-app-test.json";
    const testData = {
        test: "GitHub App authentication successful",
        timestamp: new Date().toISOString(),
        github: {
            appId: Number(config.appId),
            installationId: Number(config.installationId),
            owner: config.owner,
            repository: config.repo,
            branch: config.branch
        }
    };

    const existingPath = encodeURIComponent(testPath).replace(/%2F/g, "/");
    let sha = undefined;

    try {
        const existing = await githubRequest(
            `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${existingPath}?ref=${encodeURIComponent(config.branch)}`,
            { method: "GET" },
            installation.token
        );
        sha = existing?.sha;
    } catch (error) {
        if (error.status !== 404) {
            throw error;
        }
    }

    const putBody = {
        message: "Test GitHub App authentication and private repository access",
        content: bytesToBase64(
            new TextEncoder().encode(JSON.stringify(testData, null, 2) + "\n")
        ),
        branch: config.branch
    };

    if (sha) {
        putBody.sha = sha;
    }

    const saved = await githubRequest(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${existingPath}`,
        {
            method: "PUT",
            body: JSON.stringify(putBody)
        },
        installation.token
    );

    return {
        ok: true,
        repository: {
            owner: config.owner,
            name: config.repo,
            private: Boolean(repository?.private)
        },
        write: {
            path: testPath,
            commitSha: saved?.commit?.sha || null
        },
        message: "GitHub App authentication, repository write, and read/write API path verified."
    };
}

/* ============================================================
   STUDY PERSISTENCE ROUTE
   ============================================================ */

async function handleStudyCreate(request, env, config, origin) {
    const contentLength = Number(request.headers.get("Content-Length") || 0);

    if (contentLength > config.maxBodyBytes) {
        return errorResponse(
            `Request body exceeds the ${config.maxBodyBytes} byte limit.`,
            413,
            origin,
            undefined,
            config.allowedOrigin
        );
    }

    let payload;

    try {
        const bodyText = await request.text();

        if (new TextEncoder().encode(bodyText).byteLength > config.maxBodyBytes) {
            return errorResponse(
                `Request body exceeds the ${config.maxBodyBytes} byte limit.`,
                413,
                origin,
                undefined,
                config.allowedOrigin
            );
        }

        payload = JSON.parse(bodyText);
    } catch {
        return errorResponse("Request body must contain valid JSON.", 400, origin, undefined, config.allowedOrigin);
    }

    try {
        validatePayload(payload);
    } catch (error) {
        return errorResponse(error.message, 400, origin, undefined, config.allowedOrigin);
    }

    try {
        const result = await persistStudy(
            env,
            config,
            payload.study,
            payload.studyArea
        );

        return jsonResponse(
            {
                ok: true,
                message: "Study persisted successfully.",
                studyId: payload.study.id,
                repository: result.repository,
                branch: result.branch,
                files: result.files,
                commit: {
                    sha: result.commitSha,
                    url: result.commitUrl,
                    savedAt: result.savedAt
                },
                blobs: {
                    studies: result.studiesSha,
                    studyArea: result.studyAreaSha
                }
            },
            200,
            origin,
            config.allowedOrigin
        );
    } catch (error) {
        const safeDetails = {
            status: error.status || null,
            githubMessage: error.github?.message || null
        };

        return errorResponse(
            `Study persistence failed: ${error.message}`,
            error.status && error.status >= 400 && error.status < 500 ? error.status : 500,
            origin,
            safeDetails,
            config.allowedOrigin
        );
    }
}

/* ============================================================
   MAIN HANDLER
   ============================================================ */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin") || "";
        const config = getConfiguration(env);

        /* Handle browser CORS preflight. */
        if (request.method === "OPTIONS") {
            if (origin && origin !== config.allowedOrigin) {
                return new Response(null, { status: 403 });
            }

            return new Response(null, {
                status: 204,
                headers: corsHeaders(origin, config.allowedOrigin)
            });
        }

        /* All browser/API routes are restricted to the application origin. */
        if (
            origin &&
            origin !== config.allowedOrigin
        ) {
            return errorResponse(
                "Origin is not authorized for this API.",
                403,
                origin,
                undefined,
                config.allowedOrigin
            );
        }

        try {
            if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
                return jsonResponse(
                    {
                        ok: true,
                        service: config.appName,
                        status: "healthy",
                        version: "3B.3.5"
                    },
                    200,
                    origin,
                    config.allowedOrigin
                );
            }

            if (request.method === "GET" && url.pathname === "/github/status") {
                const result = await runGithubStatus(env, config);
                return jsonResponse(result, 200, origin, config.allowedOrigin);
            }

            if (request.method === "GET" && url.pathname === "/github/test") {
                const result = await runGithubTest(env, config);
                return jsonResponse(result, 200, origin, config.allowedOrigin);
            }

            if (
                request.method === "POST" &&
                url.pathname === "/api/v1/studies"
            ) {
                return handleStudyCreate(request, env, config, origin);
            }

            return errorResponse("Route not found.", 404, origin, undefined, config.allowedOrigin);
        } catch (error) {
            return errorResponse(
                error?.message || "Unhandled Worker error.",
                500,
                origin,
                undefined,
                config.allowedOrigin
            );
        }
    }
};
