"use strict";

const path = require("node:path");
const { tests } = require("./framework");

for (const file of ["graph-core.test.js", "dom-smoke.test.js", "patterns.test.js"]) {
    require(path.join(__dirname, file));
}

const run = async () => {
    let passed = 0;
    for (const entry of tests) {
        try {
            await entry.run();
            passed += 1;
            process.stdout.write(`ok ${passed} - ${entry.name}\n`);
        } catch (error) {
            process.stderr.write(`not ok ${passed + 1} - ${entry.name}\n`);
            throw error;
        }
    }
    process.stdout.write(`\n${passed} tests, ALL PASSED\n`);
};

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
