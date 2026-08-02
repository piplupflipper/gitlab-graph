"use strict";

const assert = require("node:assert");
const { test } = require("./framework");
const {
    createDom,
    createFetchStub,
    defaultFixture,
    dispatchKey,
    loadCore,
    rawCommit,
    response,
    source,
    tick,
    waitFor,
} = require("./helpers");

const commitCalls = (env) => env.fetch.calls.filter((call) => call.url.pathname.endsWith("/repository/commits"));

let basePromise;
const base = () => {
    if (!basePromise) basePromise = createDom();
    return basePromise;
};

test("dom-smoke 01: userscript starts on a GitLab network page", async () => {
    const env = await base();
    assert.ok(env.document.querySelector(".glg-root"));
});

test("dom-smoke 02: native project-network is hidden, not removed", async () => {
    const env = await base();
    const native = env.document.querySelector(".project-network");
    assert.ok(native.isConnected);
    assert.ok(native.classList.contains("glg-hidden"));
});

test("dom-smoke 03: custom root is inserted immediately after project-network", async () => {
    const env = await base();
    const native = env.document.querySelector(".project-network");
    assert.strictEqual(native.nextElementSibling, env.document.querySelector(".glg-root"));
});

test("dom-smoke 04: GitLab 17.5 native row-content-block is hidden", async () => {
    const env = await base();
    assert.ok(env.document.querySelector("#js-graph-ref-switcher").closest(".row-content-block").classList.contains("glg-hidden"));
});

test("dom-smoke 05: subgroup project path is percent-encoded in API requests", async () => {
    const env = await base();
    assert.ok(env.fetch.calls.some((call) => call.url.pathname.includes("/projects/grp%2Fsub%2Fprj")));
});

test("dom-smoke 06: percent-encoded slash in ref is decoded as one ref name", () => {
    const context = loadCore("https://gitlab.example/grp/sub/prj/-/network/feature%2Fx");
    assert.deepStrictEqual({ ...context.api.parseContext() }, { projectPath: "grp/sub/prj", ref: "feature/x" });
    context.dom.window.close();
});

test("dom-smoke 07: non-network pages leave the DOM untouched", async () => {
    const env = await createDom({
        url: "https://gitlab.example/grp/sub/prj/-/commits/main",
        html: "<!doctype html><html><head></head><body><div class=\"project-network\">sentinel</div></body></html>",
        waitForUi: false,
    });
    await tick();
    assert.strictEqual(env.document.querySelector(".glg-root"), null);
    assert.ok(!env.document.querySelector(".project-network").classList.contains("glg-hidden"));
    env.dom.window.close();
});

test("dom-smoke 08: custom root contains toolbar, status, and table", async () => {
    const env = await base();
    assert.ok(env.document.querySelector(".glg-toolbar"));
    assert.ok(env.document.querySelector(".glg-status"));
    assert.ok(env.document.querySelector(".glg-table"));
});

test("dom-smoke 09: normalized API commits render one row each", async () => {
    const env = await base();
    assert.strictEqual(env.document.querySelectorAll(".glg-row").length, 4);
});

test("dom-smoke 10: rendered graph has one SVG dot per commit", async () => {
    const env = await base();
    assert.strictEqual(env.document.querySelectorAll("circle.glg-dot").length, 4);
});

test("dom-smoke 11: first visible commit is selected", async () => {
    const env = await base();
    assert.strictEqual(env.document.querySelectorAll(".glg-row[data-glg-selected]").length, 1);
});

test("dom-smoke 12: count label identifies all-branches scope", async () => {
    const env = await base();
    assert.match(env.document.querySelector(".glg-count").textContent, /^全ブランチ: 表示 4 件 \/ 読み込み済み 4 件/);
});

test("dom-smoke 13: userscript stylesheet is injected once", async () => {
    const env = await base();
    assert.strictEqual(env.document.head.querySelectorAll("style").length, 1);
});

test("dom-smoke 14: table exposes the five expected headers", async () => {
    const env = await base();
    assert.strictEqual([...env.document.querySelectorAll("thead th")].map((node) => node.textContent).join(","), "Graph,Description,Author,Date,SHA");
});

test("dom-smoke 15: URL ref is shown in the toolbar", async () => {
    const env = await base();
    assert.strictEqual(env.document.querySelector(".glg-ref-label").textContent, "ref: main");
});

test("dom-smoke 16: default branch is pinned in the datalist", async () => {
    const env = await base();
    assert.strictEqual(env.document.querySelector("#glg-branch-list option").value, "main");
});

test("dom-smoke 17: tag ref is rendered as a tag chip", async () => {
    const env = await base();
    assert.strictEqual(env.document.querySelector(".glg-chip-tag").textContent, "v1.0");
});

test("dom-smoke 18: branch and tag refs can share one commit row", async () => {
    const env = await base();
    const row = env.document.querySelector('.glg-row[data-glg-sha="side0000"]');
    assert.strictEqual(row.querySelectorAll(".glg-chip").length, 2);
});

test("dom-smoke 19: shared branch and tag chips occupy the same description cell", async () => {
    const env = await base();
    const chips = env.document.querySelectorAll('.glg-row[data-glg-sha="side0000"] .glg-cell-desc .glg-chip');
    assert.strictEqual([...chips].map((node) => node.textContent).join(","), "feature/x,v1.0");
});

test("dom-smoke 20: return button is placed directly before the native graph", async () => {
    const env = await base();
    assert.ok(env.document.querySelector(".project-network").previousElementSibling.classList.contains("glg-return"));
});

const chainBatch = (start, end) => {
    const items = [];
    for (let index = start; index <= end; index += 1) {
        const sha = `c${String(index).padStart(3, "0")}`;
        const parent = index < 297 ? [`c${String(index + 1).padStart(3, "0")}`] : [];
        items.push(rawCommit(sha, parent, 0, { committedDate: new Date(Date.UTC(2026, 0, 2) - index * 60000).toISOString() }));
    }
    return items;
};

