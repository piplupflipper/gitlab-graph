"use strict";

const assert = require("node:assert");
const { test } = require("./framework");
const { commit, loadCore, shuffle } = require("./helpers");

const { api, dom } = loadCore();

const syntheticDag = () => [
    commit("root", [], 1),
    commit("a", ["root"], 2),
    commit("b", ["a"], 3),
    commit("c", ["a"], 4),
    commit("d", ["b", "c"], 5),
    commit("e", ["d"], 6),
    commit("f", ["d"], 7),
    commit("g", ["e", "f"], 8),
    commit("h", ["g", "outside-first"], 9),
    commit("i", ["h"], 10),
    commit("j", ["i", "outside-second"], 11),
];

const positionMap = (ordered) => new Map(ordered.map((item, index) => [item.sha, index]));

const assertTopological = (ordered) => {
    const positions = positionMap(ordered);
    for (const item of ordered) {
        for (const parent of api.uniqueParents(item.parents)) {
            if (positions.has(parent)) assert.ok(positions.get(item.sha) < positions.get(parent), `${item.sha} before ${parent}`);
        }
    }
};

const upperLanes = (row) => {
    const lanes = [...row.passLanes, ...row.merges];
    if (row.hasTop) lanes.push(row.lane);
    return [...new Set(lanes)].sort((a, b) => a - b);
};

const assertLaneContinuity = (rows) => {
    for (let index = 1; index < rows.length; index += 1) {
        assert.deepStrictEqual([...rows[index - 1].activeAfter], upperLanes(rows[index]), `boundary ${index - 1}/${index}`);
    }
};

test("graph-core 01: shuffled 11-commit DAG retains every commit", () => {
    const ordered = api.topoSortCommits(shuffle(syntheticDag(), 7));
    assert.strictEqual(ordered.length, 11);
    assert.deepStrictEqual(new Set(ordered.map((item) => item.sha)), new Set(syntheticDag().map((item) => item.sha)));
});

test("graph-core 02: every loaded child precedes its loaded parent", () => {
    assertTopological(api.topoSortCommits(shuffle(syntheticDag(), 11)));
});

test("graph-core 03: simultaneously ready commits use descending date order", () => {
    const ordered = api.topoSortCommits([commit("older", [], 1), commit("newer", [], 9)]);
    assert.strictEqual(ordered.map((item) => item.sha).join(","), "newer,older");
});

test("graph-core 04: equal-date ready commits use SHA as deterministic tiebreak", () => {
    const ordered = api.topoSortCommits([commit("z", [], 1), commit("a", [], 1)]);
    assert.strictEqual(ordered.map((item) => item.sha).join(","), "a,z");
});

test("graph-core 05: lane lower edges equal the next row upper edges", () => {
    const result = api.assignLanes(api.topoSortCommits(shuffle(syntheticDag(), 21)), new Set());
    assertLaneContinuity(result.rows);
});

test("graph-core 06: a merge releases all losing expectation lanes", () => {
    const result = api.assignLanes(api.topoSortCommits(syntheticDag()), new Set());
    const mergeRows = result.rows.filter((row) => row.merges.length > 0);
    assert.ok(mergeRows.length >= 2);
    for (const row of mergeRows) {
        for (const lane of row.merges) assert.ok(!row.activeAfter.includes(lane));
    }
});

test("graph-core 07: missing external-parent lanes remain open at the loaded bottom", () => {
    const result = api.assignLanes(api.topoSortCommits(syntheticDag()), new Set());
    assert.ok(result.rows.at(-1).activeAfter.length >= 1);
});

test("graph-core 08: empty input produces no rows and the minimum lane count", () => {
    const result = api.assignLanes(api.topoSortCommits([]), new Set());
    assert.strictEqual(result.rows.length, 0);
    assert.strictEqual(result.laneCount, 1);
});

test("graph-core 09: a single root occupies one closed lane", () => {
    const result = api.assignLanes(api.topoSortCommits([commit("root")]), new Set());
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].lane, 0);
    assert.deepStrictEqual([...result.rows[0].activeAfter], []);
});

test("graph-core 10: uniqueParents preserves first occurrence order", () => {
    assert.strictEqual(Array.from(api.uniqueParents(["a", "b", "a", "c", "b"])).join(","), "a,b,c");
});

test("graph-core 11: duplicate parent IDs count as one topological edge", () => {
    const ordered = api.topoSortCommits([commit("parent", [], 1), commit("child", ["parent", "parent"], 2)]);
    assert.strictEqual(ordered.map((item) => item.sha).join(","), "child,parent");
});

test("graph-core 12: cyclic data terminates promptly", () => {
    const started = Date.now();
    api.topoSortCommits([commit("a", ["b"], 1), commit("b", ["a"], 2)]);
    assert.ok(Date.now() - started < 1000);
});

test("graph-core 13: cyclic data still emits every commit", () => {
    const ordered = api.topoSortCommits([commit("a", ["b"], 1), commit("b", ["a"], 2)]);
    assert.strictEqual(ordered.map((item) => item.sha).sort().join(","), "a,b");
});

test("graph-core 14: joined descending/ascending windows remain topological", () => {
    const dag = syntheticDag();
    const joined = [...dag.slice(6).reverse(), ...dag.slice(0, 6)];
    assertTopological(api.topoSortCommits(joined));
});

