"use strict";

const assert = require("node:assert");
const { test } = require("./framework");
const { commit, loadCore, shuffle } = require("./helpers");

const { api, dom, window } = loadCore();

const numbers = (path) => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const keySet = (values) => [...new Set(values.map((value) => Number(value).toFixed(6)))].sort();

const topXs = (row) => {
    const values = row.render.verticals.filter((line) => line.y1 === 0).map((line) => line.x);
    for (const curve of row.render.curves) {
        const points = numbers(curve.d);
        if (points[1] === 0) values.push(points[0]);
    }
    return keySet(values);
};

const bottomXs = (row) => {
    const values = row.render.verticals.filter((line) => line.y2 === api.ROW_HEIGHT).map((line) => line.x);
    for (const curve of row.render.curves) {
        const points = numbers(curve.d);
        if (points[7] === api.ROW_HEIGHT) values.push(points[6]);
    }
    return keySet(values);
};

const assertC1 = (rows) => {
    for (let index = 0; index + 1 < rows.length; index += 1) {
        const uppers = rows[index].render.curves.filter((curve) => {
            const point = numbers(curve.d);
            return point[1] === api.HALF_ROW && point[7] === api.ROW_HEIGHT;
        });
        const lowers = rows[index + 1].render.curves.filter((curve) => {
            const point = numbers(curve.d);
            return point[1] === 0 && point[7] === api.HALF_ROW;
        });
        for (const upper of uppers) {
            const a = numbers(upper.d);
            const lower = lowers.find((candidate) => {
                const b = numbers(candidate.d);
                return candidate.color === upper.color && Math.abs(a[6] - b[0]) < 1e-9;
            });
            assert.ok(lower, `missing lower half after row ${index}`);
            const b = numbers(lower.d);
            assert.ok(Math.abs(a[6] - a[4] - (b[2] - b[0])) < 1e-9, `x tangent at ${index}`);
            assert.ok(Math.abs(a[7] - a[5] - (b[3] - b[1])) < 1e-9, `y tangent at ${index}`);
        }
    }
};

const graph = (values, tip = "") => {
    const ordered = api.topoSortCommits(values);
    const result = api.assignLanes(ordered, api.collectMainline(ordered, tip));
    api.state.laneCount = result.laneCount;
    api.buildGraphSegments(result.rows);
    return { ordered, ...result };
};

const assertGraphInvariants = (result) => {
    assert.strictEqual(result.rows.length, result.ordered.length, "one row per commit");
    const holder = window.document.createElement("div");
    for (const row of result.rows) holder.appendChild(api.buildRowGraph(row));
    assert.strictEqual(holder.querySelectorAll("circle.glg-dot").length, result.ordered.length, "one dot per commit");
    for (let index = 1; index < result.rows.length; index += 1) {
        assert.deepStrictEqual(topXs(result.rows[index]), bottomXs(result.rows[index - 1]), `SVG boundary ${index - 1}/${index}`);
    }
    assertC1(result.rows);
};

const octopus = (parentCount) => {
    const roots = Array.from({ length: parentCount }, (_, index) => commit(`p${index}`, ["root"], 10 - index));
    return [commit("merge", roots.map((item) => item.sha), 20), ...roots, commit("root", [], 1)];
};

test("patterns 01: three-parent octopus has two distinct branch transitions", () => {
    const result = graph(octopus(3), "merge");
    const merge = result.rows.find((row) => row.sha === "merge");
    assert.strictEqual(new Set(merge.branches).size, 2);
    assertGraphInvariants(result);
});

test("patterns 02: four-parent octopus has three distinct branch transitions", () => {
    const result = graph(octopus(4), "merge");
    const merge = result.rows.find((row) => row.sha === "merge");
    assert.strictEqual(new Set(merge.branches).size, 3);
    assertGraphInvariants(result);
});

test("patterns 03: duplicate parents do not create duplicate curves", () => {
    const result = graph([commit("child", ["root", "root"], 2), commit("root", [], 1)]);
    assert.strictEqual(result.rows[0].branches.length, 0);
    assert.strictEqual(result.rows.flatMap((row) => row.render.curves).length, 0);
    assertGraphInvariants(result);
});

test("patterns 04: disconnected components are all emitted before ref filtering", () => {
    const values = [commit("a1", ["a0"], 4), commit("a0", [], 1), commit("b1", ["b0"], 3), commit("b0", [], 2)];
    const result = graph(values);
    assert.strictEqual(result.rows.length, 4);
    assertGraphInvariants(result);
});

test("patterns 05: refs retain only their reachable disconnected components", () => {
    const values = [commit("a1", ["a0"], 4), commit("a0", [], 1), commit("b1", ["b0"], 3), commit("b0", [], 2)];
    assert.strictEqual([...api.collectReachable(values, ["a1"])].sort().join(","), "a0,a1");
    assert.strictEqual(api.collectReachable(values, []).size, 0);
});

const crissCross = () => [
    commit("left2", ["left1", "right1"], 8),
    commit("right2", ["right1", "left1"], 7),
    commit("left1", ["left0", "right0"], 6),
    commit("right1", ["right0", "left0"], 5),
    commit("left0", ["base"], 4),
    commit("right0", ["base"], 3),
    commit("base", [], 1),
];