let pagingPromise;
const paging = () => {
    if (!pagingPromise) {
        let index = 0;
        const batches = [chainBatch(0, 99), chainBatch(99, 198), chainBatch(198, 297)];
        const fixture = {
            project: { default_branch: "main" },
            branches: [{ name: "main", default: true, commit: { id: "c000" } }],
            tags: [],
            commits: batches[0],
            fetch: (url) => {
                if (url.pathname.endsWith("/repository/commits")) return response(batches[index++] ?? []);
            },
        };
        pagingPromise = createDom({ fixture });
    }
    return pagingPromise;
};

test("dom-smoke 21: all mode performs three initial until-window requests", async () => {
    const env = await paging();
    assert.strictEqual(commitCalls(env).length, 3);
});

test("dom-smoke 22: every all-mode window sends all=true", async () => {
    const env = await paging();
    assert.ok(commitCalls(env).every((call) => call.url.searchParams.get("all") === "true"));
});

test("dom-smoke 23: all-mode windows never send a page parameter", async () => {
    const env = await paging();
    assert.ok(commitCalls(env).every((call) => !call.url.searchParams.has("page")));
});

test("dom-smoke 24: first all-mode window has no until parameter", async () => {
    const env = await paging();
    assert.ok(!commitCalls(env)[0].url.searchParams.has("until"));
});

test("dom-smoke 25: second window starts at the first window oldest date", async () => {
    const env = await paging();
    assert.strictEqual(commitCalls(env)[1].url.searchParams.get("until"), chainBatch(0, 99).at(-1).committed_date);
});

test("dom-smoke 26: third window starts at the second window oldest date", async () => {
    const env = await paging();
    assert.strictEqual(commitCalls(env)[2].url.searchParams.get("until"), chainBatch(99, 198).at(-1).committed_date);
});

test("dom-smoke 27: overlapping boundaries yield 298 unique commits", async () => {
    const env = await paging();
    assert.strictEqual(env.api.state.commits.length, 298);
});

test("dom-smoke 28: loaded SHA set also contains exactly 298 entries", async () => {
    const env = await paging();
    assert.strictEqual(env.api.state.loadedShas.size, 298);
});

test("dom-smoke 29: all 298 reachable commits produce DOM rows", async () => {
    const env = await paging();
    assert.strictEqual(env.document.querySelectorAll(".glg-row").length, 298);
});

test("dom-smoke 30: each duplicated boundary SHA appears only once", async () => {
    const env = await paging();
    assert.strictEqual(env.document.querySelectorAll('.glg-row[data-glg-sha="c099"], .glg-row[data-glg-sha="c198"]').length, 2);
    env.dom.window.close();
});

let stuckPromise;
const stuck = () => {
    if (!stuckPromise) {
        const batch = chainBatch(0, 99);
        const fixture = {
            project: { default_branch: "main" },
            branches: [{ name: "main", default: true, commit: { id: "c000" } }],
            tags: [],
            commits: batch,
            fetch: (url) => (url.pathname.endsWith("/repository/commits") ? response(batch) : undefined),
        };
        stuckPromise = createDom({ fixture });
    }
    return stuckPromise;
};

test("dom-smoke 31: an all-mode window with no new SHA stops after two requests", async () => {
    const env = await stuck();
    assert.strictEqual(commitCalls(env).length, 2);
});

test("dom-smoke 32: no-progress until window displays a diagnostic notice", async () => {
    const env = await stuck();
    assert.match(env.document.querySelector(".glg-status-note").textContent, /これ以上さかのぼれなかった/);
});

test("dom-smoke 33: no-progress until window disables further loading", async () => {
    const env = await stuck();
    assert.ok(env.document.querySelector(".glg-more").disabled);
    env.dom.window.close();
});

test("dom-smoke 34: a batch shorter than per_page performs no additional request", async () => {
    const env = await createDom();
    assert.strictEqual(commitCalls(env).length, 1);
    assert.ok(env.document.querySelector(".glg-more").disabled);
    env.dom.window.close();
});

let refPromise;
const refEnv = async () => {
    if (!refPromise) {
        const refItems = Array.from({ length: 210 }, (_, index) => {
            const sha = `d${String(index).padStart(3, "0")}`;
            const parents = index < 209 ? [`d${String(index + 1).padStart(3, "0")}`] : [];
            return rawCommit(sha, parents, 300 - index);
        });
        const fixture = {
            project: { default_branch: "main" },
            branches: [
                { name: "main", default: true, commit: { id: "d000" } },
                { name: "dev", default: false, commit: { id: "d000" } },
            ],
            tags: [],
            commits: [],
            fetch: (url) => {
                if (!url.pathname.endsWith("/repository/commits")) return undefined;
                if (!url.searchParams.has("ref_name")) return response([]);
                const page = Number(url.searchParams.get("page"));
                return response(refItems.slice((page - 1) * 100, page * 100));
            },
        };
        refPromise = createDom({ fixture }).then(async (env) => {
            const input = env.document.querySelector(".glg-branch");
            input.value = "dev";
            dispatchKey(env.window, input, "Enter");
            await waitFor(() => !env.api.state.loading && env.api.state.mode === "ref", "ref reload");
            return env;
        });
    }
    return refPromise;
};

test("dom-smoke 35: confirmed branch switches commits API to ref_name mode", async () => {
    const env = await refEnv();
    assert.ok(commitCalls(env).filter((call) => call.url.searchParams.has("ref_name")).every((call) => call.url.searchParams.get("ref_name") === "dev"));
});

