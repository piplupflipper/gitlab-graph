"use strict";

const tests = [];

const test = (name, run) => {
    tests.push({ name, run });
};

module.exports = { test, tests };