test("patterns 06: two-round criss-cross merge stays topological and connected", () => {
    const result = graph(crissCross());
    const positions = new Map(result.ordered.map((item, index) => [item.sha, index]));
    for (const item of result.ordered) {
        for (const parent of api.uniqueParents(item.parents)) assert.ok(positions.get(item.sha) < positions.get(parent));
    }
    assertGraphInvariants(result);
});

test("patterns 07: branch and immediate merge completes a one-row out-and-back span", () => {
    const values = [
        commit("merge", ["main", "side"], 5),
        commit("side", ["fork"], 4),
        commit("main", ["fork"], 3),
        commit("fork", ["root"], 2),
        commit("root", [], 1),
    ];
    const result = graph(values, "merge");
    assert.ok(result.rows.some((row) => row.branches.length === 1));
    assert.ok(result.rows.some((row) => row.merges.length === 1));
    assertGraphInvariants(result);
});

test("patterns 08: inverted parent date and split windows still sort child first", () => {
    const child = commit("child", ["parent"], 1);
    const parent = commit("parent", ["root"], 20);
    const values = [parent, commit("root", [], 0), child];
    const result = graph(shuffle(values, 81));
    assert.strictEqual(result.ordered.map((item) => item.sha).join(","), "child,parent,root");
    assertGraphInvariants(result);
});

test("patterns 09: merge with only one loaded parent keeps the missing-parent lane open", () => {
    const result = graph([commit("merge", ["inside", "outside"], 3), commit("inside", [], 1)]);
    assert.ok(result.rows.at(-1).activeAfter.length > 0);
    assertGraphInvariants(result);
});

const topologyViolations = (ordered) => {
    const positions = new Map(ordered.map((item, index) => [item.sha, index]));
    const failures = [];
    for (const item of ordered) {
        for (const parent of api.uniqueParents(item.parents)) {
            if (positions.has(parent) && positions.get(item.sha) >= positions.get(parent)) failures.push(`${item.sha}->${parent}`);
        }
    }
    return failures;
};

test("patterns 10: self-parent input terminates, emits all data, and is diagnosable", () => {
    const values = [commit("self", ["self"], 2), commit("root", [], 1)];
    const result = graph(values);
    assert.strictEqual(result.rows.length, values.length);
    assert.deepStrictEqual(topologyViolations(result.ordered), ["self->self"]);
});

test("patterns 11: cyclic input terminates, emits all data, and is diagnosable", () => {
    const values = [commit("a", ["b"], 3), commit("b", ["c"], 2), commit("c", ["a"], 1)];
    const result = graph(values);
    assert.strictEqual(result.rows.length, values.length);
    assert.ok(topologyViolations(result.ordered).length > 0);
});

test("patterns 12: transitions crossing lane 17 clipping keep split coordinates aligned", () => {
    const tips = Array.from({ length: 20 }, (_, index) => commit(`tip${String(index).padStart(2, "0")}`, ["root"], 100 - index));
    const result = graph([...tips, commit("root", [], 1)]);
    assert.ok(result.laneCount >= 17);
    assert.strictEqual(api.graphWidth(), 240);
    const maxX = api.laneX(api.MAX_VISIBLE_LANES - 1);
    for (const row of result.rows) {
        for (const lane of row.render.detailLanes) assert.ok(lane.x <= maxX);
    }
    assertGraphInvariants(result);
});

test("patterns 13: all fixed history fixtures satisfy SVG continuity, C1, and dot-count invariants", () => {
    for (const values of [octopus(3), octopus(4), crissCross(), syntheticRoots()]) assertGraphInvariants(graph(values));
});

function syntheticRoots() {
    return [commit("a", ["root"], 4), commit("b", ["root"], 3), commit("orphan", [], 2), commit("root", [], 1)];
}

const randomDag = (seed, size = 35) => {
    let value = seed >>> 0;
    const random = () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 0x100000000;
    };
    const values = [];
    for (let index = 0; index < size; index += 1) {
        const candidates = Array.from({ length: index }, (_, parent) => parent).filter(() => random() < 0.16);
        const parents = shuffle(candidates, seed + index)
            .slice(0, 4)
            .map((parent) => `n${parent}`);
        if (index > 0 && parents.length === 0 && random() < 0.8) parents.push(`n${Math.floor(random() * index)}`);
        values.push(commit(`n${index}`, parents, index + Math.floor(random() * 9)));
    }
    return shuffle(values, seed ^ 0x9e3779b9);
};

for (let seed = 1; seed <= 20; seed += 1) {
    test(`patterns random DAG seed ${String(seed).padStart(2, "0")}: all rendering invariants`, () => {
        const result = graph(randomDag(seed));
        const positions = new Map(result.ordered.map((item, index) => [item.sha, index]));
        for (const item of result.ordered) {
            for (const parent of api.uniqueParents(item.parents)) assert.ok(positions.get(item.sha) < positions.get(parent));
        }
        assertGraphInvariants(result);
        if (seed === 20) dom.window.close();
    });
}