test("dom-smoke 36: ref mode requests pages 1, 2, and 3", async () => {
    const env = await refEnv();
    assert.strictEqual(commitCalls(env).filter((call) => call.url.searchParams.has("ref_name")).map((call) => call.url.searchParams.get("page")).join(","), "1,2,3");
});

test("dom-smoke 37: ref mode performs exactly three initial page requests", async () => {
    const env = await refEnv();
    assert.strictEqual(commitCalls(env).filter((call) => call.url.searchParams.has("ref_name")).length, 3);
});

test("dom-smoke 38: ref pages append all 210 commits", async () => {
    const env = await refEnv();
    assert.strictEqual(env.api.state.commits.length, 210);
});

test("dom-smoke 39: short third ref page marks history complete", async () => {
    const env = await refEnv();
    assert.strictEqual(env.api.state.hasMore, false);
});

test("dom-smoke 40: branch confirmation blurs input and labels the scope", async () => {
    const env = await refEnv();
    assert.notStrictEqual(env.document.activeElement, env.document.querySelector(".glg-branch"));
    assert.match(env.document.querySelector(".glg-count").textContent, /^dev: 表示 210 件/);
    env.dom.window.close();
});

let keyPromise;
let openedUrl = "";
let copiedSha = "";
const keys = () => {
    if (!keyPromise) {
        keyPromise = createDom({
            open: (url) => {
                openedUrl = url;
            },
            clipboard: {
                writeText: async (value) => {
                    copiedSha = value;
                },
            },
        });
    }
    return keyPromise;
};

test("dom-smoke 41: j moves selection down and prevents default", async () => {
    const env = await keys();
    const before = env.api.state.selectedSha;
    const result = dispatchKey(env.window, env.document.body, "j");
    assert.ok(result.prevented);
    assert.notStrictEqual(env.api.state.selectedSha, before);
});

test("dom-smoke 42: k moves selection back up", async () => {
    const env = await keys();
    const before = env.api.state.selectedSha;
    dispatchKey(env.window, env.document.body, "k");
    assert.notStrictEqual(env.api.state.selectedSha, before);
});

test("dom-smoke 43: Enter opens the selected detail row", async () => {
    const env = await keys();
    const result = dispatchKey(env.window, env.document.body, "Enter");
    assert.ok(result.prevented);
    await waitFor(() => env.document.querySelector(".glg-detail-row"), "keyboard detail row");
});

test("dom-smoke 44: o opens the selected commit in a new tab", async () => {
    const env = await keys();
    const result = dispatchKey(env.window, env.document.body, "o");
    assert.ok(result.prevented);
    assert.match(openedUrl, new RegExp(env.api.state.selectedSha));
});

test("dom-smoke 45: first y is consumed while waiting for yy", async () => {
    const env = await keys();
    assert.ok(dispatchKey(env.window, env.document.body, "y").prevented);
});

test("dom-smoke 46: second y copies the full selected SHA", async () => {
    const env = await keys();
    assert.ok(dispatchKey(env.window, env.document.body, "y").prevented);
    await tick();
    assert.strictEqual(copiedSha, env.api.state.selectedSha);
});

test("dom-smoke 47: slash focuses and selects the filter input", async () => {
    const env = await keys();
    assert.ok(dispatchKey(env.window, env.document.body, "/").prevented);
    assert.strictEqual(env.document.activeElement, env.document.querySelector(".glg-filter"));
});

test("dom-smoke 48: Escape in the filter input blurs it", async () => {
    const env = await keys();
    const input = env.document.querySelector(".glg-filter");
    input.focus();
    assert.ok(dispatchKey(env.window, input, "Escape").prevented);
    assert.notStrictEqual(env.document.activeElement, input);
});

test("dom-smoke 49: j in an editable input is passed through", async () => {
    const env = await keys();
    const input = env.document.querySelector(".glg-filter");
    const before = env.api.state.selectedSha;
    assert.ok(!dispatchKey(env.window, input, "j").prevented);
    assert.strictEqual(env.api.state.selectedSha, before);
});

test("dom-smoke 50: IME-composing j is passed through", async () => {
    const env = await keys();
    assert.ok(!dispatchKey(env.window, env.document.body, "j", { isComposing: true }).prevented);
});

test("dom-smoke 51: keyCode 229 fallback is passed through", async () => {
    const env = await keys();
    const event = new env.window.KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { value: 229 });
    assert.ok(env.document.body.dispatchEvent(event));
});

test("dom-smoke 52: Ctrl-modified shortcut is passed through", async () => {
    const env = await keys();
    assert.ok(!dispatchKey(env.window, env.document.body, "j", { ctrlKey: true }).prevented);
});

test("dom-smoke 53: Alt-modified shortcut is passed through", async () => {
    const env = await keys();
    assert.ok(!dispatchKey(env.window, env.document.body, "j", { altKey: true }).prevented);
});

test("dom-smoke 54: Meta-modified shortcut is passed through", async () => {
    const env = await keys();
    assert.ok(!dispatchKey(env.window, env.document.body, "j", { metaKey: true }).prevented);
});

test("dom-smoke 55: unassigned key does not prevent default", async () => {
    const env = await keys();
    assert.ok(!dispatchKey(env.window, env.document.body, "x").prevented);
});

test("dom-smoke 56: l requests one more batch when history remains", async () => {
    const env = await keys();
    const before = commitCalls(env).length;
    env.api.state.hasMore = true;
    assert.ok(dispatchKey(env.window, env.document.body, "l").prevented);
    await waitFor(() => !env.api.state.loading && commitCalls(env).length === before + 1, "keyboard load-more");
});

test("dom-smoke 57: Escape closes an expanded detail row", async () => {
    const env = await keys();
    assert.ok(dispatchKey(env.window, env.document.body, "Escape").prevented);
    assert.strictEqual(env.document.querySelector(".glg-detail-row"), null);
});

