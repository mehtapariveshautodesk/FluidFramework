/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

"use strict";

const packageDir = `${__dirname}/../..`;
const getFluidTestMochaConfig = require("@fluid-internal/mocha-test-setup/mocharc-common.js");
const config = getFluidTestMochaConfig(packageDir);
module.exports = config;
