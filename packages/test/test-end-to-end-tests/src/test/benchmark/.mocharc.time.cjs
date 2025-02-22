/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * Mocha configuration file for runtime profiling tests
 */
const getFluidTestMochaConfig = require("@fluid-private/test-version-utils/mocharc-common.cjs");
const packageDir = `${__dirname}/../../..`;

const config = getFluidTestMochaConfig(packageDir);
const newConfig = {
	"extends": "../.mocharc.cjs",
	"exit": true,
	"fgrep": ["@Benchmark", "@ExecutionTime"],
	"node-option": ["expose-gc", "gc-global", "unhandled-rejections=strict"], // without leading "--"
	"recursive": true,
	"reporter": "@fluid-tools/benchmark/dist/MochaReporter.js",
	"reporterOptions": ["reportDir=.timeTestsOutput/"],
	"require": [...config.require, "node_modules/@fluid-internal/mocha-test-setup"],
	"spec": [
		"lib/test/benchmark/**/*.time.spec.*js",
		"lib/test/benchmark/**/*.all.spec.*js",
		"--perfMode",
	],
	"timeout": "360000", // depending on the test and the size of the E2E document, the timeout might not be enough. To address it, let's first try to decrease the number of iterations (minSampleCount).
};
module.exports = newConfig;