test("dom-smoke 58: shortcuts are inactive while native view is selected", async () => {
    const env = await keys();
    env.document.querySelector(".glg-native").click();
    assert.ok(!dispatchKey(env.window, env.document.body, "j").prevented);
    env.document.querySelector(".glg-return").click();
    env.dom.window.close();
});

let detailPromise;
const detail = () => {
    if (!detailPromise) {
        const fixture = defaultFixture();
        fixture.fetch = (url) => {
            if (url.pathname.endsWith("/diff")) {
                const sha = url.pathname.split("/").at(-2);
                if (sha === "merge000") {
                    return response([{ old_path: "old.txt", new_path: ".gitignore", renamed_file: true }]);
                }
                return response([]);
            }
        };
        detailPromise = createDom({ fixture }).then(async (env) => {
            env.document.querySelector('.glg-row[data-glg-sha="merge000"]').click();
            await waitFor(() => env.document.querySelector(".glg-detail-message"), "detail payload");
            return env;
        });
    }
    return detailPromise;
};

test("dom-smoke 59: clicking a commit opens exactly one detail panel", async () => {
    const env = await detail();
    assert.strictEqual(env.document.querySelectorAll(".glg-detail-row").length, 1);
});

test("dom-smoke 60: detail panel shows the full commit message", async () => {
    const env = await detail();
    assert.match(env.document.querySelector(".glg-detail-message").textContent, /Full body/);
});

test("dom-smoke 61: detail panel shows addition and deletion stats", async () => {
    const env = await detail();
    assert.strictEqual(env.document.querySelector(".glg-stat-added").textContent, "+7");
    assert.strictEqual(env.document.querySelector(".glg-stat-removed").textContent, "−3");
});

test("dom-smoke 62: renamed file receives an R badge", async () => {
    const env = await detail();
    assert.strictEqual(env.document.querySelector(".glg-badge-r").textContent, "R");
});

test("dom-smoke 63: diff link includes encoded file_path", async () => {
    const env = await detail();
    assert.match(env.document.querySelector(".glg-file-link").href, /\?file_path=.gitignore/);
});

test("dom-smoke 64: diff link gains GitLab's SHA-1 file anchor", async () => {
    const env = await detail();
    await waitFor(() => env.document.querySelector(".glg-file-link").hash.length > 1, "diff SHA-1 anchor");
    assert.strictEqual(env.document.querySelector(".glg-file-link").hash, "#a5cc2925ca8258af241be7e5b0381edf30266302");
});

test("dom-smoke 65: loaded parents are rendered as in-graph buttons", async () => {
    const env = await detail();
    assert.strictEqual(env.document.querySelectorAll(".glg-parent-link[type=button]").length, 2);
});

test("dom-smoke 66: opening another commit replaces the previous detail row", async () => {
    const env = await detail();
    env.document.querySelector('.glg-row[data-glg-sha="side0000"]').click();
    await waitFor(() => env.api.state.expandedSha === "side0000", "second detail selection");
    assert.strictEqual(env.document.querySelectorAll(".glg-detail-row").length, 1);
});

test("dom-smoke 67: detail metadata shows author identity", async () => {
    const env = await detail();
    await waitFor(() => env.document.querySelector(".glg-detail-message")?.textContent.includes("Side change"), "second detail payload");
    assert.match(env.document.querySelector(".glg-detail-meta").textContent, /Test Author|Side Dev/);
});

test("dom-smoke 68: differing committer identity is displayed", async () => {
    const env = await detail();
    assert.match(env.document.querySelector(".glg-detail-meta").textContent, /Committer/);
});

test("dom-smoke 69: a successful empty diff displays zero-file feedback", async () => {
    const env = await detail();
    assert.match(env.document.querySelector(".glg-files").textContent, /変更ファイルなし/);
    env.dom.window.close();
});

let errorDetailPromise;
const errorDetail = () => {
    if (!errorDetailPromise) {
        const fixture = defaultFixture();
        fixture.fetch = (url) => {
            if (/\/repository\/commits\/merge000$/.test(url.pathname)) return response({}, 404);
            if (url.pathname.endsWith("/diff")) return response({}, 401);
        };
        errorDetailPromise = createDom({ fixture }).then(async (env) => {
            env.document.querySelector('.glg-row[data-glg-sha="merge000"]').click();
            await waitFor(() => env.document.querySelector(".glg-detail-error"), "detail errors");
            return env;
        });
    }
    return errorDetailPromise;
};

test("dom-smoke 70: detail HTTP 404 is rendered in the panel", async () => {
    const env = await errorDetail();
    assert.match(env.document.querySelector(".glg-detail-error").textContent, /HTTP 404/);
});

test("dom-smoke 71: diff HTTP 401 is retained as a second error", async () => {
    (await errorDetail()).dom.window.close();
    const fixture = defaultFixture();
    fixture.fetch = (url) => (url.pathname.endsWith("/diff") ? response({}, 401) : undefined);
    const env = await createDom({ fixture });
    env.document.querySelector('.glg-row[data-glg-sha="merge000"]').click();
    await waitFor(() => [...env.document.querySelectorAll(".glg-detail-error")].some((node) => node.textContent.includes("HTTP 401")), "diff 401");
    assert.match([...env.document.querySelectorAll(".glg-detail-error")].map((node) => node.textContent).join(" "), /HTTP 401/);
    env.dom.window.close();
});

test("dom-smoke 72: ref mode 200 with an empty commit array shows a zero-result error", async () => {
    const fixture = defaultFixture();
    fixture.fetch = (url) => {
        if (url.pathname.endsWith("/repository/commits") && url.searchParams.has("ref_name")) return response([]);
    };
    const env = await createDom({ fixture });
    const input = env.document.querySelector(".glg-branch");
    input.value = "missing";
    dispatchKey(env.window, input, "Enter");
    await waitFor(() => !env.api.state.loading && env.api.state.mode === "ref", "empty ref reload");
    assert.match(env.document.querySelector(".glg-status-error").textContent, /0 件だった/);
    env.dom.window.close();
});

