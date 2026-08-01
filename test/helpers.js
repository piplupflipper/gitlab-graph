"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "..", "gitlab-graph.user.js"), "utf8");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate, message = "condition", attempts = 200) => {
    for (let i = 0; i < attempts; i += 1) {
        if (predicate()) return;
        await tick();
    }
    throw new Error(`Timed out waiting for ${message}`);
};

const iso = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const commit = (sha, parents = [], minute = 0, extra = {}) => ({
    sha,
    shortSha: sha.slice(0, 8),
    title: extra.title ?? sha,
    authorName: extra.authorName ?? "Test Author",
    authorEmail: extra.authorEmail ?? "test@example.com",
    committedDate: extra.committedDate ?? iso(minute),
    time: extra.time ?? Date.parse(extra.committedDate ?? iso(minute)),
    parents: [...parents],
    webUrl: extra.webUrl ?? "",
});

const rawCommit = (sha, parents = [], minute = 0, extra = {}) => ({
    id: sha,
    short_id: sha.slice(0, 8),
    title: extra.title ?? sha,
    author_name: extra.authorName ?? "Test Author",
    author_email: extra.authorEmail ?? "test@example.com",
    committed_date: extra.committedDate ?? iso(minute),
    parent_ids: [...parents],
    web_url: extra.webUrl ?? `https://gitlab.example/grp/sub/prj/-/commit/${sha}`,
});

const response = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
});

const loadCore = (url = "https://gitlab.example/grp/prj/-/tree/main") => {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
        url,
        runScripts: "outside-only",
    });
    let api;
    dom.window.__GLG_TEST_HOOK__ = (value) => {
        api = value;
    };
    dom.window.eval(source);
    if (!api) throw new Error("test hook was not called");
    return { api, dom, window: dom.window };
};

const defaultFixture = () => {
    const commits = [
        rawCommit("merge000", ["main0000", "side0000"], 4, { title: "Merge feature" }),
        rawCommit("side0000", ["root0000"], 3, { title: "Side change", authorName: "Side Dev" }),
        rawCommit("main0000", ["root0000"], 2, { title: "Main change" }),
        rawCommit("root0000", [], 1, { title: "Initial commit" }),
    ];
    return {
        project: { default_branch: "main" },
        branches: [
            { name: "main", default: true, commit: { id: "merge000" } },
            { name: "feature/x", default: false, commit: { id: "side0000" } },
        ],
        tags: [{ name: "v1.0", commit: { id: "side0000" } }],
        commits,
    };
};

const createFetchStub = (fixture = defaultFixture()) => {
    const calls = [];
    const stub = async (input, options = {}) => {
        const url = new URL(String(input));
        calls.push({ url, options });
        if (fixture.fetch) {
            const custom = await fixture.fetch(url, options, calls);
            if (custom !== undefined) return custom;
        }
        const pathname = url.pathname;
        if (pathname === "/api/v4/avatar") return response({ avatar_url: "https://cdn.example/avatar.png" });
        if (/\/repository\/commits\/[^/]+\/diff$/.test(pathname)) return response(fixture.diff ?? []);
        if (/\/repository\/commits\/[^/]+$/.test(pathname)) {
            const sha = decodeURIComponent(pathname.split("/").pop());
            const item = fixture.commits.find((entry) => entry.id === sha) ?? rawCommit(sha);
            return response({
                ...item,
                message: fixture.message ?? `${item.title}\n\nFull body`,
                authored_date: item.committed_date,
                committer_name: "Committer",
                committer_email: "committer@example.com",
                stats: { additions: 7, deletions: 3 },
            });
        }
        if (/\/repository\/branches\/[^/]+$/.test(pathname)) {
            const name = decodeURIComponent(pathname.split("/").pop());
            const branch = fixture.branches.find((entry) => entry.name === name);
            return branch ? response(branch) : response({}, 404);
        }
        if (pathname.endsWith("/repository/branches")) {
            const search = url.searchParams.get("search");
            const matches = search ? fixture.branches.filter((entry) => entry.name.includes(search)) : fixture.branches;
            const page = Number(url.searchParams.get("page") ?? 1);
            return response(matches.slice((page - 1) * 100, page * 100));
        }
        if (pathname.endsWith("/repository/tags")) {
            const page = Number(url.searchParams.get("page") ?? 1);
            return response(fixture.tags.slice((page - 1) * 100, page * 100));
        }
        if (pathname.endsWith("/repository/commits")) return response(fixture.commits);
        if (/\/api\/v4\/projects\/[^/]+$/.test(pathname)) return response(fixture.project);
        throw new Error(`Unhandled fetch: ${url}`);
    };
    stub.calls = calls;
    return stub;
};

const createDom = async (options = {}) => {
    const fixture = options.fixture ?? defaultFixture();
    const html =
        options.html ??
        "<!doctype html><html><head></head><body><main class=\"container-limited\"><div class=\"row-content-block\"><div id=\"js-graph-ref-switcher\"></div><p>Native explanation</p></div><div class=\"project-network\"><div class=\"network-graph\">native graph</div></div></main></body></html>";
    const dom = new JSDOM(html, {
        url: options.url ?? "https://gitlab.example/grp/sub/prj/-/network/main",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const { window } = dom;
    let api;
    window.__GLG_TEST_HOOK__ = (value) => {
        api = value;
    };
    window.fetch = options.fetch ?? createFetchStub(fixture);
    window.open = options.open ?? (() => null);
    window.scrollTo = () => {};
    window.navigator.clipboard = options.clipboard ?? { writeText: async () => {} };
    window.TextEncoder = TextEncoder;
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
    if (!window.CSS) window.CSS = {};
    if (!window.CSS.escape) {
        window.CSS.escape = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
    }
    window.eval(source);
    if (!api) throw new Error("test hook was not called");
    if (options.waitForUi !== false && window.document.querySelector(".project-network")) {
        await waitFor(() => window.document.querySelector(".glg-root"), "userscript UI");
        await waitFor(() => !api.state.loading, "initial commit loading");
        await tick();
    }
    return { api, dom, window, document: window.document, fetch: window.fetch, fixture };
};

const dispatchKey = (window, target, key, init = {}) => {
    const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    const dispatched = target.dispatchEvent(event);
    return { event, prevented: !dispatched || event.defaultPrevented };
};

const shuffle = (values, seed) => {
    const result = [...values];
    let state = seed >>> 0;
    const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
};

module.exports = {
    commit,
    createDom,
    createFetchStub,
    defaultFixture,
    dispatchKey,
    iso,
    loadCore,
    rawCommit,
    response,
    shuffle,
    source,
    tick,
    waitFor,
};