test("graph-core 15: window-joined and shuffled inputs produce the same order", () => {
    const dag = syntheticDag();
    const joined = [...dag.slice(6).reverse(), ...dag.slice(0, 6)];
    const a = api.topoSortCommits(joined).map((item) => item.sha).join(",");
    const b = api.topoSortCommits(shuffle(dag, 99)).map((item) => item.sha).join(",");
    assert.strictEqual(a, b);
});

const mainlineFixture = () => {
    const values = [commit("base", [], 0)];
    let parent = "base";
    for (let index = 1; index <= 5; index += 1) {
        values.push(commit(`bot${index}`, [], index * 2));
        values.push(commit(`main${index}`, [parent, `bot${index}`], index * 2 + 1));
        parent = `main${index}`;
    }
    for (let index = 6; index <= 8; index += 1) values.push(commit(`bot${index}`, [], index * 2 + 20));
    return values;
};

test("graph-core 16: the five-merge mainline stays in reserved lane zero", () => {
    const ordered = api.topoSortCommits(mainlineFixture());
    const spine = api.collectMainline(ordered, "main5");
    const rows = api.assignLanes(ordered, spine).rows;
    for (const row of rows.filter((entry) => entry.sha.startsWith("main") || entry.sha === "base")) {
        assert.strictEqual(row.lane, 0, row.sha);
    }
});

test("graph-core 17: eight bot tips never consume reserved lane zero", () => {
    const ordered = api.topoSortCommits(mainlineFixture());
    const rows = api.assignLanes(ordered, api.collectMainline(ordered, "main5")).rows;
    for (const row of rows.filter((entry) => entry.sha.startsWith("bot"))) assert.notStrictEqual(row.lane, 0, row.sha);
});

test("graph-core 18: collectMainline follows only first parents", () => {
    const ordered = api.topoSortCommits(mainlineFixture());
    const spine = api.collectMainline(ordered, "main5");
    assert.ok(spine.has("main1") && spine.has("base"));
    assert.ok(!spine.has("bot1"));
});

test("graph-core 19: fallback merge keeps the longest-running lane", () => {
    const ordered = [commit("tip-long", ["step"], 5), commit("tip-short", ["join"], 4), commit("step", ["join"], 3), commit("join", [], 2)];
    const rows = api.assignLanes(ordered, new Set()).rows;
    const join = rows.find((row) => row.sha === "join");
    assert.strictEqual(join.lane, rows.find((row) => row.sha === "tip-long").lane);
});

test("graph-core 20: fallback collision creates one losing-lane merge", () => {
    const ordered = [commit("tip-long", ["step"], 5), commit("tip-short", ["join"], 4), commit("step", ["join"], 3), commit("join", [], 2)];
    const join = api.assignLanes(ordered, new Set()).rows.find((row) => row.sha === "join");
    assert.strictEqual(join.merges.length, 1);
});

const consecutiveMerges = () => [
    commit("m3", ["m2", "s3"], 9),
    commit("s3", ["r"], 8),
    commit("m2", ["m1", "s2"], 7),
    commit("s2", ["r"], 6),
    commit("m1", ["r", "s1"], 5),
    commit("s1", ["r"], 4),
    commit("r", [], 1),
];

test("graph-core 21: three consecutive merge commits remain on one lane", () => {
    const ordered = api.topoSortCommits(consecutiveMerges());
    const rows = api.assignLanes(ordered, api.collectMainline(ordered, "m3")).rows;
    assert.strictEqual(rows.filter((row) => /^m/.test(row.sha)).map((row) => row.lane).join(","), "0,0,0");
});

test("graph-core 22: each second parent ends by merging into a commit dot", () => {
    const ordered = api.topoSortCommits(consecutiveMerges());
    const rows = api.assignLanes(ordered, api.collectMainline(ordered, "m3")).rows;
    const secondParentLanes = ["s1", "s2", "s3"].map((sha) => rows.find((entry) => entry.sha === sha).lane);
    const root = rows.find((entry) => entry.sha === "r");
    assert.deepStrictEqual([...root.merges].sort((a, b) => a - b), secondParentLanes.sort((a, b) => a - b));
});

test("graph-core 23: a short-lived branch spans out and back without breaking continuity", () => {
    const rows = api.assignLanes(api.topoSortCommits(consecutiveMerges()), new Set()).rows;
    assertLaneContinuity(rows);
});

test("graph-core 24: reachability follows parents and excludes disconnected commits", () => {
    const values = [commit("tip", ["root"], 2), commit("root", [], 1), commit("orphan", [], 3)];
    assert.strictEqual([...api.collectReachable(values, ["tip"])].sort().join(","), "root,tip");
});

test("graph-core 25: reachability ignores missing and repeated roots", () => {
    const values = [commit("tip", ["root"], 2), commit("root", [], 1)];
    assert.strictEqual([...api.collectReachable(values, ["missing", "tip", "tip"])].sort().join(","), "root,tip");
});

test("graph-core 26: date formatting is stable and invalid input is blank", () => {
    assert.match(api.formatDateTime("2026-01-02T03:04:00Z"), /^2026-01-02 \d{2}:04$/);
    assert.strictEqual(api.formatDateTime("not-a-date"), "");
    dom.window.close();
});