test("dom-smoke 73: text filtering reports displayed and loaded scope counts", async () => {
    const env = await createDom();
    const input = env.document.querySelector(".glg-filter");
    input.value = "Initial";
    input.dispatchEvent(new env.window.Event("input", { bubbles: true }));
    assert.match(env.document.querySelector(".glg-count").textContent, /表示 1 件 \/ 読み込み済み 4 件/);
    env.dom.window.close();
});

let searchPromise;
const searchEnv = () => {
    if (!searchPromise) {
        const fixture = defaultFixture();
        fixture.branches = [
            ...Array.from({ length: 100 }, (_, index) => ({
                name: `archive-${String(index).padStart(3, "0")}`,
                default: false,
                commit: { id: "side0000" },
            })),
            { name: "feature/x", default: false, commit: { id: "side0000" } },
            { name: "feature/y", default: false, commit: { id: "side0000" } },
        ];
        fixture.fetch = (url) => {
            if (url.pathname.endsWith("/repository/branches/main")) {
                return response({ name: "main", default: true, commit: { id: "merge000" } });
            }
            if (url.pathname.endsWith("/repository/branches")) {
                const search = url.searchParams.get("search");
                const matches = search ? fixture.branches.filter((entry) => entry.name.includes(search)) : fixture.branches;
                const page = Number(url.searchParams.get("page") ?? 1);
                return response(matches.slice((page - 1) * 100, page * 100));
            }
        };
        searchPromise = createDom({ fixture });
    }
    return searchPromise;
};

test("dom-smoke 74: branch input waits for the 250ms debounce", async () => {
    const env = await searchEnv();
    const before = env.fetch.calls.length;
    const input = env.document.querySelector(".glg-branch");
    input.value = "feature";
    input.dispatchEvent(new env.window.Event("input", { bubbles: true }));
    assert.strictEqual(env.fetch.calls.length, before);
});

test("dom-smoke 75: debounced branch search sends the typed search term", async () => {
    const env = await searchEnv();
    await new Promise((resolve) => setTimeout(resolve, 275));
    assert.ok(env.fetch.calls.some((call) => call.url.pathname.endsWith("/repository/branches") && call.url.searchParams.get("search") === "feature"));
});

test("dom-smoke 76: branch search refreshes datalist matches", async () => {
    const env = await searchEnv();
    assert.ok([...env.document.querySelectorAll("#glg-branch-list option")].some((option) => option.value === "feature/y"));
});

test("dom-smoke 77: a subsequent search aborts the previous controller", async () => {
    const env = await searchEnv();
    const previous = env.fetch.calls.filter((call) => call.url.searchParams.get("search") === "feature").at(-1);
    const input = env.document.querySelector(".glg-branch");
    input.value = "main";
    input.dispatchEvent(new env.window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 275));
    assert.ok(previous.options.signal.aborted);
});

test("dom-smoke 78: confirming a datalist value selects ref mode", async () => {
    const env = await searchEnv();
    const input = env.document.querySelector(".glg-branch");
    input.value = "feature/x";
    input.dispatchEvent(new env.window.Event("change", { bubbles: true }));
    await waitFor(() => !env.api.state.loading && env.api.state.mode === "ref", "confirmed ref");
    assert.strictEqual(env.api.state.refName, "feature/x");
});

test("dom-smoke 79: confirmed branch is sent as ref_name", async () => {
    const env = await searchEnv();
    assert.ok(commitCalls(env).some((call) => call.url.searchParams.get("ref_name") === "feature/x"));
});

test("dom-smoke 80: confirmed branch input loses focus", async () => {
    const env = await searchEnv();
    assert.notStrictEqual(env.document.activeElement, env.document.querySelector(".glg-branch"));
});

test("dom-smoke 81: clearing and confirming returns to all mode", async () => {
    const env = await searchEnv();
    const input = env.document.querySelector(".glg-branch");
    input.value = "";
    dispatchKey(env.window, input, "Enter");
    await waitFor(() => !env.api.state.loading && env.api.state.mode === "all", "all-mode return");
    assert.strictEqual(env.api.state.refName, "");
});

test("dom-smoke 82: clearing branch restores all=true commit fetching", async () => {
    const env = await searchEnv();
    assert.strictEqual(commitCalls(env).at(-1).url.searchParams.get("all"), "true");
});

test("dom-smoke 83: default branch remains first after filtered searches", async () => {
    const env = await searchEnv();
    assert.strictEqual(env.document.querySelector("#glg-branch-list option").value, "main");
});

test("dom-smoke 84: URL ref remains pinned without duplication", async () => {
    const env = await searchEnv();
    assert.strictEqual([...env.document.querySelectorAll("#glg-branch-list option")].filter((option) => option.value === "main").length, 1);
});

test("dom-smoke 85: single-branch endpoint is used to reserve the mainline", async () => {
    const env = await searchEnv();
    assert.ok(env.fetch.calls.some((call) => call.url.pathname.endsWith("/repository/branches/main")));
    env.dom.window.close();
});

let clipPromise;
const clip = () => {
    if (!clipPromise) {
        const commits = Array.from({ length: 40 }, (_, index) => rawCommit(`tip${String(index).padStart(2, "0")}`, ["root0000"], 100 - index));
        commits.push(rawCommit("root0000", [], 1));
        const branches = commits.slice(0, 40).map((item, index) => ({
            name: index === 0 ? "main" : `branch-${index}`,
            default: index === 0,
            commit: { id: item.id },
        }));
        clipPromise = createDom({ fixture: { project: { default_branch: "main" }, branches, tags: [], commits } });
    }
    return clipPromise;
};

test("dom-smoke 86: forty-lane history clips graph column at 240px", async () => {
    const env = await clip();
    assert.strictEqual(env.document.querySelector(".glg-table col").style.width, "240px");
});

test("dom-smoke 87: clipped graph header reports twenty-four hidden lanes", async () => {
    const env = await clip();
    assert.match(env.document.querySelector(".glg-head-graph").textContent, /\(\+24\)/);
});

test("dom-smoke 88: clipped root receives a clipped-state class", async () => {
    const env = await clip();
    assert.ok(env.document.querySelector(".glg-root").classList.contains("glg-clipped"));
});

test("dom-smoke 89: right-edge compressed dots retain lane titles", async () => {
    const env = await clip();
    assert.ok(env.document.querySelectorAll("circle title").length >= 24);
});

test("dom-smoke 90: graph rows use the fixed 26px SVG height", async () => {
    const env = await clip();
    assert.ok([...env.document.querySelectorAll("svg.glg-graph")].every((svg) => svg.getAttribute("height") === "26"));
});

test("dom-smoke 91: one-row transition upper half matches De Casteljau control points", async () => {
    const env = await clip();
    assert.strictEqual(env.api.transitionUpperPath(9, 23), "M 9 13 C 9 19.5, 12.5 22.75, 16 26");
});

test("dom-smoke 92: one-row transition lower half is symmetric", async () => {
    const env = await clip();
    assert.strictEqual(env.api.transitionLowerPath(9, 23), "M 16 0 C 19.5 3.25, 23 6.5, 23 13");
});

test("dom-smoke 93: zero-row graph keeps the 56px minimum width", async () => {
    const env = await createDom({ fixture: { project: { default_branch: "main" }, branches: [], tags: [], commits: [] } });
    assert.strictEqual(env.document.querySelector(".glg-table col").style.width, "56px");
    env.dom.window.close();
    (await clip()).dom.window.close();
});

let avatarResolve;
let avatarPromise;
const avatarEnv = () => {
    if (!avatarPromise) {
        const fixture = defaultFixture();
        fixture.commits.push(rawCommit("phantom0", [], 20, { authorEmail: "phantom@example.com" }));
        fixture.fetch = (url) => {
            if (url.pathname === "/api/v4/avatar") {
                return new Promise((resolve) => {
                    avatarResolve = () => resolve(response({ avatar_url: "https://cdn.example/avatar.png" }));
                });
            }
        };
        avatarPromise = createDom({ fixture });
    }
    return avatarPromise;
};

test("dom-smoke 94: avatars render placeholders before delayed lookup completes", async () => {
    const env = await avatarEnv();
    assert.ok(env.document.querySelector(".glg-avatar")?.textContent.length > 0);
});

test("dom-smoke 95: avatar lookup is deduplicated per email", async () => {
    const env = await avatarEnv();
    const calls = env.fetch.calls.filter((call) => call.url.pathname === "/api/v4/avatar" && call.url.searchParams.get("email") === "test@example.com");
    assert.strictEqual(calls.length, 1);
});

test("dom-smoke 96: resolved avatar replaces all matching placeholders", async () => {
    const env = await avatarEnv();
    avatarResolve();
    await waitFor(() => env.document.querySelector(".glg-avatar-img"), "resolved avatar image");
    assert.ok(env.document.querySelectorAll(".glg-avatar-img").length >= 1);
});

test("dom-smoke 97: full-width and native-view toggles update DOM and localStorage", async () => {
    const env = await avatarEnv();
    env.document.querySelector(".glg-fullwidth").click();
    assert.ok(env.document.documentElement.classList.contains("glg-full-width"));
    assert.strictEqual(env.window.localStorage.getItem("glg-full-width"), "1");
    env.document.querySelector(".glg-native").click();
    assert.ok(!env.document.querySelector(".project-network").classList.contains("glg-hidden"));
    assert.strictEqual(env.window.localStorage.getItem("glg-view-mode"), "native");
    env.document.querySelector(".glg-return").click();
});

test("dom-smoke 98: phantom filter hides unreachable commits and can be disabled", async () => {
    const env = await avatarEnv();
    assert.match(env.document.querySelector(".glg-count").textContent, /1 件を非表示/);
    const toggle = env.document.querySelector(".glg-phantom");
    toggle.checked = false;
    toggle.dispatchEvent(new env.window.Event("change", { bubbles: true }));
    assert.ok(env.document.querySelector('.glg-row[data-glg-sha="phantom0"]'));
    assert.strictEqual(env.window.localStorage.getItem("glg-hide-phantom"), "0");
    env.dom.window.close();
});

test("dom-smoke 99: branch switch aborts an old all-mode request and rejects its late response", async () => {
    let resolveOld;
    let oldSignal;
    const fixture = {
        project: { default_branch: "main" },
        branches: [
            { name: "main", default: true, commit: { id: "old00000" } },
            { name: "dev", default: false, commit: { id: "new00000" } },
        ],
        tags: [],
        commits: [],
        fetch: (url, options) => {
            if (!url.pathname.endsWith("/repository/commits")) return undefined;
            if (url.searchParams.get("all") === "true") {
                oldSignal = options.signal;
                return new Promise((resolve) => {
                    resolveOld = () => resolve(response([rawCommit("old00000", [], 1)]));
                });
            }
            if (url.searchParams.get("ref_name") === "dev") {
                return response([rawCommit("new00000", [], 2)]);
            }
            return response([]);
        },
    };
    const env = await createDom({ fixture, waitForUi: false });
    await waitFor(() => env.document.querySelector(".glg-root") && resolveOld, "delayed all-mode request");
    const generation = env.api.state.commitGeneration;
    const input = env.document.querySelector(".glg-branch");
    input.value = "dev";
    dispatchKey(env.window, input, "Enter");
    await waitFor(() => env.api.state.commits.some((item) => item.sha === "new00000"), "new ref response");
    assert.ok(oldSignal.aborted);
    assert.ok(env.api.state.commitGeneration > generation);
    resolveOld();
    await tick();
    await tick();
    assert.strictEqual(env.api.state.commits.map((item) => item.sha).join(","), "new00000");
    assert.strictEqual(env.document.documentElement.dataset.glgMode, "ref");
    assert.strictEqual(env.document.documentElement.dataset.glgRef, "dev");
    assert.strictEqual(env.document.documentElement.dataset.glgGeneration, String(env.api.state.commitGeneration));
    env.dom.window.close();
});

test("dom-smoke 100: complete two-page branch refs keep page-two commits and filter phantoms", async () => {
    const main = { name: "main", default: true, commit: { id: "main0000" } };
    const fillers = Array.from({ length: 99 }, (_, index) => ({
        name: `branch-${String(index).padStart(3, "0")}`,
        default: false,
        commit: { id: "main0000" },
    }));
    const late = { name: "zz-late", default: false, commit: { id: "late0000" } };
    const fixture = {
        project: { default_branch: "main" },
        branches: [main, ...fillers, late],
        tags: [],
        commits: [rawCommit("main0000", [], 3), rawCommit("late0000", [], 2), rawCommit("phantom0", [], 1)],
    };
    const env = await createDom({ fixture });
    const pages = env.fetch.calls
        .filter((call) => call.url.pathname.endsWith("/repository/branches") && !call.url.searchParams.has("search"))
        .map((call) => call.url.searchParams.get("page"));
    assert.deepStrictEqual(pages, ["1", "2"]);
    assert.strictEqual(env.api.state.refsComplete, true);
    assert.ok(env.document.querySelector('.glg-row[data-glg-sha="late0000"]'));
    assert.strictEqual(env.document.querySelector('.glg-row[data-glg-sha="phantom0"]'), null);
    assert.match(env.document.querySelector(".glg-count").textContent, /1 件を非表示/);
    env.dom.window.close();
});

test("dom-smoke 101: a full tenth branch page fails open with an automatic-disable notice", async () => {
    const branches = Array.from({ length: 1100 }, (_, index) => ({
        name: index === 0 ? "main" : `branch-${String(index).padStart(4, "0")}`,
        default: index === 0,
        commit: { id: "main0000" },
    }));
    const fixture = {
        project: { default_branch: "main" },
        branches,
        tags: [],
        commits: [rawCommit("main0000", [], 2), rawCommit("phantom0", [], 1)],
    };
    const env = await createDom({ fixture });
    const pages = env.fetch.calls.filter((call) => call.url.pathname.endsWith("/repository/branches") && !call.url.searchParams.has("search"));
    assert.strictEqual(pages.length, 10);
    assert.strictEqual(pages.at(-1).url.searchParams.get("page"), "10");
    assert.strictEqual(env.api.state.refsComplete, false);
    assert.ok(env.document.querySelector('.glg-row[data-glg-sha="phantom0"]'));
    assert.ok(env.document.querySelector(".glg-phantom").checked);
    assert.match(env.document.querySelector(".glg-ref-filter-note").textContent, /自動的に無効化.*10 ページ/);
    env.dom.window.close();
});

test("dom-smoke 102: a branches API failure fails open and identifies refs as the last error", async () => {
    const branches = [
        { name: "main", default: true, commit: { id: "main0000" } },
        ...Array.from({ length: 100 }, (_, index) => ({
            name: `branch-${String(index).padStart(3, "0")}`,
            default: false,
            commit: { id: "main0000" },
        })),
    ];
    const fixture = {
        project: { default_branch: "main" },
        branches,
        tags: [],
        commits: [rawCommit("main0000", [], 2), rawCommit("phantom0", [], 1)],
        fetch: (url) =>
            url.pathname.endsWith("/repository/branches") && url.searchParams.get("page") === "2"
                ? response({}, 500)
                : undefined,
    };
    const env = await createDom({ fixture });
    assert.strictEqual(env.api.state.refsComplete, false);
    assert.ok(env.document.querySelector('.glg-row[data-glg-sha="phantom0"]'));
    assert.match(env.document.querySelector(".glg-ref-filter-note").textContent, /自動的に無効化.*取得に失敗/);
    assert.match(env.document.querySelector(".glg-status-error").textContent, /HTTP 500/);
    assert.strictEqual(env.document.documentElement.dataset.glgLastError, "refs");
    assert.strictEqual(env.document.querySelector("#glg-branch-list option").value, "main");
    assert.ok(env.document.querySelector('.glg-row[data-glg-sha="main0000"] .glg-chip'));
    env.dom.window.close();
});

test("dom-smoke 103: diagnostic dataset mirrors every public runtime field", async () => {
    const fixture = defaultFixture();
    fixture.commits.push(rawCommit("phantom0", [], 20));
    const env = await createDom({ fixture });
    const data = env.document.documentElement.dataset;
    assert.deepStrictEqual(
        {
            version: data.glgVersion,
            mode: data.glgMode,
            ref: data.glgRef,
            loaded: data.glgLoaded,
            visible: data.glgVisible,
            hidden: data.glgHidden,
            lanes: data.glgLanes,
            generation: data.glgGeneration,
            lastError: data.glgLastError,
        },
        {
            version: env.api.VERSION,
            mode: env.api.state.mode,
            ref: env.api.state.ref,
            loaded: String(env.api.state.commits.length),
            visible: String(env.api.state.visibleRows.length),
            hidden: String(env.api.state.hiddenCount),
            lanes: String(env.api.state.laneCount),
            generation: String(env.api.state.commitGeneration),
            lastError: "",
        },
    );
    const filter = env.document.querySelector(".glg-filter");
    filter.value = "Initial";
    filter.dispatchEvent(new env.window.Event("input", { bubbles: true }));
    assert.strictEqual(data.glgVisible, "1");
    const toggle = env.document.querySelector(".glg-phantom");
    toggle.checked = false;
    toggle.dispatchEvent(new env.window.Event("change", { bubbles: true }));
    assert.strictEqual(data.glgHidden, "0");
    env.dom.window.close();
});

test("dom-smoke 104: VERSION constant exactly matches userscript metadata", () => {
    const env = loadCore();
    const metadata = source.match(/^\/\/ @version\s+(\S+)$/m)?.[1];
    assert.strictEqual(env.api.VERSION, metadata);
    env.dom.window.close();
});

let detailBoundaryPromise;
const detailBoundary = () => {
    if (!detailBoundaryPromise) {
        const fixture = {
            project: { default_branch: "main" },
            branches: [
                { name: "main", default: true, commit: { id: "merge" } },
                { name: "other", default: false, commit: { id: "otherTip" } },
            ],
            tags: [],
            commits: [
                rawCommit("otherTip", ["otherParent"], 10),
                rawCommit("merge", ["mainParent", "sideParent"], 9),
                rawCommit("mainParent", ["root"], 8),
                rawCommit("sideParent", ["root"], 7),
                rawCommit("otherParent", ["root"], 1),
                rawCommit("root", [], 0),
            ],
        };
        detailBoundaryPromise = createDom({ fixture });
    }
    return detailBoundaryPromise;
};

const graphPaths = (env, sha) =>
    [...env.document.querySelectorAll(`.glg-row[data-glg-sha="${sha}"] path`)].map((node) => node.getAttribute("d"));

test("dom-smoke 105: detail gutter moves a colliding lane 0-to-2 midpoint onto distinct lane centers", async () => {
    const env = await detailBoundary();
    const row = env.api.state.rowsBySha.get("merge");
    assert.deepStrictEqual(
        [...row.render.detailLanes].map((lane) => lane.x),
        [env.api.laneDrawX(0), env.api.laneDrawX(1), env.api.laneDrawX(1)],
    );

    env.document.querySelector('.glg-row[data-glg-sha="merge"]').click();
    await waitFor(() => env.api.state.expandedSha === "merge" && env.document.querySelector(".glg-detail-row"), "collision detail row");

    const centers = [...env.document.querySelectorAll(".glg-detail-row rect")].map(
        (rect) => Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2,
    );
    assert.deepStrictEqual(centers, [env.api.laneDrawX(0), env.api.laneDrawX(1), env.api.laneDrawX(2)]);
    assert.strictEqual(new Set(centers).size, centers.length);
});

test("dom-smoke 106: detail boundary completes the curve above and enters below with an x1 vertical", async () => {
    const env = await detailBoundary();
    const x0 = env.api.laneDrawX(0);
    const x1 = env.api.laneDrawX(2);
    assert.ok(graphPaths(env, "merge").includes(env.api.halfRowPath(x0, env.api.HALF_ROW, x1, env.api.ROW_HEIGHT)));
    assert.ok(!graphPaths(env, "mainParent").includes(env.api.transitionLowerPath(x0, x1)));

    const entrance = [...env.document.querySelectorAll('.glg-row[data-glg-sha="mainParent"] line')].find(
        (line) =>
            Number(line.getAttribute("x1")) === x1 &&
            Number(line.getAttribute("x2")) === x1 &&
            Number(line.getAttribute("y1")) === 0 &&
            Number(line.getAttribute("y2")) === env.api.HALF_ROW,
    );
    assert.ok(entrance);
});

test("dom-smoke 107: closing detail restores the standard split transition", async () => {
    const env = await detailBoundary();
    const x0 = env.api.laneDrawX(0);
    const x1 = env.api.laneDrawX(2);
    env.document.querySelector('.glg-row[data-glg-sha="merge"]').click();

    assert.strictEqual(env.document.querySelector(".glg-detail-row"), null);
    assert.strictEqual(env.api.state.detailBoundaryIndex, -1);
    assert.ok(graphPaths(env, "merge").includes(env.api.transitionUpperPath(x0, x1)));
    assert.ok(graphPaths(env, "mainParent").includes(env.api.transitionLowerPath(x0, x1)));
});

test("dom-smoke 108: moving detail to a non-transition boundary restores the old pair and leaves the new pair unchanged", async () => {
    const env = await detailBoundary();
    const sideBefore = env.document.querySelector('.glg-row[data-glg-sha="sideParent"] .glg-cell-graph').innerHTML;
    const otherBefore = env.document.querySelector('.glg-row[data-glg-sha="otherParent"] .glg-cell-graph').innerHTML;
    const x0 = env.api.laneDrawX(0);
    const x1 = env.api.laneDrawX(2);

    env.document.querySelector('.glg-row[data-glg-sha="merge"]').click();
    env.document.querySelector('.glg-row[data-glg-sha="sideParent"]').click();
    await waitFor(
        () => env.api.state.expandedSha === "sideParent" && env.api.state.detailCache.has("sideParent"),
        "moved detail payload",
    );

    assert.strictEqual(env.api.state.detailBoundaryIndex, -1);
    assert.ok(graphPaths(env, "merge").includes(env.api.transitionUpperPath(x0, x1)));
    assert.ok(graphPaths(env, "mainParent").includes(env.api.transitionLowerPath(x0, x1)));
    assert.strictEqual(env.document.querySelector('.glg-row[data-glg-sha="sideParent"] .glg-cell-graph').innerHTML, sideBefore);
    assert.strictEqual(env.document.querySelector('.glg-row[data-glg-sha="otherParent"] .glg-cell-graph').innerHTML, otherBefore);
    env.dom.window.close();
});
